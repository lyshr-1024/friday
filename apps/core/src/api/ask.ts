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
import { contextFor } from "../agent/bridge.js";
import { TERMINAL_STATE_LABEL, terminalState } from "../agent/terminal.js";
import { getJob } from "../memory/jobs.js";
import { findTaskBySource } from "../memory/tasks.js";
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

/** 会话绑着任务时，把卡片此刻的内容整理成一段给系统提示 */
export function taskBlock(conversationId: string): string | undefined {
  const task = findTaskBySource((s) => s.conversationId === conversationId);
  if (!task) return undefined;
  const job = task.source.jobId ? getJob(task.source.jobId) : undefined;
  return [
    contextFor(task, job),
    job ? `终端：${job.status === "running" ? TERMINAL_STATE_LABEL[terminalState(job.id)] : `进程已退出（退出码 ${job.exitCode ?? "?"}）`}${job.lastMessage ? `；它最后说：${job.lastMessage.slice(0, 200)}` : ""}` : "",
    task.attention === "review" ? "终端这一轮已经做完等用户看；任务是否完成由用户说，用户没说别当它完成。" : task.attention === "blocked" ? "终端报告卡住了，需要用户介入。" : task.attention === "question" ? `终端正停在一个交互式提问上等用户回答（${task.progress ?? ""}）。用户说选哪个 / 怎么回，就用 terminal_say 把选项编号或文字敲进去，不要自己替用户选。` : "",
    task.report ? `最近一次交付：${task.report.summary}（测试：${task.report.testResult}）${task.report.verify.length ? `；验证点用户已确认 ${(task.report.checked ?? []).filter(Boolean).length}/${task.report.verify.length}${(task.report.checked ?? []).filter(Boolean).length === task.report.verify.length ? "，全部通过" : ""}` : ""}` : "",
  ]
    .filter(Boolean)
    .join("\n");
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
        systemPrompt: friday(loadMemoryContext(), prefs.skills, taskBlock(conv)),
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
