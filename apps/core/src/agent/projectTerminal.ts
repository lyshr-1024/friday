import type { ProjectTerminal, Task } from "@friday/shared";
import { record } from "../memory/audit.js";
import { loadProjects, type Project } from "../memory/projects.js";
import { createTask, findTaskBySource, updateTask } from "../memory/tasks.js";
import { getTermSession, markSeen, markStop } from "../memory/termSessions.js";
import { hasSession } from "./tmux.js";
import { openSession, resumeInSession, reviveSession } from "./sessions.js";
import { sessionState } from "./sessionState.js";

/** 每个项目一条隐藏的锚点任务：Friday 的终端都挂在任务上，项目终端也得有个挂靠的地方，但它不进任务列表 */
function anchorOf(name: string): Task | undefined {
  return findTaskBySource((s) => s.projectTerminal === name, true);
}

function ensureAnchor(p: Project): Task {
  const t = anchorOf(p.name);
  if (!t) return createTask({ title: `项目终端：${p.name}`, kind: "project", status: "processing", project: p.name, source: { projectTerminal: p.name, repoDir: p.dir } });
  // 终端里调过 friday_finish 会把锚点标完成，下次打开时拉回来
  return t.status === "processing" ? t : updateTask(t.id, { status: "processing", attention: undefined })!;
}

export function projectTerminals(): ProjectTerminal[] {
  return loadProjects().map((p) => {
    const t = anchorOf(p.name);
    const s = t ? getTermSession(t.id) : undefined;
    const open = s && s.status !== "closed" ? s : undefined;
    return {
      name: p.name,
      dir: p.dir,
      ...(t ? { taskId: t.id } : {}),
      ...(open ? { jobId: open.jobId, status: open.status, state: sessionState(t!, open) } : {}),
    };
  });
}

/**
 * 打开项目终端：直接在主仓目录里起交互式 Claude，不建任务、不建 worktree、不跑准备段。
 * 已经开着就原样返回；Claude 退出了就在同一个会话里接回；会话被关了就重开一个。
 */
export async function openProjectTerminal(name: string): Promise<ProjectTerminal | { error: string }> {
  const p = loadProjects().find((x) => x.name === name);
  if (!p) return { error: `注册表里没有项目「${name}」` };
  const t = ensureAnchor(p);
  const s = getTermSession(t.id);
  const alive = s && s.status !== "closed" && (await hasSession(s.tmuxName));
  if (alive) {
    if (s.status === "exited") await resumeInSession(t.id);
  } else if (!(s?.jobId && s.repoDir === p.dir && (await reviveSession(t.id, s.jobId)))) {
    const jobId = await openSession(t, t, { kind: "interactive", project: p.name, repoDir: p.dir, task: "", inRepo: true });
    updateTask(t.id, { source: { jobId } });
    // 没有开场任务，Claude 起来就是在等你开口：不算「干活中」也不算「等你输入」
    markStop(t.id);
    markSeen(t.id);
    record({ taskId: t.id, action: "project_terminal_opened", why: "你在「项目」页打开了项目终端", how: `在 ${p.dir} 里起交互式 Claude Code，不建 worktree`, evidence: { project: p.name, dir: p.dir, jobId }, risk: "reversible" });
  }
  return projectTerminals().find((x) => x.name === name)!;
}
