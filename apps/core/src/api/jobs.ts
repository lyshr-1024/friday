import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { z } from "zod";
import { focusTerminal } from "../agent/runner.js";
import { addMessage, conversationExists } from "../memory/conversations.js";
import { finishJob, getJob, jobLogPath, listJobs, setJobMessage } from "../memory/jobs.js";
import { state } from "../scheduler/index.js";
import { userSettings } from "../settings.js";

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\r/g;

export const jobs = new Hono()
  .get("/jobs", (c) => c.json(listJobs()))
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
    const parsed = z.object({ text: z.string().min(1).max(20_000) }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "text 不能为空" }, 400);
    return setJobMessage(c.req.param("id"), parsed.data.text) ? c.json({ ok: true }) : c.json({ error: "任务不存在" }, 404);
  })
  // 终端脚本回报退出码
  .post("/jobs/:id/exit", async (c) => {
    const parsed = z.object({ code: z.number().int() }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "code 需为整数" }, 400);
    const job = finishJob(c.req.param("id"), parsed.data.code);
    if (!job) return c.json({ error: "任务不存在" }, 404);
    const summary = `${job.project} 的终端任务已结束（退出码 ${parsed.data.code}）${job.lastMessage ? `\n最后一轮：${job.lastMessage.slice(0, 300)}` : ""}`;
    if (job.conversationId && conversationExists(job.conversationId)) {
      addMessage(job.conversationId, { role: "assistant", kind: "run", content: summary, payload: { status: "finished", jobId: job.id } });
    }
    state.notices.push({ title: `任务结束 · ${job.project}`, body: job.lastMessage?.slice(0, 120) ?? `退出码 ${parsed.data.code}` });
    return c.json(job);
  })
  .post("/jobs/:id/focus", async (c) => {
    if (!getJob(c.req.param("id"))) return c.json({ error: "任务不存在" }, 404);
    await focusTerminal(userSettings().terminal);
    return c.json({ ok: true });
  });
