import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { AskEvent } from "../agent/claude.js";
import { friday } from "../agent/prompt.js";
import { cancelRun, isRunning, startRun, subscribe } from "../agent/runs.js";
import { config } from "../config.js";
import { loadMemoryContext } from "../memory/context.js";
import { existsSync } from "node:fs";
import { transcriptPath } from "../agent/runner.js";
import { claudeSessionId, conversationExists, createConversation } from "../memory/conversations.js";
import { userSettings } from "../settings.js";

const body = z.object({
  prompt: z.string().trim().min(1).max(8000),
  conversationId: z.string().uuid().optional(),
  attachments: z.array(z.string().uuid()).max(10).optional(),
});

/** 把某个会话的进行中任务以 SSE 推给客户端；客户端断开只取消订阅。 */
function streamRun(c: Parameters<typeof streamSSE>[0], conversationId: string) {
  return streamSSE(c, async (stream) => {
    await new Promise<void>((resolve) => {
      const unsubscribe = subscribe(conversationId, (ev: AskEvent) => {
        const written = stream.writeSSE({ data: JSON.stringify(ev) }).catch(() => {});
        // done 要等写完再收流，否则最后一帧会丢。
        if (ev.type === "done") void written.then(() => resolve());
      });
      if (!unsubscribe) {
        void stream.writeSSE({ data: JSON.stringify({ type: "done" }) });
        resolve();
        return;
      }
      stream.onAbort(() => {
        unsubscribe();
        resolve();
      });
    });
  });
}

export const ask = new Hono()
  .post("/ask", async (c) => {
    const parsed = body.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "prompt 不能为空" }, 400);
    const { prompt } = parsed.data;
    const conv = parsed.data.conversationId && conversationExists(parsed.data.conversationId) ? parsed.data.conversationId : createConversation().id;
    if (isRunning(conv)) return c.json({ error: "这个会话正在生成，先等它结束或按 Esc 中断" }, 409);

    const prefs = userSettings();
    // 路由到很久前的会话时 transcript 可能已被清掉，这时不带 resume 新开 Claude 会话，Friday 自己的消息记录还在
    const session = claudeSessionId(conv);
    const resume = session && existsSync(transcriptPath(config.dataDir, session)) ? session : undefined;
    startRun(
      conv,
      prompt,
      {
        systemPrompt: friday(loadMemoryContext(), prefs.skills),
        cwd: config.dataDir,
        skills: prefs.skills,
        ...(resume ? { resume } : {}),
        ...(prefs.model ? { model: prefs.model } : {}),
      },
      parsed.data.attachments ?? [],
    );
    c.header("x-conversation-id", conv);
    return streamRun(c, conv);
  })
  .get("/ask/stream", (c) => {
    const conv = c.req.query("conversationId");
    if (!conv || !isRunning(conv)) return c.json({ error: "没有进行中的生成" }, 404);
    return streamRun(c, conv);
  })
  .post("/ask/cancel", async (c) => {
    const { conversationId } = (await c.req.json().catch(() => ({}))) as { conversationId?: string };
    return conversationId && cancelRun(conversationId) ? c.json({ ok: true }) : c.json({ error: "没有进行中的生成" }, 404);
  });
