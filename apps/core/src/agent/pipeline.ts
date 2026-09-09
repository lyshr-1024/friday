import { randomUUID } from "node:crypto";
import type { Task, Thread, ThreadBrief } from "@friday/shared";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { listAudit, record } from "../memory/audit.js";
import { createJob } from "../memory/jobs.js";
import { resolveProject } from "../memory/projects.js";
import { addPending, createTask, findTaskBySource, getTask, updateTask } from "../memory/tasks.js";
import { userSettings } from "../settings.js";
import { autonomousPrompt, jobLog, launchClaude } from "./runner.js";
import { collectReport } from "./report.js";
import { existsSync, readFileSync } from "node:fs";

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Za-z0-9]|[\x00-\x08\x0b-\x1f]/g;

/** 终端日志最后几百字（去掉控制字符），用来解释任务为什么没交付。 */
export function logTail(jobId: string, chars = 300): string {
  const p = jobLog(jobId);
  if (!existsSync(p)) return "";
  const raw = readFileSync(p, "latin1").replace(ANSI, "");
  return Buffer.from(raw, "latin1").toString("utf8").replace(/\s+/g, " ").trim().slice(-chars);
}

const execFileP = promisify(execFile);

/**
 * 线程做完功课后进任务中枢：
 * - 一条线程一条任务（理解 = 情境，方案 = 动作）。
 * - 需要回复且有草稿 → 挂一个待审核的 slack_reply（不可逆，等用户点）。
 * - 建议动作里有 run_claude 且能定位项目 → 自动在分支上开自主 Claude Code 任务（可逆），完成后交付报告进审核。
 */
export async function threadToTask(thread: Thread, brief: ThreadBrief, project?: string): Promise<Task> {
  let task = findTaskBySource((s) => s.threadId === thread.id);
  const title = `${thread.userName}：${brief.needs || brief.situation}`.slice(0, 80);
  const plan = brief.actions.map((a) => `${a.label}${a.detail ? `：${a.detail}` : ""}`).join("\n");
  if (!task) {
    task = createTask({ title, kind: "slack", source: { threadId: thread.id }, ...(project ? { project } : {}), priority: brief.urgency, understanding: brief.situation, plan, status: "understood" });
    record({ taskId: task.id, action: "task_create", why: "Slack 线程做完功课", how: "从情境卡建任务", evidence: { threadId: thread.id, situation: brief.situation }, risk: "read" });
  } else {
    task = updateTask(task.id, { title, understanding: brief.situation, plan, priority: brief.urgency, ...(project ? { project } : {}) })!;
  }

  const first = thread.items[0];
  if (brief.needsReply && brief.reply && first && !(task.pending ?? []).some((p) => p.type === "slack_reply")) {
    task = addPending(task.id, {
      type: "slack_reply",
      label: `回复 ${thread.userName}`,
      detail: brief.reply,
      payload: { channel: first.channelId, text: brief.reply, ...(thread.kind === "mention" ? { threadTs: thread.items.at(-1)!.ts } : {}), userName: thread.userName },
    })!;
    record({ taskId: task.id, action: "slack_reply_prepared", why: "对方等回复", how: "按背景拟好回复，等你审核后发送", evidence: { text: brief.reply }, risk: "irreversible", status: "pending" });
  }

  const wantsCode = brief.actions.some((a) => a.type === "run_claude");
  const dir = project ? resolveProject(project) : undefined;
  if (wantsCode && dir?.kind === "match" && !task.source.jobId) {
    const detail = brief.actions.find((a) => a.type === "run_claude")?.detail ?? brief.needs;
    task = await startAutonomousJob(task, dir.project.name, dir.project.dir, `${detail}\n\n来源：${thread.userName} 在 Slack 说：${thread.items.map((i) => i.text).join(" / ").slice(0, 800)}`);
  }
  return task;
}

/** 自主开工：在分支上改、跑测试、写报告，结束后由 job exit 回调收报告进审核。 */
export async function startAutonomousJob(task: Task, project: string, dir: string, detail: string): Promise<Task> {
  const id = randomUUID();
  const prompt = autonomousPrompt(id, detail, project);
  await launchClaude({ id, dir, terminal: userSettings().terminal, task: prompt, autonomous: true });
  createJob({ id, project, dir, task: detail.slice(0, 500), logPath: jobLog(id) });
  record({
    taskId: task.id,
    action: "claude_code_start",
    why: "任务需要改代码，按策略自动在分支上完成再交审核",
    how: `Ghostty 里 claude -p，分支 friday/${id.slice(0, 8)}，完成后写交付报告`,
    evidence: { jobId: id, project, dir },
    risk: "reversible",
  });
  return updateTask(task.id, { status: "processing", progress: `Claude Code 正在 ${project} 的分支 friday/${id.slice(0, 8)} 上处理`, source: { ...task.source, jobId: id, autonomous: true } })!;
}

