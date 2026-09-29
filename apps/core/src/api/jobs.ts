import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { z } from "zod";
import { onJobExit } from "../agent/pipeline.js";
import { closeJobTerminal, sweepClosedTerminals } from "../agent/terminal.js";
import { flushQueued, prepareFailed, resumeInSession, worktreeReady } from "../agent/sessions.js";
import { jobActivity } from "../agent/transcript.js";
import { describeQuestion, terminalAnswered, terminalAsking, turnFinished, clearAttention } from "../agent/bridge.js";
import { addMessage, conversationExists } from "../memory/conversations.js";
import { findTaskBySource } from "../memory/tasks.js";
import { getTermSession, markInput, markStop } from "../memory/termSessions.js";
import { finishJob, getJob, jobLogPath, listJobs, setJobMessage, setJobSession } from "../memory/jobs.js";
import { updateTermSession } from "../memory/termSessions.js";
import { state } from "../scheduler/index.js";
import { publish } from "../bus.js";

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\r/g;

export const jobs = new Hono()
  .get("/jobs", (c) => c.json(listJobs()))
  /** 问一遍还标着 running 的窗口在不在，没了的收掉。工作台窗口重新聚焦时前端调一次：
      你 ⌘W 关掉终端再切回来，看到的状态就是对的，不用等调度器那一分钟。 */
  .post("/jobs/sweep", async (c) => c.json({ closed: await sweepClosedTerminals() }))
  /** 关掉一个终端：杀进程组 + job 收尾。任务不动，用户可能还想接着做。 */
  .post("/jobs/:id/close", async (c) => {
    const id = c.req.param("id");
    const job = getJob(id);
    if (!job) return c.json({ error: "没有这个终端" }, 404);
    await closeJobTerminal(id, "用户手动关闭");
    return c.json({ closed: getJob(id)?.status !== "running", id });
  })
  /** 关掉所有在跑的终端。任务已经完成或忽略的优先，全关则不挑。 */
  .post("/jobs/close-all", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { onlyFinished?: boolean };
    const running = listJobs().filter((j) => j.status === "running");
    const targets = body.onlyFinished
      ? running.filter((j) => {
          const t = findTaskBySource((src) => src.jobId === j.id, true);
          return !t || t.status === "done" || t.status === "ignored";
        })
      : running;
    let closed = 0;
    for (const j of targets) {
      closeJobTerminal(j.id, body.onlyFinished ? "任务已收工，清理遗留终端" : "用户一键关闭全部终端");
      if (getJob(j.id)?.status !== "running") closed++;
    }
    return c.json({ closed, scanned: running.length });
  })
  .get("/jobs/:id", (c) => {
    const job = getJob(c.req.param("id"));
    return job ? c.json(job) : c.json({ error: "任务不存在" }, 404);
  })
  .get("/jobs/:id/log", (c) => {
    const path = jobLogPath(c.req.param("id"));
    if (!path) return c.json({ error: "任务不存在" }, 404);
    let text = "";
    try {
      text = readFileSync(path, "utf8").replace(ANSI, "");
    } catch {
      text = "";
    }
    const lines = text.split("\n");
    return c.json({ tail: lines.slice(-200).join("\n"), lines: lines.length });
  })
  // Stop hook 回报：终端里 Claude 刚完成一轮的最后一段话
  .post("/jobs/:id/message", async (c) => {
    const parsed = z
      .object({
        text: z.string().max(20_000).optional(),
        sessionId: z.string().max(200).optional(),
        event: z.string().max(40).optional(),
        source: z.string().max(40).optional(),
        toolName: z.string().max(80).optional(),
        toolInput: z.string().max(4000).optional(),
        message: z.string().max(1000).optional(),
        notificationType: z.string().max(40).optional(),
        cwd: z.string().max(1000).optional(),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success || (!parsed.data.text && !parsed.data.sessionId && !parsed.data.toolName && !parsed.data.message)) return c.json({ error: "text / sessionId / toolName / message 至少一个" }, 400);
    const id = c.req.param("id");
    const { text, sessionId, event, source, toolName, toolInput, message, notificationType, cwd } = parsed.data;
    if (!getJob(id)) return c.json({ error: "任务不存在" }, 404);
    // 交互式提问：PreToolUse 进来就是阻塞，PostToolUse 说明答了
    if (event === "PreToolUse" && toolName && /^(AskUserQuestion|ExitPlanMode)$/.test(toolName)) terminalAsking(id, describeQuestion(toolName, toolInput));
    if (event === "PostToolUse" && toolName && /^(AskUserQuestion|ExitPlanMode)$/.test(toolName)) terminalAnswered(id);
    if (event === "Notification" && notificationType === "permission_prompt") terminalAsking(id, message ?? "终端在等你确认一个操作", true);
    const okText = text ? setJobMessage(id, text) : true;
    const okSid = sessionId ? setJobSession(id, sessionId) : true;
    if (!okText || !okSid) return c.json({ error: "任务不存在" }, 404);
    const sid = getJob(id)?.sessionId;
    if (event === "SessionStart" && sid) {
      // 准备段期间 core 重启过，POST /worktree 没送到：按干活段 Claude 的 cwd 补上，走同一套占用校验
      const s = getTermSession(sid);
      if (s?.status === "preparing" && cwd && cwd !== s.repoDir) await worktreeReady(id, cwd);
      await flushQueued(sid);
    }
    if (event === "UserPromptSubmit" && sid) {
      markInput(sid);
      publish({ type: "tasks" });
    }
    // 一轮说完（Stop）、--resume 回来、或 Claude 在空等输入（Esc 中断不会有 Stop），都是"终端空闲"
    if (event === "Stop" || (event === "SessionStart" && source === "resume") || (event === "Notification" && notificationType === "idle_prompt") || (!event && text)) {
      if (sid) markStop(sid);
      clearAttention(id);
      if (sid) publish({ type: "tasks" });
    }
    if ((event === "Stop" || !event) && text) turnFinished(id, text);
    return c.json({ ok: true });
  })
  // 终端脚本回报退出码
  .get("/jobs/:id/activity", (c) => {
    const job = getJob(c.req.param("id"));
    if (!job) return c.json({ error: "任务不存在" }, 404);
    return c.json({ items: jobActivity(job.dir, job.claudeSessionId, Number(c.req.query("limit") ?? 12)), session: job.sessionId ? getTermSession(job.sessionId)?.status ?? "closed" : "closed" });
  })
  .post("/jobs/:id/worktree", async (c) => {
    const parsed = z.object({ path: z.string().min(1).max(1000) }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "path 必填" }, 400);
    const s = await worktreeReady(c.req.param("id"), parsed.data.path);
    if (s) return c.json(s);
    const sid = getJob(c.req.param("id"))?.sessionId;
    return sid && getTermSession(sid) ? c.json({ error: "准备段复用了别的任务的 worktree 或分支，这条没开工" }, 409) : c.json({ error: "没有这个会话" }, 404);
  })
  .post("/jobs/:id/exit", async (c) => {
    const parsed = z.object({ code: z.number().int(), phase: z.literal("prepare").optional() }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "code 需为整数" }, 400);
    if (parsed.data.phase === "prepare") {
      const t = prepareFailed(c.req.param("id"));
      return t ? c.json(t) : c.json({ error: "任务不存在" }, 404);
    }
    const job = finishJob(c.req.param("id"), parsed.data.code);
    if (!job) return c.json({ error: "任务不存在" }, 404);
    if (job.sessionId) updateTermSession(job.sessionId, { status: "exited" });
    const task = onJobExit(job.id, parsed.data.code);
    if (task) state.notices.push({ title: `交付待审核 · ${job.project}`, body: task.report?.summary ?? task.progress ?? "", taskId: task.id });
    const summary = `${job.project} 的终端任务已结束（退出码 ${parsed.data.code}）${job.lastMessage ? `\n最后一轮：${job.lastMessage.slice(0, 300)}` : ""}`;
    if (job.conversationId && conversationExists(job.conversationId)) {
      addMessage(job.conversationId, { role: "assistant", kind: "run", content: summary, payload: { status: "finished", jobId: job.id } });
    }
    const taskId = task?.id ?? findTaskBySource((s) => s.jobId === job.id, true)?.id;
    state.notices.push({ title: `任务结束 · ${job.project}`, body: job.lastMessage?.slice(0, 120) ?? `退出码 ${parsed.data.code}`, taskId });
    return c.json(job);
  })
  /** Claude 退出了但任务没完：在同一个 tmux 会话里 --resume 接回原来那个 Claude 会话 */
  .post("/jobs/:id/reopen", async (c) => {
    const id = c.req.param("id");
    const sid = getJob(id)?.sessionId;
    const cur = sid ? getTermSession(sid) : undefined;
    if (cur && cur.status !== "exited") return c.json({ error: "会话还在跑，不用接回" }, 409);
    const ok = sid ? await resumeInSession(sid, undefined, id) : false;
    return ok ? c.json({ status: "reopened", id }) : c.json({ error: "会话已不在，重新开工" }, 404);
  });
