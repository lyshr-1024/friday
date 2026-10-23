import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { workItemOf, type Task } from "@friday/shared";
import { record } from "../memory/audit.js";
import { getJob } from "../memory/jobs.js";
import { resolveProject } from "../memory/projects.js";
import { runByJob, setRunOutcome } from "../memory/runs.js";
import { getTermSession } from "../memory/termSessions.js";
import { addPending, getTask, listTasks, removePending, updateTask } from "../memory/tasks.js";
import { usableBriefDetail } from "./brief.js";
import { commitsAheadSync, isMergedSync } from "./git.js";
import { liveRootId } from "./sessions.js";
import { closeJobTerminal } from "./terminal.js";

/**
 * 改项目时要不要整体回退：看这次的活是谁干的，不看项目是谁选的。
 * Friday 自主跑的（不是后台查询、会话是它自己的而不是需求的）才算——
 * 你在交互式终端里干的，worktree 里是你的改动，删不删不归 Friday 定。
 */
export function isFridayWork(t: Task): boolean {
  return t.source.autonomous === true && !t.source.headless && Boolean(t.source.jobId) && !liveRootId(t);
}

const real = (p: string) => {
  try {
    return realpathSync(p).replace(/\/+$/, "");
  } catch {
    return p.replace(/\/+$/, "");
  }
};