/** 终端任务退出：收交付报告，任务进审核，合并到主分支挂成待审核动作。 */
export function onJobExit(jobId: string, exitCode: number): Task | undefined {
  const job = getTaskByJob(jobId);
  if (!job) return undefined;
  if (job.task.report && job.task.status === "review") {
    record({ taskId: job.task.id, action: "claude_code_finish", why: "终端任务结束", how: `退出码 ${exitCode}，已经用 friday_done 交付过`, evidence: { jobId, exitCode }, risk: "read", status: exitCode === 0 ? "done" : "failed" });
    return job.task;
  }
  if (!job.task.source.autonomous) {
    record({ taskId: job.task.id, action: "claude_code_finish", why: "终端会话结束", how: `退出码 ${exitCode}，任务仍由用户决定是否完成`, evidence: { jobId, exitCode }, risk: "read", status: exitCode === 0 ? "done" : "failed" });
    return updateTask(job.task.id, { progress: `终端会话已结束（退出码 ${exitCode}）${job.task.progress ? `。之前：${job.task.progress.slice(0, 120)}` : ""}` })!;
  }
  const report = collectReport(jobId);
  const branch = `friday/${jobId.slice(0, 8)}`;
  record({
    taskId: job.task.id,
    action: "claude_code_finish",
    why: "终端任务结束",
    how: `退出码 ${exitCode}${report ? "，已收到交付报告" : "，没有找到交付报告"}`,
    evidence: { jobId, exitCode, hasReport: Boolean(report), screenshots: report?.screenshots.length ?? 0 },
    risk: "read",
    status: exitCode === 0 ? "done" : "failed",
  });
  // 自主任务必须有交付报告才算交付；交互式会话（你自己在终端里聊的）退出即完成。
  const interactive = !job.task.plan && !report;
  const tail = !report && exitCode !== 0 ? logTail(jobId) : "";
  let task = updateTask(job.task.id, {
    status: report ? "review" : interactive && exitCode === 0 ? "done" : exitCode === 0 ? "review" : "blocked",
    progress: report
      ? "交付报告已生成，等你审核"
      : interactive
        ? `终端会话已结束（退出码 ${exitCode}）`
        : `终端任务结束（退出码 ${exitCode}），未生成交付报告${tail ? `。终端最后输出：${tail}` : ""}`,
    ...(report ? { report } : {}),
  })!;
  if (report && !(task.pending ?? []).some((p) => p.type === "git_merge")) {
    task = addPending(task.id, { type: "git_merge", label: `合并 ${branch}`, detail: `把 ${branch} 合并进主分支（不 push）`, payload: { dir: job.dir, branch } })!;
  }
  return task;
}

function getTaskByJob(jobId: string): { task: Task; dir: string } | undefined {
  const ev = findTaskBySource((s) => s.jobId === jobId, true);
  if (ev) return { task: ev, dir: (ev.source as { dir?: string }).dir ?? "" };
  // 兼容：通过账本里 claude_code_start 的证据反查
  const hit = listAudit({ limit: 500 }).find((e) => e.action === "claude_code_start" && e.evidence.jobId === jobId);
  const task = hit?.taskId ? getTask(hit.taskId) : undefined;
  return task ? { task, dir: String(hit!.evidence.dir ?? "") } : undefined;
}

/** 执行一个审核通过的不可逆动作。 */
export async function executePending(taskId: string, actionId: string, deps: { slackPost: (channel: string, text: string, threadTs?: string) => Promise<{ ts: string; permalink?: string }> }): Promise<Task> {
  const { takePending } = await import("../memory/tasks.js");
  const taken = takePending(taskId, actionId);
  if (!taken) throw new Error("待审核动作不存在");
  const { action } = taken;
  try {
    if (action.type === "slack_reply") {
      const p = action.payload as { channel: string; text: string; threadTs?: string; userName?: string };
      const res = await deps.slackPost(p.channel, p.text, p.threadTs);
      record({ taskId, action: "slack_reply_sent", why: "你审核通过", how: "chat.postMessage", evidence: { channel: p.channel, text: p.text, ts: res.ts, permalink: res.permalink ?? null }, risk: "irreversible", status: "approved" });
    } else if (action.type === "git_merge") {
      const p = action.payload as { dir: string; branch: string };
      const base = (await execFileP("git", ["-C", p.dir, "branch", "--show-current"])).stdout.trim() || "main";
      await execFileP("git", ["-C", p.dir, "merge", "--no-ff", p.branch, "-m", `merge ${p.branch} (Friday, 已审核)`]);
      record({ taskId, action: "git_merge", why: "你审核通过", how: `git merge --no-ff ${p.branch} 到 ${base}`, evidence: p, risk: "irreversible", status: "approved" });
    } else {
      record({ taskId, action: action.type, why: "你审核通过", how: action.detail, evidence: action.payload, risk: "irreversible", status: "approved" });
    }
  } catch (e) {
    // 没发出去的动作要放回去，不然用户改好的草稿随失败一起丢了
    const cur = getTask(taskId);
    if (cur) updateTask(taskId, { pending: [...(cur.pending ?? []), action], status: "review" });
    throw e;
  }
  const t = getTask(taskId)!;
  return t.pending?.length ? t : updateTask(taskId, { status: "done", progress: "全部动作已执行" })!;
}
