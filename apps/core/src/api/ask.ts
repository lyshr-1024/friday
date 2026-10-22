import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { AskEvent } from "../agent/claude.js";
import { boardBlock } from "../agent/needs.js";
import { friday } from "../agent/prompt.js";
import { cancelRun, isRunning, startRun, subscribe } from "../agent/runs.js";
import { subscribe as subscribeBus } from "../bus.js";
import { config } from "../config.js";
import { loadMemoryContext } from "../memory/context.js";
import { addMessage, claudeSessionId, conversationExists } from "../memory/conversations.js";
import { mainConversationId, mainResume } from "../memory/mainConversation.js";
import { userSettings } from "../settings.js";
import { existsSync } from "node:fs";
import { transcriptPath } from "../agent/runner.js";

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

interface Queued {
  id: string;
  prompt: string;
  attachments: string[];
}

const queues = new Map<string, Queued[]>();

/** 系统提示在开跑那一刻现取，排队期间任务板变了也是新的。 */
function askOptions(conv: string) {
  const prefs = userSettings();
  // 路由到很久前的会话时 transcript 可能已被清掉，这时不带 resume 新开 Claude 会话，Friday 自己的消息记录还在
  const session = claudeSessionId(conv);
  const resume = conv === mainConversationId() ? mainResume() : session && existsSync(transcriptPath(config.dataDir, session)) ? session : undefined;
  return {
    systemPrompt: friday(loadMemoryContext(), prefs.skills, boardBlock(conv)),
    cwd: config.dataDir,
    skills: prefs.skills,
    skillList: prefs.skillList,
    web: true,
    ...(resume ? { resume } : {}),
    ...(prefs.model ? { model: prefs.model } : {}),
  };
}

// 一轮结束（含出错、被中断）后接着跑队首；模块只加载一次，订阅一次
subscribeBus((ev) => {
  if (ev.type !== "conversation" || ev.running || isRunning(ev.id)) return;
  const next = queues.get(ev.id)?.shift();
  if (!next) return;
  if (!queues.get(ev.id)?.length) queues.delete(ev.id);
  try {
    startRun(ev.id, next.prompt, askOptions(ev.id), next.attachments);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.warn(`[ask] 排队的这句没能开跑：${reason}`);
    queues.set(ev.id, [next, ...(queues.get(ev.id) ?? [])]);
    try {
      addMessage(ev.id, { role: "assistant", kind: "error", content: `排队的这句没能开跑：${reason}` });
    } catch {}
  }
});

export const ask = new Hono()
  .post("/ask", async (c) => {
    const parsed = body.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "prompt 不能为空" }, 400);
    const { prompt } = parsed.data;
    const conv = parsed.data.conversationId && conversationExists(parsed.data.conversationId) ? parsed.data.conversationId : mainConversationId();

    if (isRunning(conv)) {
      const item = { id: randomUUID(), prompt, attachments: parsed.data.attachments ?? [] };
      queues.set(conv, [...(queues.get(conv) ?? []), item]);
      return c.json({ queued: { id: item.id, prompt } }, 202);
    }
    startRun(conv, prompt, askOptions(conv), parsed.data.attachments ?? []);
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
  })
  .get("/ask/queue", (c) => {
    const conv = c.req.query("conversationId") ?? "";
    return c.json((queues.get(conv) ?? []).map(({ id, prompt }) => ({ id, prompt })));
  })
  .delete("/ask/queue/:id", (c) => {
    const id = c.req.param("id");
    for (const [conv, list] of queues) {
      const i = list.findIndex((q) => q.id === id);
      if (i < 0) continue;
      list.splice(i, 1);
      if (!list.length) queues.delete(conv);
      return c.json({ ok: true });
    }
    return c.json({ error: "排队里没有这条" }, 404);
  });
