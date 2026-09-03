import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { askStream } from "../agent/claude.js";
import { friday } from "../agent/prompt.js";
import { config } from "../config.js";

const body = z.object({ prompt: z.string().trim().min(1).max(8000) });

export const ask = new Hono().post("/ask", async (c) => {
  const parsed = body.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "prompt 不能为空" }, 400);

  return streamSSE(c, async (stream) => {
    const ac = new AbortController();
    stream.onAbort(() => ac.abort());
    const events = askStream(parsed.data.prompt, {
      systemPrompt: friday(),
      cwd: config.dataDir,
      signal: ac.signal,
    });
    try {
      for await (const ev of events) {
        await stream.writeSSE({ data: JSON.stringify(ev) });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await stream.writeSSE({ data: JSON.stringify({ type: "error", message }) });
      await stream.writeSSE({ data: JSON.stringify({ type: "done" }) });
    }
  });
});
