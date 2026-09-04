import { randomUUID } from "node:crypto";
import type { Conversation, Message, MessageKind } from "@friday/shared";
import { db } from "./db.js";

interface ConvRow {
  id: string;
  claude_session_id: string | null;
  created_at: string;
  updated_at: string;
}

interface MsgRow {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  kind: MessageKind;
  content: string;
  payload: string | null;
  created_at: string;
}

const now = () => new Date().toISOString();

function toMessage(r: MsgRow): Message {
  return {
    id: r.id,
    role: r.role,
    kind: r.kind,
    content: r.content,
    ...(r.payload ? { payload: JSON.parse(r.payload) as unknown } : {}),
    createdAt: r.created_at,
  };
}

export function createConversation(): Conversation {
  const id = randomUUID();
  const t = now();
  db().prepare("INSERT INTO conversations (id, created_at, updated_at) VALUES (?, ?, ?)").run(id, t, t);
  return { id, createdAt: t, updatedAt: t, messages: [] };
}

export function currentConversation(): Conversation {
  const row = db().prepare("SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 1").get() as unknown as ConvRow | undefined;
  if (!row) return createConversation();
  return { id: row.id, createdAt: row.created_at, updatedAt: row.updated_at, messages: listMessages(row.id) };
}

export function conversationExists(id: string): boolean {
  return Boolean(db().prepare("SELECT 1 FROM conversations WHERE id = ?").get(id));
}

export function claudeSessionId(conversationId: string): string | undefined {
  const row = db().prepare("SELECT claude_session_id FROM conversations WHERE id = ?").get(conversationId) as
    | { claude_session_id: string | null }
    | undefined;
  return row?.claude_session_id ?? undefined;
}

export function setClaudeSessionId(conversationId: string, sessionId: string): void {
  db().prepare("UPDATE conversations SET claude_session_id = ? WHERE id = ?").run(sessionId, conversationId);
}

export function listMessages(conversationId: string): Message[] {
  const rows = db().prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid").all(conversationId) as unknown as MsgRow[];
  return rows.map(toMessage);
}

export function addMessage(
  conversationId: string,
  input: { role: "user" | "assistant"; kind: MessageKind; content: string; payload?: unknown },
): Message {
  const row: MsgRow = {
    id: randomUUID(),
    conversation_id: conversationId,
    role: input.role,
    kind: input.kind,
    content: input.content,
    payload: input.payload === undefined ? null : JSON.stringify(input.payload),
    created_at: now(),
  };
  const d = db();
  d.prepare("INSERT INTO messages (id, conversation_id, role, kind, content, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    row.id, row.conversation_id, row.role, row.kind, row.content, row.payload, row.created_at,
  );
  d.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(row.created_at, conversationId);
  return toMessage(row);
}
