import { existsSync } from "node:fs";
import { transcriptPath } from "../agent/runner.js";
import { config } from "../config.js";
import { claudeSessionId, conversationExists, createConversation } from "./conversations.js";
import { db } from "./db.js";
import { getCursor, setCursor } from "./inbox.js";

const MAX_USER_TURNS = 40;
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
