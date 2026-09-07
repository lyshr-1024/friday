import { randomUUID } from "node:crypto";
import type { InboxItem, Thread, ThreadBrief, ThreadStatus } from "@friday/shared";
import { db } from "./db.js";
import { listInbox } from "./inbox.js";

/** 同一个人 2 小时内的消息算一条线程。 */
export const THREAD_GAP_MS = 2 * 3600 * 1000;

interface Row {
  id: string;
  kind: "dm" | "mention";
  user_id: string;
  user_name: string;
  channel_id: string;
  channel_name: string;
  project: string | null;
  status: ThreadStatus;
  first_ts: string;
  last_ts: string;
  updated_at: string;
  brief: string | null;
  auto_done: string | null;
}

const toThread = (r: Row, items: InboxItem[] = []): Thread => ({
  id: r.id,
  kind: r.kind,
  userId: r.user_id,
  userName: r.user_name,
  channelId: r.channel_id,
  channelName: r.channel_name,
  ...(r.project ? { project: r.project } : {}),
  status: r.status,
  firstTs: r.first_ts,
  lastTs: r.last_ts,
  updatedAt: r.updated_at,
  ...(r.brief ? { brief: JSON.parse(r.brief) as ThreadBrief } : {}),
  items,
});

/** 线程归属键：私聊按人，频道 @ 按「频道 + 人」。 */
export function threadKey(item: Pick<InboxItem, "kind" | "userId" | "channelId">): { kind: "dm" | "mention"; userId: string; channelId: string } {
  return { kind: item.kind, userId: item.userId, channelId: item.kind === "dm" ? "" : item.channelId };
}

/** 把一条消息挂到线程上（接续 2 小时内同键的 open 线程，否则新建），返回线程 id。 */
export function attachToThread(item: InboxItem, now = Date.now()): string {
  const d = db();
  const key = threadKey(item);
  const ts = Number(item.ts) * 1000;
  const candidate = d
    .prepare("SELECT * FROM threads WHERE status = 'open' AND kind = ? AND user_id = ? AND (kind = 'dm' OR channel_id = ?) ORDER BY last_ts DESC LIMIT 1")
    .get(key.kind, key.userId, item.channelId) as unknown as Row | undefined;
  const nowIso = new Date(now).toISOString();
  let id: string;
  if (candidate && ts - Number(candidate.last_ts) * 1000 <= THREAD_GAP_MS && ts - Number(candidate.last_ts) * 1000 >= -THREAD_GAP_MS) {
    id = candidate.id;
    const first = Math.min(Number(candidate.first_ts), Number(item.ts));
    const last = Math.max(Number(candidate.last_ts), Number(item.ts));
    d.prepare("UPDATE threads SET first_ts = ?, last_ts = ?, updated_at = ? WHERE id = ?").run(String(first), String(last), nowIso, id);
  } else {
    id = randomUUID();
    d.prepare(
      "INSERT INTO threads (id, kind, user_id, user_name, channel_id, channel_name, status, first_ts, last_ts, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)",
    ).run(id, item.kind, item.userId, item.userName, item.kind === "dm" ? item.channelId : item.channelId, item.channelName, item.ts, item.ts, nowIso);
  }
  d.prepare("UPDATE inbox SET thread_id = ? WHERE id = ?").run(id, item.id);
  return id;
}

export function threadItems(threadId: string): InboxItem[] {
  const ids = (db().prepare("SELECT id FROM inbox WHERE thread_id = ? ORDER BY ts").all(threadId) as Array<{ id: string }>).map((r) => r.id);
  const all = new Map(listInbox(true, 1000).map((i) => [i.id, i]));
  return ids.map((id) => all.get(id)).filter((i): i is InboxItem => Boolean(i));
}

export function getThread(id: string): Thread | undefined {
  const row = db().prepare("SELECT * FROM threads WHERE id = ?").get(id) as unknown as Row | undefined;
  return row ? toThread(row, threadItems(id)) : undefined;
}

export function listThreads(status: ThreadStatus | "all" = "open", limit = 50): Thread[] {
  const rows = (
    status === "all"
      ? db().prepare("SELECT * FROM threads ORDER BY last_ts DESC LIMIT ?").all(limit)
      : db().prepare("SELECT * FROM threads WHERE status = ? ORDER BY last_ts DESC LIMIT ?").all(status, limit)
  ) as unknown as Row[];
  return rows.map((r) => toThread(r, threadItems(r.id)));
}

/** 同一个人之前已结束的线程的情境，用来给新线程接上下文。 */
export function previousBriefs(userId: string, excludeId: string, limit = 3): string[] {
  const rows = db()
    .prepare("SELECT brief FROM threads WHERE user_id = ? AND id != ? AND brief IS NOT NULL ORDER BY last_ts DESC LIMIT ?")
    .all(userId, excludeId, limit) as Array<{ brief: string }>;
  return rows.map((r) => (JSON.parse(r.brief) as ThreadBrief).situation).filter(Boolean);
}

export function setThreadBrief(id: string, brief: ThreadBrief, project?: string): void {
  db().prepare("UPDATE threads SET brief = ?, project = COALESCE(?, project), updated_at = ? WHERE id = ?").run(JSON.stringify(brief), project ?? null, new Date().toISOString(), id);
}

export function setThreadStatus(id: string, status: ThreadStatus): boolean {
  const r = db().prepare("UPDATE threads SET status = ?, updated_at = ? WHERE id = ?").run(status, new Date().toISOString(), id);
  if (r.changes && status !== "open") db().prepare("UPDATE inbox SET done = 1 WHERE thread_id = ?").run(id);
  return r.changes > 0;
}

/** 可逆自动写只做一次：记录已做过的动作类型。 */
export function markAutoDone(id: string, action: string): boolean {
  const row = db().prepare("SELECT auto_done FROM threads WHERE id = ?").get(id) as { auto_done: string | null } | undefined;
  const done = new Set((row?.auto_done ?? "").split(",").filter(Boolean));
  if (done.has(action)) return false;
  done.add(action);
  db().prepare("UPDATE threads SET auto_done = ? WHERE id = ?").run([...done].join(","), id);
  return true;
}