function git(dir: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

interface Footprint {
  from: string;
  repoDir?: string;
  worktree?: string;
  branch?: string;
  dirty: number;
  jobId: string;
}

function footprint(t: Task): Footprint {
  const s = getTermSession(t.id);
  const worktree = t.source.worktree ?? s?.worktree;
  const repoDir = t.source.repoDir ?? s?.repoDir;
  const branch = t.source.branch ?? s?.branch ?? (worktree && existsSync(worktree) ? git(worktree, ["branch", "--show-current"]) : undefined);
  const status = worktree && existsSync(worktree) ? git(worktree, ["status", "--porcelain"]) : undefined;
  return {
    from: t.project ?? "",
    ...(repoDir ? { repoDir } : {}),
    ...(worktree ? { worktree } : {}),
    ...(branch ? { branch } : {}),
    dirty: status ? status.split("\n").filter(Boolean).length : 0,
    jobId: t.source.jobId!,
  };
}

/** 分支已经进了主干就退不回去了：账本里记成合并，或交付时有提交、那个提交现在在本地主干上 */
function mergedWhy(f: Footprint): string | undefined {
  const run = runByJob(f.jobId);
  if (run?.outcome === "merged_as_is" || run?.outcome === "merged_modified") return "这次交付已经合进主干了";
  // 分支上一个提交都没有时，它的头本来就在主干里，不能算合并
  if (f.repoDir && run?.tipSha && (run.filesChanged ?? 0) > 0 && isMergedSync(f.repoDir, run.tipSha)) return "分支上的提交已经在主干里了";
  return undefined;
}

function checklist(f: Footprint, to: string): string {
  const running = getJob(f.jobId)?.status === "running";
  return [
    `把 Friday 在 ${f.from} 上做的全部撤掉，改到 ${to} 重新开工：`,
    running ? "- 停掉正在跑的 Claude，关掉这个会话" : "- 关掉这个会话",
    f.worktree
      ? `- 删掉 worktree ${f.worktree}${f.branch ? ` 和分支 ${f.branch}` : ""}${f.dirty ? `，里面 ${f.dirty} 个没提交的文件一起丢掉` : ""}。只删 Friday 这次建的，你的主仓不动`
      : "- 这次还没建出 worktree，没有代码要删",
    "- 撤下进展、交付报告、截图和待审的合并",
    `- 项目改成 ${to}，阶段退回「未开始」。这次运行记成打回（项目判错），学手册时当一条教训`,
    `- 然后在 ${to} 上重新开工`,
    "远端数据不在自动回退范围里：交付报告的「测试过程」里写过造数的，按里面的还原步骤核对。",
  ].join("\n");
}

/**
 * 需求定了项目，名下的缺陷跟着走：原来只在 Meegle 同步建缺陷时继承一次，需求后定项目的，缺陷要等下一轮同步，
 * 期间缺陷卡还让你再选一次。只带给没项目的、和原来跟着需求旧项目走的；你单独给缺陷指定过的、
 * Friday 已经在上面自主干过活的（那得走回退清单）都不动。
 */
function inheritToDefects(story: Task, before?: string): void {
  const own = workItemOf(story.source)?.id;
  const ids = new Set([...(own ? [own] : []), ...(story.source.mergedIds ?? [])]);
  if (!ids.size) return;
  for (const d of listTasks(["collected", "understood", "processing", "review", "blocked"], 2000)) {
    const parent = workItemOf(d.source)?.parent?.id;
    if (d.id === story.id || !parent || !ids.has(parent)) continue;
    const inherited = !d.project || (d.project === before && d.source.projectBy !== "user");
    if (!inherited || d.project === story.project || isFridayWork(d)) continue;
    updateTask(d.id, { project: story.project });
    record({ taskId: d.id, action: "project_inherited", why: `所属需求「${story.title}」定了项目`, how: `项目${d.project ? `从 ${d.project} ` : ""}改成 ${story.project}`, evidence: { storyId: story.id, from: d.project ?? null, to: story.project ?? null }, risk: "reversible" });
  }
}

export type ProjectChange =
  | { kind: "same"; task: Task }
  | { kind: "set"; task: Task; before?: string }
  | { kind: "pending"; task: Task }
  | { kind: "cancelled"; task: Task }
  | { kind: "refused"; task: Task; why: string };

/**
 * 改项目的唯一入口（任务卡上的选择器、会话里的 task_update 都走这儿）。
 * Friday 自主干过活的不直接改：挂一条待审动作列出要撤掉什么，你说「撤掉」才执行。
 * 改回原来的项目等于反悔，把那条待审动作撤掉。
 */
export function requestProjectChange(taskId: string, to: string | null): ProjectChange | undefined {
  const t = getTask(taskId);
  if (!t) return undefined;
  const open = (t.pending ?? []).find((p) => p.type === "reproject");
  if ((t.project ?? null) === to) {
    if (!open) return { kind: "same", task: t };
    record({ taskId, action: "reproject_cancelled", why: "你改回了原来的项目", how: `不撤了，还是 ${t.project}`, evidence: { project: t.project ?? null }, risk: "reversible" });
    return { kind: "cancelled", task: removePending(taskId, open.id) ?? t };
  }
  if (!isFridayWork(t)) {
    // 定了项目就把 Friday「这是哪个项目的」那句提问收掉，不然会话还以为自己没得到答复、不肯开工
    const asked = t.attention === "intake";
    const task = updateTask(taskId, { project: to ?? undefined, source: { projectBy: "user" }, ...(asked && to ? { attention: undefined, progress: `项目定为 ${to}` } : {}) })!;
    if (to) inheritToDefects(task, t.project);
    return { kind: "set", task, ...(t.project ? { before: t.project } : {}) };
  }
  if (!to) return { kind: "refused", task: t, why: "Friday 已经在这个项目上干过活，要改就改成另一个项目，它会把做过的撤掉再重开" };
  const f = footprint(t);
  const merged = mergedWhy(f);
  if (merged) return { kind: "refused", task: t, why: `${merged}，没法整体回退。要改项目得你自己 revert` };
  const base = open ? (removePending(taskId, open.id) ?? t) : t;
  const task = addPending(
    base.id,
    { type: "reproject", label: `项目判错：撤掉 ${f.from} 上的改动，改到 ${to} 重开`, detail: checklist(f, to), payload: { from: f.from, to } },
    { keepStatus: true },
  )!;
  record({ taskId, action: "reproject_requested", why: `你把项目从 ${f.from} 改成 ${to}`, how: "挂了回退清单，等你说「撤掉」", evidence: { from: f.from, to, worktree: f.worktree ?? null, branch: f.branch ?? null }, risk: "read" });
  return { kind: "pending", task };
}

/** 关会话、删 worktree 和分支。路径得是这个仓库登记过的 worktree、不是主仓本身，否则什么都不动 */
async function discardFootprint(f: Footprint, why: string, taskId: string): Promise<{ removed: boolean; branchDeleted: boolean }> {
  if (f.worktree && f.repoDir && existsSync(f.worktree)) {
    const listed = (git(f.repoDir, ["worktree", "list", "--porcelain"]) ?? "")
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => real(l.slice(9)));
    if (real(f.worktree) === real(f.repoDir) || !listed.includes(real(f.worktree))) throw new Error(`${f.worktree} 不是这个仓库的 worktree，不删`);
  }

  await closeJobTerminal(f.jobId, why, taskId);

  let removed = false;
  let branchDeleted = false;
  if (f.worktree && f.repoDir && existsSync(f.worktree)) {
    removed = git(f.repoDir, ["worktree", "remove", "--force", f.worktree]) !== undefined;
    git(f.repoDir, ["worktree", "prune"]);
    if (!removed) throw new Error(`worktree ${f.worktree} 删不掉`);
  }
  if (f.branch && f.repoDir && !["main", "master"].includes(f.branch)) {
    branchDeleted = git(f.repoDir, ["branch", "-D", f.branch]) !== undefined;
  }
  return { removed, branchDeleted };
}

