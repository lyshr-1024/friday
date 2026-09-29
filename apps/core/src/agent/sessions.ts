import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { Job, Task, TermSession, TermSessionKind } from "@friday/shared";
import { publish } from "../bus.js";
import { record } from "../memory/audit.js";
import { createJob, finishJob, getJob, recordTerminalInput, reviveJob, setJobDir } from "../memory/jobs.js";
import { findTaskBySource, getTask, updateTask } from "../memory/tasks.js";
import { createTermSession, getTermSession, markInput, otherOpenSessionUsing, updateTermSession } from "../memory/termSessions.js";
import { currentBranchSync } from "./git.js";
import { jobLog, launchInSession, shellQuote, writeResumeScript, type SessionLaunch } from "./runner.js";
import { claudeWindowIndex, hasSession, killSession, renameSession, safeName, sendText, sessionName, tmuxVersion, TmuxMissingError, writeTmuxConf } from "./tmux.js";

let launch: typeof launchInSession = launchInSession;
export function setLauncher(fn: typeof launchInSession): void {
  launch = fn;
}

const isOpen = (t: Task | undefined): t is Task => Boolean(t && t.status !== "done" && t.status !== "ignored");

export function liveRootId(task: Task): string | undefined {
  const id = task.source.rootId;
  return id && isOpen(getTask(id)) ? id : undefined;
}

export function resolveRoot(task: Task): Task {
  if (task.source.rootId) {
    const root = getTask(task.source.rootId);
    return isOpen(root) ? root : task;
  }
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
  o: { kind: TermSessionKind; project: string; repoDir: string; task: string; baseBranch?: string; jobId?: string; conversationId?: string },
): Promise<string> {
  if (!(await tmuxVersion())) throw new TmuxMissingError();
  writeTmuxConf();
  const jobId = o.jobId ?? randomUUID();
  let name = sessionName(o.repoDir, root.id.slice(0, 8));
  if (await hasSession(name)) {
    if (getTermSession(root.id)?.tmuxName === name) await killSession(name);
    else name = `${name}-${randomUUID().slice(0, 4)}`;
  }
  const existingBranch = [root.source.branch, owner.source.branch].find((b) => b && b !== "main" && b !== "master");
  createJob({ id: jobId, project: o.project, dir: o.repoDir, task: o.task.slice(0, 500), logPath: jobLog(jobId), taskId: owner.id, sessionId: root.id, ...(o.conversationId ? { conversationId: o.conversationId } : {}) });
  createTermSession({ id: root.id, project: o.project, repoDir: o.repoDir, tmuxName: name, kind: o.kind, jobId });
  try {
    await launch({ id: jobId, repoDir: o.repoDir, task: o.task, kind: o.kind, project: o.project, title: root.title, ...(root.understanding ? { description: root.understanding.slice(0, 200) } : {}), ...(o.baseBranch ? { baseBranch: o.baseBranch } : {}), ...(existingBranch ? { existingBranch } : {}) }, name);
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
  const win = await claudeWindowIndex(s.tmuxName);
  if (win === undefined) return "no-terminal";
  await sendText(s.tmuxName, text, win);
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

function jobKind(job: Job, fallback: TermSessionKind): TermSessionKind {
  const owner = job.taskId ? getTask(job.taskId) : undefined;
  if (!owner) return fallback;
  return owner.source.headless ? "query" : owner.source.autonomous ? "autonomous" : "interactive";
}

export async function resumeInSession(sessionId: string, prompt?: string, jobId?: string): Promise<boolean> {
  const s = getTermSession(sessionId);
  const id = jobId ?? s?.jobId;
  const job = id ? getJob(id) : undefined;
  if (!s || !job || job.sessionId !== s.id || !(await hasSession(s.tmuxName))) return false;
  if (s.kind !== "query" && !s.worktree) return false;
  const win = await claudeWindowIndex(s.tmuxName);
  if (win === undefined) return false;
  const file = await writeResumeScript(
    { id: job.id, repoDir: s.repoDir, kind: "interactive", project: s.project, ...(job.claudeSessionId ? { resumeSessionId: job.claudeSessionId } : {}), ...(prompt ? { task: prompt } : {}) },
    s.worktree ?? s.repoDir,
    jobKind(job, s.kind),
  );
  await sendText(s.tmuxName, `/bin/zsh ${shellQuote(file)}`, win);
  reviveJob(job.id);
  updateTermSession(sessionId, { status: "running" });
  markInput(sessionId);
  record({ taskId: job.taskId, action: "terminal_reopened", why: "Claude 退出了但任务还没做完", how: job.claudeSessionId ? "在同一个会话里 --resume 接回" : "在同一个会话里开新 Claude", evidence: { jobId: job.id, session: s.tmuxName }, risk: "reversible" });
  publish({ type: "tasks" });
  return true;
}

export async function runInSession(sessionId: string, launch: SessionLaunch, ownerId = sessionId): Promise<boolean> {
  const s = getTermSession(sessionId);
  if (!s || s.status === "closed" || !(await hasSession(s.tmuxName))) return false;
  if (launch.kind !== "query" && !s.worktree) return false;
  const win = await claudeWindowIndex(s.tmuxName);
  if (win === undefined) return false;
  const cwd = s.worktree ?? s.repoDir;
  const file = await writeResumeScript({ ...launch, repoDir: s.repoDir, project: s.project }, cwd);
  createJob({ id: launch.id, project: s.project, dir: cwd, task: (launch.task ?? "").slice(0, 500), logPath: jobLog(launch.id), taskId: ownerId, sessionId });
  try {
    await sendText(s.tmuxName, `/bin/zsh ${shellQuote(file)}`, win);
  } catch (e) {
    finishJob(launch.id, 1);
    throw e;
  }
  updateTermSession(sessionId, { status: "running", ...(ownerId === sessionId ? { jobId: launch.id } : {}) });
  markInput(sessionId);
  record({ taskId: ownerId, action: "terminal_run", why: "会话里的 Claude 已经退出，这次的活在同一个会话、同一个 worktree 里接着跑", how: `新起一次 ${launch.kind} 运行`, evidence: { jobId: launch.id, session: s.tmuxName }, risk: "reversible" });
  publish({ type: "tasks" });
  return true;
}

export async function continueRootSession(root: Task, detail: string): Promise<boolean> {
  const s = getTermSession(root.id);
  if (!s || s.status === "closed" || !(await hasSession(s.tmuxName))) return false;
  if (s.status === "exited") return resumeInSession(root.id, detail);
  return (await sayToSession(root.id, detail)) !== "no-terminal";
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
  const clash = otherOpenSessionUsing(s.id, "worktree", path, s.repoDir) ? `worktree（${path}）` : branch && otherOpenSessionUsing(s.id, "branch", branch, s.repoDir) ? `分支（${branch}）` : undefined;
  if (clash) {
    finishJob(jobId, 2);
    updateTermSession(s.id, { status: "exited" });
    if (job.taskId) {
      record({ taskId: job.taskId, action: "claude_code_blocked", why: "准备段复用了别的任务已经在用的 worktree / 分支", how: `${clash}已被另一个未关闭的会话占用`, evidence: { jobId, path, branch: branch ?? null }, risk: "read", status: "failed" });
      updateTask(job.taskId, { status: "blocked", progress: `准备段复用了别的任务的${clash}，这条没开工` });
    }
    publish({ type: "tasks" });
    return undefined;
  }
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
