import { randomUUID } from "node:crypto";
import type { RunExit, RunRecord, RunTrigger } from "@friday/shared";
import { getJob } from "../memory/jobs.js";
import { createRun, finishRun, openRunForTask, roundCostSoFar, runByJob, runsForTask, setRunCost, setRunOutcome } from "../memory/runs.js";
import { currentBranchSync, diffStatSync, headShaSync } from "./git.js";
import { sessionCost } from "./transcript.js";

function snapshot(dir: string, sessionId: string | undefined, costBase = 0) {
  const cost = sessionCost(dir, sessionId);
  return {
    branch: currentBranchSync(dir) || undefined,
    tipSha: headShaSync(dir) || undefined,
    ...(diffStatSync(dir) ?? {}),
    ...(cost ? { costUsd: Math.max(0, cost.costUsd - costBase), model: cost.model } : {}),
  };
}

export function closeRunForTask(taskId: string, exit: RunExit, dir?: string, claudeSessionId?: string): void {
  const run = openRunForTask(taskId);
  if (!run) return;
  finishRun(run.id, { exit, ...(dir ? snapshot(dir, claudeSessionId, run.costBase) : {}) });
}

/** 自主任务 / 后台查询收尾：一个 job 只收一次，先到的那个口径算数（friday_done 之后的进程退出不覆盖）。 */
export function closeRun(jobId: string, exit: RunExit): void {
  const run = runByJob(jobId);
  const job = getJob(jobId);
  if (!run || run.endedAt || !job) return;
  finishRun(run.id, { exit, ...snapshot(job.dir, job.claudeSessionId, run.costBase) });
}

/** 交互式终端的一轮交付。transcript 里的成本是整段会话累计的，这里只记这一轮新增的那部分。 */
export function recordRound(jobId: string, taskId: string, project: string): void {
  const job = getJob(jobId);
  if (!job) return;
  const id = `${jobId}#${randomUUID().slice(0, 8)}`;
  createRun({ id, jobId, taskId, project, kind: "interactive_round", trigger: "user" });
  const snap = snapshot(job.dir, job.claudeSessionId);
  const costUsd = snap.costUsd === undefined ? undefined : Math.max(0, snap.costUsd - roundCostSoFar(jobId));
  finishRun(id, { exit: "report", ...snap, ...(costUsd === undefined ? {} : { costUsd }) });
}

/** 收尾之后再补一次成本：friday_done 那一刻 claude -p 还没退出，最后一条 cost-state 要等它退出才落盘 */
export function fillRunCost(jobId: string): void {
  const run = runByJob(jobId);
  const job = getJob(jobId);
  if (!run || run.costUsd !== undefined || !job) return;
  const cost = sessionCost(job.dir, job.claudeSessionId);
  if (cost) setRunCost(run.id, Math.max(0, cost.costUsd - (run.costBase ?? 0)), cost.model);
}

/**
 * Friday 驾驶的会话交付后不退出，同一个 job 会交好几轮：每轮一行 `${jobId}#n`。
 * 成本从上一轮结束时的累计值起算；同一个 job 上还没结局的旧行标 superseded，结局只记在最后一轮
 */
export function startRound(jobId: string, taskId: string, project: string, trigger: RunTrigger, at?: string): RunRecord {
  const job = getJob(jobId);
  const rows = runsForTask(taskId).filter((r) => r.jobId === jobId && r.kind !== "interactive_round");
  for (const r of rows) if (r.outcome === "pending") setRunOutcome(r.id, "superseded", "后面又交了一轮");
  // 起算点是上一轮结束时的累计：followup 那行是交付时才补建的，此刻的累计已经含了这一轮
  const last = rows.at(-1);
  const base = last?.costUsd !== undefined ? (last.costBase ?? 0) + last.costUsd : job ? sessionCost(job.dir, job.claudeSessionId)?.costUsd : undefined;
  return createRun({ id: `${jobId}#${rows.length + 1}`, jobId, taskId, project, kind: rows[0]?.kind ?? "autonomous", trigger, ...(at ? { at } : {}), ...(base !== undefined ? { costBase: base } : {}) });
}
