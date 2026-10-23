import { existsSync } from "node:fs";
import { transcriptPath } from "../agent/runner.js";
import { config } from "../config.js";
import { claudeSessionId, conversationExists, createConversation, listMessages } from "./conversations.js";
import { db } from "./db.js";
import { getCursor, setCursor } from "./inbox.js";

const MAX_USER_TURNS = 40;
const RECENT_MESSAGES = 10;
const RECENT_EACH = 400;
const RECENT_TOTAL = 2000;
const shanghaiDay = (d: Date) => d.toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });

export function mainConversationId(): string {
  const id = getCursor("main:conversation");
  if (id && conversationExists(id)) return id;
  const fresh = createConversation().id;
  setCursor("main:conversation", fresh);
  return fresh;
}

export function mainResume(now = new Date()): string | undefined {
  const id = mainConversationId();
  const since = getCursor("main:session:since");
  const rotate = () => {
    setCursor("main:session:since", now.toISOString());
    return undefined;
  };
  if (since) {
    if (shanghaiDay(new Date(since)) !== shanghaiDay(now)) return rotate();
    const n = (db().prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND role = 'user' AND created_at > ?").get(id, since) as { n: number }).n;
    if (n >= MAX_USER_TURNS) return rotate();
  } else {
    setCursor("main:session:since", now.toISOString());
  }
  const session = claudeSessionId(id);
  return session && existsSync(transcriptPath(config.dataDir, session)) ? session : undefined;
}

/** 新开的 Claude 会话看不到之前的对话：把最近几条原文带上，「删掉」「是的」这种接上一句的话才接得上 */
export function recentDialogue(id: string): string {
  const lines = listMessages(id)
    .filter((m) => m.kind !== "error" && m.content.trim())
    .slice(-RECENT_MESSAGES)
    .map((m) => {
      const who = m.role === "user" ? "用户" : m.kind === "notice" ? "Friday（主动）" : "Friday";
      const body = m.content.trim();
      return `${who}：${body.length > RECENT_EACH ? `${body.slice(0, RECENT_EACH)}…` : body}`;
    });
  while (lines.length > 1 && lines.join("\n").length > RECENT_TOTAL) lines.shift();
  return lines.join("\n");
}
