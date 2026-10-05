import { existsSync } from "node:fs";
import type { OpenTerminal, Task } from "@friday/shared";
import { isFridayRun } from "@friday/shared";
import { finishJob, getJob, runningJobs } from "../memory/jobs.js";
import { getTask, listTasks } from "../memory/tasks.js";
import { record } from "../memory/audit.js";
import { getTermSession, openTermSessions, updateTermSession } from "../memory/termSessions.js";
import { killSession, listSessionNames } from "./tmux.js";
import { liveRootId, sayToSession } from "./sessions.js";
import { detachSession } from "./attach.js";
import { sessionState } from "./sessionState.js";
import { publish } from "../bus.js";

const FRESH_SESSION_MS = 30_000;

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
    if (Date.now() - Date.parse(s.createdAt) < FRESH_SESSION_MS) continue;
    updateTermSession(s.id, { status: "closed" });
    detachSession(s.id);
    for (const j of runningJobs()) if (j.sessionId === s.id) { finishJob(j.id, -1); dead.push(j.id); }
  }
  for (const j of runningJobs()) if (!j.sessionId) { finishJob(j.id, -1); dead.push(j.id); }
  const stuck = listTasks("processing", 1000)
    .filter((t) => {
      const job = isFridayRun(t.source) && t.source.jobId ? getJob(t.source.jobId) : undefined;
      if (!job || job.status === "running") return false;
      return !(t.source.rejectedAt && job.finishedAt && t.source.rejectedAt >= job.finishedAt);
    })
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
  const killed = Boolean(s && s.status !== "closed" && (taskId ?? job?.taskId) === s.id);
  if (s && killed) {
    await killSession(s.tmuxName);
    updateTermSession(s.id, { status: "closed" });
    detachSession(s.id);
  }
  if (job?.status === "running") finishJob(jobId, 0);
  if (killed || job?.status === "running") {
    record({ ...(taskId ? { taskId } : {}), action: "terminal_closed", why, how: killed ? "关掉 tmux 会话，job 收尾" : "job 收尾（会话已不在）", evidence: { jobId, project: job?.project ?? null }, risk: "reversible" });
  }
  return killed;
}

export async function closeTaskTerminal(task: Task, why: string): Promise<boolean> {
  if (liveRootId(task)) return false;
  const s = getTermSession(task.id);
  const jobId = s?.jobId ?? task.source.jobId;
  if (!jobId) return false;
  const closed = await closeJobTerminal(jobId, why, task.id);
  const tree = task.source.worktree;
  if (tree && existsSync(tree)) record({ taskId: task.id, action: "worktree_kept", why, how: `worktree 还在：${tree}，终端里的 Claude 没收，留给你在设置页处理`, evidence: { worktree: tree, branch: task.source.branch ?? null }, risk: "read" });
  return closed;
}

/** 顶栏点开「N 个终端」：tmux 里还开着的会话，包括 Claude 已退出、只剩 zsh 的 */
export function openTerminals(): OpenTerminal[] {
  return openTermSessions().map((s) => {
    const t = getTask(s.id);
    const where: OpenTerminal["where"] = t?.source.projectShell ? "shell" : t?.source.projectTerminal ? "project" : s.kind === "query" ? "query" : "task";
    const label = where === "shell" ? `${s.project} · 终端` : where === "project" ? `${s.project} · Claude` : (t?.title ?? s.tmuxName);
    return {
      sessionId: s.id,
      label,
      where,
      project: s.project,
      state: sessionState(t ?? { status: "processing" }, s),
      ...(t && (where === "task" || where === "query") ? { taskId: t.id } : {}),
      ...(s.branch ? { branch: s.branch } : {}),
    };
  });
}

/** 按会话关：杀 tmux 会话、会话里那次运行收尾。任务本身不动，worktree 留着 */
export async function closeSessionTerminal(sessionId: string, why: string): Promise<boolean> {
  const s = getTermSession(sessionId);
  if (!s || s.status === "closed") return false;
  if (s.jobId && getJob(s.jobId)) return closeJobTerminal(s.jobId, why, s.id);
  await killSession(s.tmuxName);
  updateTermSession(s.id, { status: "closed" });
  detachSession(s.id);
  record({ taskId: s.id, action: "terminal_closed", why, how: "关掉 tmux 会话", evidence: { session: s.tmuxName }, risk: "reversible" });
  return true;
}