/**
 * 缺陷自己的 worktree 里还有没进主干的改动（领先主干的提交、没提交的文件）。
 * 在需求会话里改的不算：改动跟需求混在同一条分支上，拆不出来。交代进需求会话的缺陷 source.worktree 记的是
 * 需求的 worktree，需求收工后 liveRootId 就认不出了，所以只认缺陷自己那个 tmux 会话登记的 worktree。
 */
function defectChanges(t: Task): (Footprint & { ahead: number; pushed: boolean }) | undefined {
  if (!t.source.jobId || liveRootId(t) || t.source.handedAt) return undefined;
  const own = getTermSession(t.id)?.worktree;
  const f = footprint(t);
  if (!own || !f.worktree || real(own) !== real(f.worktree)) return undefined;
  if (!f.repoDir || !existsSync(f.worktree) || real(f.worktree) === real(f.repoDir)) return undefined;
  const ahead = isMergedSync(f.worktree, "HEAD") ? 0 : (commitsAheadSync(f.worktree) ?? 0);
  if (!ahead && !f.dirty) return undefined;
  const pushed = Boolean(f.branch && git(f.repoDir, ["rev-parse", "--verify", "-q", `refs/remotes/origin/${f.branch}`]));
  return { ...f, ahead, pushed };
}

/**
 * Meegle 里缺陷关了：可能是你在别处改好了、需求变了，也可能是修完测试验收关的单——Friday 分不出来，
 * 所以手上还有改动的挂一条「撤掉改动」等你定，不自动删。返回 false = 没东西要撤，照常收工。
 */
export function holdClosedDefect(t: Task, status: string): boolean {
  const f = defectChanges(t);
  if (!f) return false;
  const running = getJob(f.jobId)?.status === "running";
  const detail = [
    `Meegle 里这条缺陷已经是 ${status}，Friday 这边还留着：`,
    `- 分支 ${f.branch ?? "（读不到）"}${f.ahead ? `，比主干多 ${f.ahead} 个提交` : ""}`,
    `- worktree ${f.worktree}${f.dirty ? `，${f.dirty} 个没提交的文件` : ""}`,
    `说「撤掉」：${running ? "停掉正在跑的 Claude、" : ""}关掉会话，删掉 worktree 和分支（git branch -D），卡片收工。你的主仓不动。`,
    "说「完成，不执行」：只收卡，改动留着，worktree 进设置页「遗留 worktree」。",
    f.pushed ? `远端分支 origin/${f.branch} 和上面的 MR 不在撤销范围，要关得你自己去关。` : "",
  ].filter(Boolean).join("\n");
  updateTask(t.id, { progress: `Meegle 里已经是 ${status}，手上的改动等你定撤不撤`, source: { closedExternally: status } });
  addPending(t.id, { type: "discard_changes", label: "缺陷已关：撤掉改动", detail, payload: { status } });
  record({
    taskId: t.id,
    action: "closed_defect_held",
    why: `Meegle 里已经是 ${status}`,
    how: "手上还有没进主干的改动，挂「撤掉改动」等你定",
    evidence: { worktree: f.worktree ?? null, branch: f.branch ?? null, ahead: f.ahead, dirty: f.dirty, pushed: f.pushed },
    risk: "read",
  });
  return true;
}

