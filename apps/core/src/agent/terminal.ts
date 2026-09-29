import { existsSync } from "node:fs";
import type { Task } from "@friday/shared";
import { isFridayRun } from "@friday/shared";
import { finishJob, getJob, runningJobs } from "../memory/jobs.js";
import { listTasks } from "../memory/tasks.js";
import { record } from "../memory/audit.js";
import { getTermSession, openTermSessions, updateTermSession } from "../memory/termSessions.js";
import { killSession, listSessionNames } from "./tmux.js";
import { sayToSession } from "./sessions.js";
import { publish } from "../bus.js";

export type SayResult = "sent" | "queued" | "no-terminal";

export async function say(jobId: string, text: string): Promise<SayResult> {
  const sid = getJob(jobId)?.sessionId;
  return sid ? sayToSession(sid, text) : "no-terminal";
}

export async function sweepClosedTerminals(): Promise<string[]> {
  const names = await listSessionNames();
  if (!names) return [];
  const live = new Set(names);
  const dead: string[] = [];
  for (const s of openTermSessions()) {
    if (live.has(s.tmuxName)) continue;
    updateTermSession(s.id, { status: "closed" });
    if (s.jobId && getJob(s.jobId)?.status === "running") {
      finishJob(s.jobId, -1);
      dead.push(s.jobId);
    }
  }
  for (const j of runningJobs()) if (!j.sessionId) { finishJob(j.id, -1); dead.push(j.id); }
  const stuck = listTasks("processing", 1000)
    .filter((t) => isFridayRun(t.source) && t.source.jobId && getJob(t.source.jobId)?.status !== "running")
    .map((t) => t.source.jobId!);
  const exits = [...new Set([...dead, ...stuck])];
  if (exits.length) {
    const { onJobExit } = await import("./pipeline.js");
    for (const jobId of exits) onJobExit(jobId, -1);
    publish({ type: "tasks" });
  }
  return dead;
}

export async function closeJobTerminal(jobId: string, why: string, taskId?: string): Promise<boolean> {
  const job = getJob(jobId);
  const s = job?.sessionId ? getTermSession(job.sessionId) : undefined;
  const killed = Boolean(s && s.status !== "closed");
  if (s && killed) {
    await killSession(s.tmuxName);
    updateTermSession(s.id, { status: "closed" });
  }
  if (job?.status === "running") finishJob(jobId, 0);
  if (killed || job?.status === "running") {
    record({ ...(taskId ? { taskId } : {}), action: "terminal_closed", why, how: killed ? "关掉 tmux 会话，job 收尾" : "job 收尾（会话已不在）", evidence: { jobId, project: job?.project ?? null }, risk: "reversible" });
  }
  return killed;
}

export async function closeTaskTerminal(task: Pick<Task, "id" | "source">, why: string): Promise<boolean> {
  if (task.source.rootId) return false;
  const s = getTermSession(task.id);
  const jobId = s?.jobId ?? task.source.jobId;
  if (!jobId) return false;
  const closed = await closeJobTerminal(jobId, why, task.id);
  const tree = task.source.worktree;
  if (tree && existsSync(tree)) record({ taskId: task.id, action: "worktree_kept", why, how: `worktree 还在：${tree}，终端里的 Claude 没收，留给你在设置页处理`, evidence: { worktree: tree, branch: task.source.branch ?? null }, risk: "read" });
  return closed;
}
