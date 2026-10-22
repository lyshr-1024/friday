import type { RunTrigger, Task } from "@friday/shared";
import { record } from "../memory/audit.js";
import { getJob } from "../memory/jobs.js";
import { resolveProject } from "../memory/projects.js";
import { getTask, updateTask } from "../memory/tasks.js";
import { finishRun, openRunForTask, pendingRunsForTask, setRunOutcome } from "../memory/runs.js";
import { clearHanded } from "./handedBugs.js";
import { handToStorySession, startAutonomousJob } from "./pipeline.js";
import { resolveRoot } from "./sessions.js";
import { TmuxMissingError } from "./tmux.js";

export type StartResult = { task: Task } | { error: string; status: 400 | 409 };

/**
 * 「开工」：一律由 Friday 驾驶（带守卫、可插话）。任务卡菜单、接口和会话里的 task_start 共用。
 * 你点的就开，不看自主开工的并发名额
 */
export async function startTask(t: Task, trigger: RunTrigger = "retry"): Promise<StartResult> {
  if (t.source.handedAt && t.status === "processing") return { error: "这条缺陷在需求会话里由 Friday 修，要插话就在需求终端里说", status: 409 };
  const project = t.project ?? (t.source.rootId ? getTask(t.source.rootId)?.project : undefined);
  if (!project) return { error: "任务没有关联项目，先选个项目", status: 400 };
  const r = resolveProject(project);
  if (r.kind !== "match") return { error: `找不到项目 ${project}`, status: 400 };
  const running = t.source.jobId ? getJob(t.source.jobId) : undefined;
  if (running?.status === "running") return { error: "这条任务已经有终端在跑了", status: 409 };
  const root = resolveRoot(t);
  if (root.id !== t.id && root.stage === "testing") {
    const prev = t.source.handedAt ? openRunForTask(t.id) : undefined;
    const pending = t.source.handedAt && t.status === "review" ? pendingRunsForTask(t.id) : [];
    const h = await handToStorySession(t, root, { trigger });
    if (h === "handed") {
      // 卡住的那轮不算被你打回，不进学手册的证据
      for (const run of pending) setRunOutcome(run.id, "rejected", "你让它重新修");
      if (prev) finishRun(prev.id, { exit: "report" });
      return { task: getTask(t.id)! };
    }
    return { error: { busy: "需求会话里的 Claude 正在干活，等这一轮交付", asking: "需求终端在等你回答它的问题，答完再交", "no-session": "需求会话已不在，先给需求开终端" }[h], status: 409 };
  }
  // 交付过 / 卡住的缺陷，需求已不在测试中：不再算交给需求会话的，自己开工
  const mine = t.source.handedAt ? updateTask(t.id, clearHanded(t))! : t;
  // understanding 是「Meegle Requirement #x，节点「y」在等你」这种元信息复述，拿它当任务描述等于什么都没说；
  // intake 判过就用它写的描述，其次方案第一行，最后才是标题
  const detail = mine.source.intake?.detail ?? mine.plan?.split("\n").find((l) => l.trim()) ?? mine.title;
  try {
    const next = await startAutonomousJob(mine, r.project.name, r.project.dir, `${detail}\n\n背景：${mine.understanding ?? ""}`, trigger);
    record({ taskId: t.id, action: "retry", why: "你点了开工", how: "Friday 在 worktree 里开工，中途你随时能在终端里插话", evidence: { previousJobId: t.source.jobId ?? null }, risk: "reversible" });
    return { task: next };
  } catch (e) {
    if (e instanceof TmuxMissingError) return { error: e.message, status: 400 };
    throw e;
  }
}
