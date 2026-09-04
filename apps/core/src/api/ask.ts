import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { askStream } from "../agent/claude.js";
import { friday } from "../agent/prompt.js";
import { config } from "../config.js";
import { addMessage, claudeSessionId, conversationExists, setClaudeSessionId } from "../memory/conversations.js";
import { finishSession, startSession } from "../memory/sessions.js";

const body = z.object({
  prompt: z.string().trim().min(1).max(8000),
  conversationId: z.string().uuid().optional(),
});

export const ask = new Hono().post("/ask", async (c) => {
  const parsed = body.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "prompt 不能为空" }, 400);
  const { prompt, conversationId } = parsed.data;
  const conv = conversationId && conversationExists(conversationId) ? conversationId : undefined;

  return streamSSE(c, async (stream) => {
    const ac = new AbortController();
    stream.onAbort(() => ac.abort());
    const sessionId = startSession("ask", prompt);
    if (conv) addMessage(conv, { role: "user", kind: "ask", content: prompt });
    let answer = "";
    let error: string | undefined;
    const events = askStream(prompt, {
      systemPrompt: friday(),
      cwd: config.dataDir,
      signal: ac.signal,
      ...(conv ? { resume: claudeSessionId(conv) } : {}),
    });
    try {
      for await (const ev of events) {
        if (ev.type === "delta") answer += ev.text;
        if (ev.type === "error") error = ev.message;
        if (ev.type === "session" && conv) setClaudeSessionId(conv, ev.sessionId);
        await stream.writeSSE({ data: JSON.stringify(ev) });
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      await stream.writeSSE({ data: JSON.stringify({ type: "error", message: error }) });
      await stream.writeSSE({ data: JSON.stringify({ type: "done" }) });
    } finally {
      finishSession(sessionId, answer);
      if (conv) {
        if (answer) addMessage(conv, { role: "assistant", kind: "ask", content: answer });
        if (error) addMessage(conv, { role: "assistant", kind: "error", content: error });
      }
    }
  });
});
