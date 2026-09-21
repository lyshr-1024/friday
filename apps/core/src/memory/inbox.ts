import type { InboxItem } from "@friday/shared";
import { db } from "./db.js";

interface Row {
  id: string;
  kind: "dm" | "mention";
  channel_id: string;
  channel_name: string;
  user_id: string;
  user_name: string;
  text: string;
  permalink: string;
  ts: string;
  thread_ts: string | null;
  received_at: string;
  prior: string | null;
  done: number;
}

const TEAM_KEY = "slack:team";

export function setSlackTeam(teamId: string): void {
  setCursor(TEAM_KEY, teamId);
}

const appLink = (r: Row): string | undefined => {
  const team = getCursor(TEAM_KEY);
  return team ? `slack://channel?team=${team}&id=${r.channel_id}&message=${r.ts}` : undefined;
};

const toItem = (r: Row): InboxItem => ({
  id: r.id,
  kind: r.kind,
  channelId: r.channel_id,
  channelName: r.channel_name,
  userId: r.user_id,
  userName: r.user_name,
  text: r.text,
  permalink: r.permalink,
  ...(appLink(r) ? { appLink: appLink(r)! } : {}),
  ...(r.thread_ts ? { threadTs: r.thread_ts } : {}),
  ts: r.ts,
  receivedAt: r.received_at,
  done: r.done === 1,
});

export type NewInboxItem = Omit<InboxItem, "receivedAt" | "done">;

/** 插入新消息，已存在的跳过；返回真正新增的条目。 */
export function addInboxItems(items: NewInboxItem[]): InboxItem[] {
  const d = db();
  const insert = d.prepare(
    "INSERT OR IGNORE INTO inbox (id, kind, channel_id, channel_name, user_id, user_name, text, permalink, ts, thread_ts, received_at, done) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
  );
  const added: InboxItem[] = [];
  const now = new Date().toISOString();
  for (const it of items) {
    const res = insert.run(it.id, it.kind, it.channelId, it.channelName, it.userId, it.userName, it.text, it.permalink, it.ts, it.threadTs ?? null, now);
    if (res.changes > 0) added.push({ ...it, receivedAt: now, done: false });
  }
  return added;
}

export function listInbox(includeDone = false, limit = 50): InboxItem[] {
  const rows = db()
    .prepare(`SELECT * FROM inbox ${includeDone ? "" : "WHERE done = 0"} ORDER BY ts DESC LIMIT ?`)
    .all(limit) as unknown as Row[];
  return rows.map(toItem);
}

export function getInboxItem(id: string): InboxItem | undefined {
  const row = db().prepare("SELECT * FROM inbox WHERE id = ?").get(id) as unknown as Row | undefined;
  return row ? toItem(row) : undefined;
}

export function markInboxDone(id: string): boolean {
  return db().prepare("UPDATE inbox SET done = 1 WHERE id = ?").run(id).changes > 0;
}

/**
 * 补标：我早就在 Slack 里回过、Friday 这边还挂着的消息。
 * 入口拦截（connectors/slack.ts）是后加的，之前进来的那批得扫一遍。
 * `didReply` 查不出来时（接口报错）当作没回——宁可多留，不可误标掉真没处理的事。
 */
export async function sweepRepliedInbox(didReply: (item: InboxItem) => Promise<boolean>): Promise<number> {
  const open = listInbox(false, 1000);
  let n = 0;
  for (const item of open) {
    let replied = false;
    try {
      replied = await didReply(item);
    } catch {
      continue;
    }
    if (replied && markInboxDone(item.id)) n++;
  }
  return n;
}

export function getCursor(key: string): string | undefined {
  const row = db().prepare("SELECT cursor FROM sync_state WHERE source = ?").get(key) as { cursor: string | null } | undefined;
  return row?.cursor ?? undefined;
}

export function setCursor(key: string, cursor: string): void {
  db()
    .prepare("INSERT INTO sync_state (source, last_synced_at, cursor) VALUES (?, ?, ?) ON CONFLICT(source) DO UPDATE SET last_synced_at = excluded.last_synced_at, cursor = excluded.cursor")
    .run(key, new Date().toISOString(), cursor);
}

/** 同一人在同一频道、这条之前 48 小时内的消息，用来判断是不是在催同一件事 */
export function listInboxNear(item: Pick<InboxItem, "channelId" | "userId" | "ts">, hours = 48, limit = 20): InboxItem[] {
  const since = String(Number(item.ts) - hours * 3600);
  const rows = db()
    .prepare("SELECT * FROM inbox WHERE channel_id = ? AND user_id = ? AND ts < ? AND ts > ? ORDER BY ts DESC LIMIT ?")
    .all(item.channelId, item.userId, item.ts, since, limit) as unknown as Row[];
  return rows.map(toItem);
}
