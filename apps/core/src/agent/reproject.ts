import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import type { Task } from "@friday/shared";
import { record } from "../memory/audit.js";
import { getJob } from "../memory/jobs.js";
import { resolveProject } from "../memory/projects.js";
import { runByJob, setRunOutcome } from "../memory/runs.js";
import { getTermSession } from "../memory/termSessions.js";
import { addPending, getTask, removePending, updateTask } from "../memory/tasks.js";
import { isMergedSync } from "./git.js";
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
    const task = updateTask(taskId, { project: to ?? undefined, source: { projectBy: "user" } })!;
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

  if (f.worktree && f.repoDir && existsSync(f.worktree)) {
    // 防呆：路径要是这个仓库登记过的 worktree，而且不是主仓本身
    const listed = (git(f.repoDir, ["worktree", "list", "--porcelain"]) ?? "")
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => real(l.slice(9)));
    if (real(f.worktree) === real(f.repoDir) || !listed.includes(real(f.worktree))) throw new Error(`${f.worktree} 不是这个仓库的 worktree，不删`);
  }

  await closeJobTerminal(f.jobId, `项目从 ${f.from} 改成 ${to}，回退 Friday 在旧项目上做的`, t.id);

  let removed = false;
  let branchDeleted = false;
  if (f.worktree && f.repoDir && existsSync(f.worktree)) {
    removed = git(f.repoDir, ["worktree", "remove", "--force", f.worktree]) !== undefined;
    git(f.repoDir, ["worktree", "prune"]);
    if (!removed) throw new Error(`worktree ${f.worktree} 删不掉，先别重开`);
  }
  if (f.branch && f.repoDir && !["main", "master"].includes(f.branch)) {
    branchDeleted = git(f.repoDir, ["branch", "-D", f.branch]) !== undefined;
  }

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
  return startAutonomousJob(next, target.project.name, target.project.dir, `${detail}\n\n背景：${next.understanding ?? ""}`, "retry");
}
