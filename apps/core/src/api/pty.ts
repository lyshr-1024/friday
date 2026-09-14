import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { getSession, kill, listSessions, resize, subscribe, write } from "../agent/pty.js";
import { reopenClaude } from "../agent/runner.js";
import { clearAttention } from "../agent/bridge.js";

export const pty = new Hono()
  .get("/pty", (c) => c.json(listSessions()))
  .get("/pty/:id/stream", (c) => {
    const id = c.req.param("id");
    if (!getSession(id)) return c.json({ error: "没有这个终端" }, 404);
    return streamSSE(c, async (stream) => {
      await new Promise<void>((resolve) => {
        const unsubscribe = subscribe(id, (chunk) => {
          void stream.writeSSE({ data: JSON.stringify({ d: chunk }) }).catch(() => {});
        });
        if (!unsubscribe) return resolve();
        const ping = setInterval(() => void stream.writeSSE({ data: JSON.stringify({ ping: 1 }) }).catch(() => {}), 15_000);
        stream.onAbort(() => {
          unsubscribe();
          clearInterval(ping);
          resolve();
        });
      });
    });
  })
  .post("/pty/:id/input", async (c) => {
    const parsed = z.object({ data: z.string().max(65536) }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "data 必填" }, 400);
    if (!write(c.req.param("id"), parsed.data.data)) return c.json({ error: "终端不存在或已退出" }, 404);
    // 用户在终端里敲了回车 = 给它新指示，上一轮"等你看"的标记清掉
    if (parsed.data.data.includes("\r")) clearAttention(c.req.param("id"));
    return c.json({ ok: true });
  })
  .post("/pty/:id/resize", async (c) => {
    const parsed = z.object({ cols: z.number().int(), rows: z.number().int() }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "cols/rows 必填" }, 400);
    return resize(c.req.param("id"), parsed.data.cols, parsed.data.rows) ? c.json({ ok: true }) : c.json({ error: "终端不存在或已退出" }, 404);
  })
  .post("/pty/:id/reopen", async (c) => {
    const r = await reopenClaude(c.req.param("id"));
    return r === "no-job" ? c.json({ error: "找不到这个任务的记录" }, 404) : c.json({ status: r });
  })
  .post("/pty/:id/kill", (c) => (kill(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "终端不存在" }, 404)));
