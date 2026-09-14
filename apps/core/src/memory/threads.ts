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
  anchor_ts: string | null;
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

function openCandidate(item: InboxItem): Row | undefined {
  const key = threadKey(item);
  return db()
    .prepare("SELECT * FROM threads WHERE status = 'open' AND kind = ? AND user_id = ? AND (kind = 'dm' OR channel_id = ?) ORDER BY last_ts DESC LIMIT 1")
    .get(key.kind, key.userId, item.channelId) as unknown as Row | undefined;
}

/** 距接续锚点多久。锚点缺省回落到 last_ts（老库迁移前写的行）。 */
const gapFrom = (row: Row, item: InboxItem) => Number(item.ts) * 1000 - Number(row.anchor_ts ?? row.last_ts) * 1000;

/**
 * 把一条消息挂到线程上，返回线程 id。
 * 2 小时内同键的 open 线程直接接续；超出但还在 `graceMs` 内的交给 `sameTopic` 判断
 * （同一件事隔几小时再催一次很常见，纯按时间切会拆成两条待办）。
 */
export function attachToThread(
  item: InboxItem,
  now = Date.now(),
  opts: { graceMs?: number; sameTopic?: (candidateId: string) => boolean } = {},
): string {
  const d = db();
  const candidate = openCandidate(item);
  const nowIso = new Date(now).toISOString();
  const gap = candidate ? gapFrom(candidate, item) : Infinity;
  const withinGap = Math.abs(gap) <= THREAD_GAP_MS;
  // 只对「新消息晚于线程」的情况做语义判断：补历史消息不该反过来把旧线程拉长
  const inGrace = gap > THREAD_GAP_MS && gap <= (opts.graceMs ?? 0);
  const merged = Boolean(candidate) && !withinGap && inGrace && Boolean(opts.sameTopic?.(candidate!.id));
  let id: string;
  if (candidate && (withinGap || merged)) {
    id = candidate.id;
    const first = Math.min(Number(candidate.first_ts), Number(item.ts));
    const last = Math.max(Number(candidate.last_ts), Number(item.ts));
    // 语义合并不推进锚点，否则下一条无关消息会因为「离得近」被顺势吸进来
    const anchor = merged ? (candidate.anchor_ts ?? candidate.last_ts) : String(last);
    d.prepare("UPDATE threads SET first_ts = ?, last_ts = ?, anchor_ts = ?, updated_at = ? WHERE id = ?").run(String(first), String(last), anchor, nowIso, id);
  } else {
    id = randomUUID();
    d.prepare(
      "INSERT INTO threads (id, kind, user_id, user_name, channel_id, channel_name, status, first_ts, last_ts, anchor_ts, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)",
    ).run(id, item.kind, item.userId, item.userName, item.channelId, item.channelName, item.ts, item.ts, item.ts, nowIso);
  }
  d.prepare("UPDATE inbox SET thread_id = ? WHERE id = ?").run(id, item.id);
  return id;
}

/**
 * 这条消息落在「超出 2 小时但还在宽限期内」的灰区时，返回那个候选线程。
 * 调用方拿它去做语义判断，再把结果交回 attachToThread。不在灰区就返回 undefined。
 */
export function graceCandidate(item: InboxItem, graceMs: number): Thread | undefined {
  const row = openCandidate(item);
  if (!row) return undefined;
  const gap = gapFrom(row, item);
  if (gap <= THREAD_GAP_MS || gap > graceMs) return undefined;
  return toThread(row, threadItems(row.id));
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
