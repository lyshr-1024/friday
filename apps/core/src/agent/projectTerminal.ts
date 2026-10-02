import type { ProjectOverview, ProjectTaskLine, ProjectTerminal, Task } from "@friday/shared";
import { leftoverWorktrees } from "../api/worktrees.js";
import { record } from "../memory/audit.js";
import { loadProjects, type Project } from "../memory/projects.js";
import { createTask, findTaskBySource, listTasks, updateTask } from "../memory/tasks.js";
import { getTermSession, markSeen, markStop } from "../memory/termSessions.js";
import { currentBranchSync, worktreeDirtySync } from "./git.js";
import { hasSession } from "./tmux.js";
import { openSession } from "./sessions.js";
import { sessionState, taskSession } from "./sessionState.js";
import { closeJobTerminal } from "./terminal.js";

type Which = "claude" | "shell";

const ROUTINE = new Set(["project", "okr_weekly", "handbook"]);

/** 每个项目两条隐藏的锚点任务（Claude、shell 各一）：Friday 的终端都挂在任务上，但它们不进任务列表 */
function anchorOf(name: string, which: Which): Task | undefined {
  return findTaskBySource((s) => (which === "claude" ? s.projectTerminal === name : s.projectShell === name), true);
}

function ensureAnchor(p: Project, which: Which): Task {
  const t = anchorOf(p.name, which);
  if (!t) {
    const source = which === "claude" ? { projectTerminal: p.name, repoDir: p.dir } : { projectShell: p.name, repoDir: p.dir };
    return createTask({ title: `${which === "claude" ? "项目终端" : "项目 shell"}：${p.name}`, kind: "project", status: "processing", project: p.name, source });
  }
  // 终端里调过 friday_finish 会把锚点标完成，下次打开时拉回来
  return t.status === "processing" ? t : updateTask(t.id, { status: "processing", attention: undefined })!;
}

const openOf = (t: Task | undefined) => {
  const s = t ? getTermSession(t.id) : undefined;
  return s && s.status !== "closed" ? s : undefined;
};

export function projectTerminals(): ProjectTerminal[] {
  const open = listTasks(["collected", "understood", "processing", "review", "blocked"], 2000).filter((t) => !ROUTINE.has(t.kind));
  return loadProjects().map((p) => {
    const t = anchorOf(p.name, "claude");
    const s = openOf(t);
    const sh = anchorOf(p.name, "shell");
    const shOpen = openOf(sh);
    return {
      name: p.name,
      dir: p.dir,
      openTasks: open.filter((x) => x.project === p.name).length,
      ...(t ? { taskId: t.id } : {}),
      ...(s ? { jobId: s.jobId, status: s.status, state: sessionState(t!, s) } : {}),
      ...(sh ? { shell: { taskId: sh.id, ...(shOpen ? { status: shOpen.status } : {}) } } : {}),
    };
  });
}

async function closeAnchor(t: Task, why: string): Promise<void> {
  const s = getTermSession(t.id);
  if (s?.jobId && s.status !== "closed") await closeJobTerminal(s.jobId, why, t.id);
}

/**
 * 打开项目里的 Claude：直接在主仓目录里起交互式 Claude，不建任务、不建 worktree、不跑准备段。
 * 开着就原样返回；fresh = 关掉现在这段、全新开一段（上下文太大时用）。
 * 不自动 --resume：Claude 退出后窗格里留着 zsh，要接回旧对话你自己在里面 claude --resume。
 */
export async function openProjectTerminal(name: string, fresh = false): Promise<ProjectTerminal | { error: string }> {
  const p = loadProjects().find((x) => x.name === name);
  if (!p) return { error: `注册表里没有项目「${name}」` };
  const t = ensureAnchor(p, "claude");
  const s = getTermSession(t.id);
  const alive = s && s.status !== "closed" && (await hasSession(s.tmuxName));
  if (alive && s.status !== "exited" && !fresh) return projectTerminals().find((x) => x.name === name)!;
  if (s) await closeAnchor(t, fresh ? "你在「项目」页点了「新开一段」" : "Claude 已退出，你在「项目」页重新打开");
  const jobId = await openSession(t, t, { kind: "interactive", project: p.name, repoDir: p.dir, task: "", inRepo: true });
  updateTask(t.id, { source: { jobId } });
  // 没有开场任务，Claude 起来就是在等你开口：不算「干活中」也不算「等你输入」
  markStop(t.id);
  markSeen(t.id);
  record({ taskId: t.id, action: "project_terminal_opened", why: fresh ? "你在「项目」页新开了一段 Claude" : "你在「项目」页打开了 Claude", how: `在 ${p.dir} 里起交互式 Claude Code，不建 worktree、不接回旧对话`, evidence: { project: p.name, dir: p.dir, jobId }, risk: "reversible" });
  return projectTerminals().find((x) => x.name === name)!;
}

/** 项目里的普通 shell：跑 git、dev server 这类不用 Claude 的；会话归 tmux，切走也不断 */
export async function openProjectShell(name: string): Promise<ProjectTerminal | { error: string }> {
  const p = loadProjects().find((x) => x.name === name);
  if (!p) return { error: `注册表里没有项目「${name}」` };
  const t = ensureAnchor(p, "shell");
  const s = getTermSession(t.id);
  if (s && s.status !== "closed" && (await hasSession(s.tmuxName))) return projectTerminals().find((x) => x.name === name)!;
  const jobId = await openSession(t, t, { kind: "interactive", project: p.name, repoDir: p.dir, task: "", inRepo: true, shell: true });
  updateTask(t.id, { source: { jobId } });
  markStop(t.id);
  markSeen(t.id);
  record({ taskId: t.id, action: "project_shell_opened", why: "你在「项目」页开了终端", how: `在 ${p.dir} 里开一个 zsh`, evidence: { project: p.name, dir: p.dir, jobId }, risk: "reversible" });
  return projectTerminals().find((x) => x.name === name)!;
}

export async function closeProjectShell(name: string): Promise<ProjectTerminal | { error: string }> {
  const t = anchorOf(name, "shell");
  if (!t) return { error: `「${name}」没开过终端` };
  await closeAnchor(t, "你在「项目」页关了终端");
  return projectTerminals().find((x) => x.name === name)!;
}

const line = (t: Task): ProjectTaskLine => {
  const s = taskSession(t);
  const state = s.state;
  const branch = s.branch ?? t.source.branch;
  return {
    id: t.id,
    title: t.title,
    kind: t.kind,
    status: t.status,
    ...(t.stage ? { stage: t.stage } : {}),
    ...(state ? { state } : {}),
    ...(branch ? { branch } : {}),
    updatedAt: t.updatedAt,
  };
};

export function projectOverview(name: string): ProjectOverview | undefined {
  const p = loadProjects().find((x) => x.name === name);
  if (!p) return undefined;
  const mine = (t: Task) => t.project === name && !ROUTINE.has(t.kind);
  const open = listTasks(["collected", "understood", "processing", "review", "blocked"], 2000).filter(mine);
  const recent = listTasks("done", 200).filter(mine).slice(0, 5);
  const branch = currentBranchSync(p.dir);
  return {
    name: p.name,
    dir: p.dir,
    ...(p.note ? { note: p.note } : {}),
    ...(p.status ? { status: p.status } : {}),
    aliases: p.aliases,
    channels: p.channels,
    envs: p.envs,
    ...(branch ? { branch } : {}),
    dirty: branch ? worktreeDirtySync(p.dir) : false,
    open: open.map(line),
    recent: recent.map(line),
    leftover: leftoverWorktrees().filter((l) => l.repoDir === p.dir).length,
  };
}
