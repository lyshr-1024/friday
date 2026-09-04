import { Hono } from "hono";
import type { TodayResponse, TodoSource } from "@friday/shared";
import { askStream } from "../agent/claude.js";
import { todayBrief } from "../agent/prompt.js";
import { config } from "../config.js";
import { connectors } from "../connectors/index.js";
import { addMessage, conversationExists } from "../memory/conversations.js";
import { finishSession, startSession } from "../memory/sessions.js";
import { listOpenTodos, syncSourceTodos } from "../memory/todos.js";

export async function buildToday(): Promise<TodayResponse> {
  const sourceErrors: Partial<Record<TodoSource, string>> = {};
  await Promise.all(
    connectors.map(async (c) => {
      try {
        syncSourceTodos(c.source as Exclude<TodoSource, "local">, await c.fetchTodos());
      } catch (e) {
        sourceErrors[c.source] = e instanceof Error ? e.message : String(e);
      }
    }),
  );

  const todos = listOpenTodos();
  const { system, prompt } = todayBrief(todos, sourceErrors);
  const sessionId = startSession("today", prompt);
  let brief = "";
  for await (const ev of askStream(prompt, { systemPrompt: system, cwd: config.dataDir })) {
    if (ev.type === "delta") brief += ev.text;
    if (ev.type === "error") brief += `\n（简报生成失败：${ev.message}）`;
  }
  finishSession(sessionId, brief);
  return { generatedAt: new Date().toISOString(), brief: brief.trim(), todos, sourceErrors };
}

export const today = new Hono().get("/today", async (c) => {
  const conv = c.req.query("conversationId");
  if (conv && conversationExists(conv)) addMessage(conv, { role: "user", kind: "today", content: "今日简报" });
  const res = await buildToday();
  if (conv && conversationExists(conv)) addMessage(conv, { role: "assistant", kind: "today", content: res.brief, payload: res });
  return c.json(res);
});