/** 执行「撤掉改动」：执行时重新看一遍现场，你这期间已经合进主干或自己清掉了的就只收卡 */
export async function discardClosedDefect(taskId: string, status: string): Promise<Task> {
  const t = getTask(taskId);
  if (!t) throw new Error("任务不存在了");
  const f = defectChanges(t);
  const why = `Meegle 里已经是 ${status}，撤掉手上的改动`;
  const res = f ? await discardFootprint(f, why, t.id) : undefined;
  const run = f ? runByJob(f.jobId) : undefined;
  if (run && (!run.outcome || run.outcome === "pending")) setRunOutcome(run.id, "abandoned", `Meegle 里已关（${status}），改动撤掉`);
  record({
    taskId: t.id,
    action: "closed_defect_discarded",
    why,
    how: !f ? "现场已经没有没进主干的改动，只收卡" : [`删了 worktree ${f.worktree}`, f.branch ? (res?.branchDeleted ? `删了分支 ${f.branch}` : `分支 ${f.branch} 没删掉`) : ""].filter(Boolean).join("，"),
    evidence: { worktree: f?.worktree ?? null, branch: f?.branch ?? null, ahead: f?.ahead ?? 0, dirty: f?.dirty ?? 0, pushed: f?.pushed ?? false },
    risk: "irreversible",
    status: "approved",
  });
  const { finishTask } = await import("./pipeline.js");
  return (await finishTask(t.id, "done", why))!;
}

/** 执行回退：只动 Friday 这次建的东西，删完在新项目上重开 */
export async function rollbackAndRestart(taskId: string, to: string): Promise<Task> {
  const t = getTask(taskId);
  if (!t) throw new Error("任务不存在了");
  if (!isFridayWork(t)) throw new Error("这条任务上没有 Friday 自主干的活，不用回退");
  const target = resolveProject(to);
  if (target.kind !== "match") throw new Error(`项目注册表里没有 ${to}`);
  const f = footprint(t);
  const merged = mergedWhy(f);
  if (merged) throw new Error(`${merged}，没法整体回退`);

  const { removed, branchDeleted } = await discardFootprint(f, `项目从 ${f.from} 改成 ${to}，回退 Friday 在旧项目上做的`, t.id);

  const run = runByJob(f.jobId);
  if (run && (!run.outcome || run.outcome === "pending")) setRunOutcome(run.id, "rejected", `项目判错：${f.from} → ${to}`);

  const next = updateTask(t.id, {
    project: target.project.name,
    status: "understood",
    stage: "todo",
    progress: `项目从 ${f.from} 改成 ${target.project.name}，Friday 在 ${f.from} 上做的已撤掉，重新开工`,
    report: undefined,
    attention: undefined,
    pending: (getTask(t.id)?.pending ?? []).filter((p) => p.type !== "git_merge" && p.type !== "reproject"),
    source: { projectBy: "user", jobId: undefined, autonomous: undefined, worktree: undefined, branch: undefined, repoDir: undefined },
  })!;
  record({
    taskId: t.id,
    action: "reproject_rollback",
    why: `你说项目判错了：${f.from} → ${target.project.name}`,
    how: [f.worktree ? `删了 worktree ${f.worktree}` : "", f.branch ? (branchDeleted ? `删了分支 ${f.branch}` : `分支 ${f.branch} 没删掉`) : "", "撤下交付与待审合并"].filter(Boolean).join("，"),
    evidence: { from: f.from, to: target.project.name, worktree: f.worktree ?? null, branch: f.branch ?? null, removed, branchDeleted, dirty: f.dirty },
    risk: "irreversible",
    status: "approved",
  });

  const { startAutonomousJob } = await import("./pipeline.js");
  const v = next.source.intake;
  const detail = v?.detail ?? next.plan?.split("\n").find((l) => l.trim()) ?? next.title;
  return startAutonomousJob(next, target.project.name, target.project.dir, usableBriefDetail(next) ?? `${detail}\n\n背景：${next.understanding ?? ""}`, "retry");
}
