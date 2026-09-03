import { randomUUID } from "node:crypto";
import { db } from "./db.js";

export function startSession(kind: "ask" | "today", prompt: string): string {
  const id = randomUUID();
  db()
    .prepare("INSERT INTO sessions (id, kind, prompt, started_at) VALUES (?, ?, ?, ?)")
    .run(id, kind, prompt, new Date().toISOString());
  return id;
}

export function finishSession(id: string, response: string): void {
  db().prepare("UPDATE sessions SET response = ?, finished_at = ? WHERE id = ?").run(response, new Date().toISOString(), id);
}
