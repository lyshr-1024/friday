import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { Task, TermSession, TermSessionKind } from "@friday/shared";
import { publish } from "../bus.js";
import { record } from "../memory/audit.js";
import { createJob, finishJob, getJob, recordTerminalInput, reviveJob, setJobDir } from "../memory/jobs.js";
import { findTaskBySource, getTask, updateTask } from "../memory/tasks.js";
import { createTermSession, getTermSession, markInput, updateTermSession } from "../memory/termSessions.js";
import { currentBranchSync } from "./git.js";
import { jobLog, launchInSession, shellQuote, writeResumeScript } from "./runner.js";
import { hasSession, renameSession, safeName, sendText, sessionName, tmuxVersion, TmuxMissingError, writeTmuxConf } from "./tmux.js";

let launch: typeof launchInSession = launchInSession;
export function setLauncher(fn: typeof launchInSession): void {
  launch = fn;
}

export function resolveRoot(task: Task): Task {
  if (task.source.rootId) return getTask(task.source.rootId) ?? task;
  const story = task.source.linkedStoryId;
  if (!story) return task;
  const root = findTaskBySource((s) => s.meegleId === story || (s.mergedMeegleIds ?? []).includes(story));
  if (!root || root.id === task.id) return task;
  updateTask(task.id, { source: { rootId: root.id } });
  return root;
}

export function baseBranchOf(t: Task): { baseBranch?: string } {
  const b = t.source.baseTaskId ? getTask(t.source.baseTaskId)?.source.branch : undefined;
  return b ? { baseBranch: b } : {};
}

export async function openSession(
  root: Task,
  owner: Task,
  o: { kind: TermSessionKind; project: string; repoDir: string; task: string; baseBranch?: string; jobId?: string },
): Promise<string> {
  if (!(await tmuxVersion())) throw new TmuxMissingError();
  writeTmuxConf();
  const jobId = o.jobId ?? randomUUID();
  const name = sessionName(o.repoDir, root.id.slice(0, 8));
  createJob({ id: jobId, project: o.project, dir: o.repoDir, task: o.task.slice(0, 500), logPath: jobLog(jobId), taskId: owner.id, sessionId: root.id });
  createTermSession({ id: root.id, project: o.project, repoDir: o.repoDir, tmuxName: name, kind: o.kind, jobId });
  try {
    await launch({ id: jobId, repoDir: o.repoDir, task: o.task, kind: o.kind, project: o.project, ...(o.baseBranch ? { baseBranch: o.baseBranch } : {}) }, name);
  } catch (e) {
    finishJob(jobId, 1);
    updateTermSession(root.id, { status: "closed" });
    throw e;
  }
  publish({ type: "tasks" });
  return jobId;
}

const queued = new Map<string, string[]>();

export async function sayToSession(sessionId: string, text: string): Promise<"sent" | "queued" | "no-terminal"> {
  const s = getTermSession(sessionId);
  if (!s || s.status === "closed" || s.status === "exited" || !(await hasSession(s.tmuxName))) return "no-terminal";
  if (s.status === "preparing") {
    queued.set(sessionId, [...(queued.get(sessionId) ?? []), text]);
    return "queued";
  }
  await sendText(s.tmuxName, text);
  markInput(sessionId);
  if (s.jobId) recordTerminalInput(s.jobId, text);
  return "sent";
}

export async function flushQueued(sessionId: string): Promise<void> {
  const list = queued.get(sessionId);
  if (!list?.length) return;
  queued.delete(sessionId);
  updateTermSession(sessionId, { status: "running" });
  for (const text of list) await sayToSession(sessionId, text);
}

export async function resumeInSession(sessionId: string, prompt?: string): Promise<boolean> {
  const s = getTermSession(sessionId);
  const job = s?.jobId ? getJob(s.jobId) : undefined;
  if (!s || !job || !(await hasSession(s.tmuxName))) return false;
  const file = await writeResumeScript(
    { id: job.id, repoDir: s.repoDir, kind: "interactive", project: s.project, ...(job.claudeSessionId ? { resumeSessionId: job.claudeSessionId } : {}), ...(prompt ? { task: prompt } : {}) },
    s.worktree ?? s.repoDir,
  );
  await sendText(s.tmuxName, `/bin/zsh ${shellQuote(file)}`);
  reviveJob(job.id);
  updateTermSession(sessionId, { status: "running" });
  markInput(sessionId);
  record({ taskId: job.taskId, action: "terminal_reopened", why: "Claude 退出了但任务还没做完", how: job.claudeSessionId ? "在同一个会话里 --resume 接回" : "在同一个会话里开新 Claude", evidence: { jobId: job.id, session: s.tmuxName }, risk: "reversible" });
  publish({ type: "tasks" });
  return true;
}

export async function joinRootSession(task: Task, root: Task, detail: string): Promise<"joined" | "no-session"> {
  const s = getTermSession(root.id);
  if (!s || s.status === "closed" || !(await hasSession(s.tmuxName))) return "no-session";
  const text = `顺带再改一条同需求下的缺陷：\n${detail}\n\n改完一并在同一个分支上交付，不要另起分支。`;
  const ok = s.status === "exited" ? await resumeInSession(root.id, text) : (await sayToSession(root.id, text)) !== "no-terminal";
  if (!ok) return "no-session";
  updateTask(task.id, { status: "processing", progress: `在需求「${root.title.slice(0, 24)}」的会话里改`, source: { rootId: root.id } });
  record({ taskId: task.id, action: "handed_to_story_terminal", why: "同一个需求下的改动要走同一个分支，免得两个终端改同一片代码后合不上", how: `转达给需求任务 ${root.id.slice(0, 8)} 的会话`, evidence: { rootId: root.id, detail: detail.slice(0, 300) }, risk: "reversible" });
  return "joined";
}

export async function worktreeReady(jobId: string, path: string): Promise<TermSession | undefined> {
  const job = getJob(jobId);
  const s = job?.sessionId ? getTermSession(job.sessionId) : undefined;
  if (!job || !s) return undefined;
  const branch = currentBranchSync(path) || undefined;
  const next = safeName(basename(path));
  const renamed = Boolean(next) && next !== s.tmuxName && (await renameSession(s.tmuxName, next));
  setJobDir(jobId, path);
  const updated = updateTermSession(s.id, { status: "running", worktree: path, ...(branch ? { branch } : {}), ...(renamed ? { tmuxName: next } : {}) })!;
  for (const id of new Set([s.id, job.taskId].filter((x): x is string => Boolean(x)))) {
    updateTask(id, { source: { worktree: path, repoDir: s.repoDir, ...(branch ? { branch } : {}) } });
  }
  record({ taskId: job.taskId, action: "worktree_ready", why: "准备段按项目规则建好了 worktree", how: `${path}${branch ? ` · ${branch}` : ""}`, evidence: { jobId, path, branch: branch ?? null }, risk: "read" });
  publish({ type: "tasks" });
  return updated;
}

export function prepareFailed(jobId: string): Task | undefined {
  const job = getJob(jobId);
  if (!job) return undefined;
  finishJob(jobId, 2);
  if (job.sessionId) updateTermSession(job.sessionId, { status: "exited" });
  if (!job.taskId) return undefined;
  record({ taskId: job.taskId, action: "claude_code_blocked", why: "准备段没建出 worktree", how: "准备段结束时路径文件为空", evidence: { jobId }, risk: "read", status: "failed" });
  return updateTask(job.taskId, { status: "blocked", progress: "准备段没建出 worktree，打开终端看它的输出" });
}
