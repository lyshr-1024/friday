import type { InboxItem, Triage } from "@friday/shared";
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
  received_at: string;
  triage: string | null;
  done: number;
}

const toItem = (r: Row): InboxItem => ({
  id: r.id,
  kind: r.kind,
  channelId: r.channel_id,
  channelName: r.channel_name,
  userId: r.user_id,
  userName: r.user_name,
  text: r.text,
  permalink: r.permalink,
  ts: r.ts,
  receivedAt: r.received_at,
  ...(r.triage ? { triage: JSON.parse(r.triage) as Triage } : {}),
  done: r.done === 1,
});

export type NewInboxItem = Omit<InboxItem, "receivedAt" | "triage" | "done">;

/** 插入新消息，已存在的跳过；返回真正新增的条目。 */
export function addInboxItems(items: NewInboxItem[]): InboxItem[] {
  const d = db();
  const insert = d.prepare(
    "INSERT OR IGNORE INTO inbox (id, kind, channel_id, channel_name, user_id, user_name, text, permalink, ts, received_at, done) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
  );
  const added: InboxItem[] = [];
  const now = new Date().toISOString();
  for (const it of items) {
    const res = insert.run(it.id, it.kind, it.channelId, it.channelName, it.userId, it.userName, it.text, it.permalink, it.ts, now);
    if (res.changes > 0) added.push({ ...it, receivedAt: now, done: false });
  }
  return added;
}

export function setTriage(id: string, triage: Triage): void {
  db().prepare("UPDATE inbox SET triage = ? WHERE id = ?").run(JSON.stringify(triage), id);
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

export function getCursor(key: string): string | undefined {
  const row = db().prepare("SELECT cursor FROM sync_state WHERE source = ?").get(key) as { cursor: string | null } | undefined;
  return row?.cursor ?? undefined;
}

export function setCursor(key: string, cursor: string): void {
  db()
    .prepare("INSERT INTO sync_state (source, last_synced_at, cursor) VALUES (?, ?, ?) ON CONFLICT(source) DO UPDATE SET last_synced_at = excluded.last_synced_at, cursor = excluded.cursor")
    .run(key, new Date().toISOString(), cursor);
}
