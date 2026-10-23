import type { RunTrigger, Task } from "@friday/shared";
import { record } from "../memory/audit.js";
import { getJob } from "../memory/jobs.js";
import { resolveProject } from "../memory/projects.js";
import { getTask, listTasks, updateTask } from "../memory/tasks.js";
import { finishRun, openRunForTask, pendingRunsForTask, setRunOutcome } from "../memory/runs.js";
import { usableBriefDetail } from "./brief.js";
import { clearHanded } from "./handedBugs.js";
import { createFixCard, handToStorySession, startAutonomousJob, startFixCard } from "./pipeline.js";
import { defectRoute } from "./autostart.js";
import { fixCardOf, storyOf } from "./story.js";
import { getTermSession } from "../memory/termSessions.js";
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
  if (t.source.fixFor) return startFixCardNow(t, trigger);
  const story = storyOf(t);
  if (story) {
    // 缺陷不单独开工：交进需求（或修复卡）的会话，同需求排队的一起带上；都没会话就马上开修复卡
    const card = fixCardOf(story);
    const unit = [story.status === "done" || story.status === "ignored" ? undefined : story, card].find((u): u is Task => Boolean(u && liveUnitSession(u.id)));
    const group = [t, ...siblingsOf(story, t)];
    const preparing = [story, card].some((u) => u && getTermSession(u.id)?.status === "preparing");
    if (!unit && preparing) return { error: "会话还在准备，等它准备好再开工", status: 409 };
    if (!unit) return startCard(card ?? createFixCard(story, group), group, trigger, t.id);
    const prev = t.source.handedAt ? openRunForTask(t.id) : undefined;
    const pending = t.source.handedAt && t.status === "review" ? pendingRunsForTask(t.id) : [];
    const h = await handToStorySession(group, unit, { trigger });
    if (h === "handed") {
      // 卡住的那轮不算被你打回，不进学手册的证据
      for (const run of pending) setRunOutcome(run.id, "rejected", "你让它重新修");
      if (prev) finishRun(prev.id, { exit: "report" });
      return { task: getTask(t.id)! };
    }
    return { error: { busy: "会话里的 Claude 正在干活，等这一轮交付", asking: "终端在等你回答它的问题，答完再交", "no-session": "会话已不在，先开终端" }[h], status: 409 };
  }
  // 没挂需求的缺陷交付过 / 卡住了：清掉交接标记自己开工
  const mine = t.source.handedAt ? updateTask(t.id, clearHanded(t))! : t;
  // understanding 是「Meegle Requirement #x，节点「y」在等你」这种元信息复述，拿它当任务描述等于什么都没说；
  // intake 判过就用它写的描述，其次方案第一行，最后才是标题
  const detail = mine.source.intake?.detail ?? mine.plan?.split("\n").find((l) => l.trim()) ?? mine.title;
  const brief = usableBriefDetail(mine);
  try {
    const next = await startAutonomousJob(mine, r.project.name, r.project.dir, brief ?? `${detail}\n\n背景：${mine.understanding ?? ""}`, trigger);
    record({ taskId: t.id, action: "retry", why: "你点了开工", how: "Friday 在 worktree 里开工，中途你随时能在终端里插话", evidence: { previousJobId: t.source.jobId ?? null }, risk: "reversible" });
    return { task: next };
  } catch (e) {
    if (e instanceof TmuxMissingError) return { error: e.message, status: 400 };
    throw e;
  }
}

const liveUnitSession = (id: string): boolean => {
  const s = getTermSession(id);
  return Boolean(s && s.status !== "closed" && s.worktree);
};

const queued = () => [...listTasks("understood"), ...listTasks("collected")];

/** 同一个需求下、还在排队的别的缺陷：开工时一起带上 */
const siblingsOf = (story: Task, t: Task): Task[] => queued().filter((x) => x.id !== t.id && storyOf(x)?.id === story.id && typeof defectRoute(x) !== "string");

async function startCard(card: Task, group: Task[], trigger: RunTrigger, focus: string): Promise<StartResult> {
  try {
    const next = await startFixCard(card, group, trigger);
    return { task: getTask(focus) ?? next };
  } catch (e) {
    if (e instanceof TmuxMissingError) return { error: e.message, status: 400 };
    return { error: e instanceof Error ? e.message : String(e), status: 400 };
  }
}

/** 你对修复卡点「开工」：不等定点，名下排队的、交付了要重修的一起开 */
function startFixCardNow(card: Task, trigger: RunTrigger): Promise<StartResult> | StartResult {
  const story = card.source.fixFor ? getTask(card.source.fixFor) : undefined;
  const waiting = story ? queued().filter((x) => storyOf(x)?.id === story.id && typeof defectRoute(x) !== "string") : [];
  const redo = listTasks(["review", "blocked"]).filter((x) => x.source.rootId === card.id && x.source.handedAt);
  const group = [...waiting, ...redo];
  if (!group.length) return { error: "修复卡名下没有要修的缺陷", status: 409 };
  return startCard(card, group, trigger, card.id);
}
