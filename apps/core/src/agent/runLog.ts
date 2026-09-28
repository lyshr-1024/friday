import { randomUUID } from "node:crypto";
import type { RunExit } from "@friday/shared";
import { getJob } from "../memory/jobs.js";
import { createRun, finishRun, roundCostSoFar, runByJob } from "../memory/runs.js";
import { currentBranchSync, diffStatSync, headShaSync } from "./git.js";
import { sessionCost } from "./transcript.js";

function snapshot(dir: string, sessionId: string | undefined) {
  const cost = sessionCost(dir, sessionId);
  return {
    branch: currentBranchSync(dir) || undefined,
    tipSha: headShaSync(dir) || undefined,
    ...(diffStatSync(dir) ?? {}),
    ...(cost ? { costUsd: cost.costUsd, model: cost.model } : {}),
  };
}

/** 自主任务 / 后台查询收尾：一个 job 只收一次，先到的那个口径算数（friday_done 之后的进程退出不覆盖）。 */
export function closeRun(jobId: string, exit: RunExit): void {
  const run = runByJob(jobId);
  const job = getJob(jobId);
  if (!run || run.endedAt || !job) return;
  finishRun(run.id, { exit, ...snapshot(job.dir, job.claudeSessionId) });
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
