import { STAGE_LABEL, briefRefusal, taskCategory, type AutostartPlan, type Task, type TermSession } from "@friday/shared";
import { record } from "../memory/audit.js";
import { getCursor, setCursor } from "../memory/inbox.js";
import { getJob } from "../memory/jobs.js";
import { isFridayProject, loadProjects, resolveProject } from "../memory/projects.js";
import { listTasks, updateTask } from "../memory/tasks.js";
import { OPEN_STATUS, fixCardOf, storyOf } from "./story.js";
import { state } from "../scheduler/index.js";
import { userSettings } from "../settings.js";
import { getTermSession } from "../memory/termSessions.js";
import { briefBasis, briefDetail, briefPolicy, reviewFor } from "./brief.js";
import { briefBuilding } from "./briefJob.js";
import { createFixCard, handToStorySession, startAutonomousJob, startFixCard } from "./pipeline.js";
import { resolveRoot } from "./sessions.js";
import { TmuxMissingError } from "./tmux.js";

/**
 * Friday 自己开自主任务的门禁。看的是「这次交付被直接收下的概率」，不是时间：
 * worktree + 守卫 + 合并前审核已经把破坏面压到零，白干的代价只剩 token 和一份废报告。
 * 需求（和没挂需求的缺陷）走一条：要有理解卡，审过（或按项目规则不用审）、没过期、依赖齐了才开。
 * 挂在需求下的缺陷不走这条，跟着需求修（defectRoute）。
 */
export interface AutostartEnv {
  now: number;
  running: number;
  /** 设置里的「同时最多几条」 */
  max: number;
  /** 缺陷所属的需求；缺省按 storyOf 找 */
  root?: (t: Task) => Task | undefined;
  /** 任务根会话；缺省按 resolveRoot 找 */
  session?: (t: Task) => TermSession | undefined;
  /** 缺陷路由用的环境：一次请求建一个，查过的需求和修复卡记着，不每条任务扫一遍全表 */
  story?: StoryEnv;
}

export interface StoryEnv {
  /** 缺陷挂在哪张需求下（收没收工都算） */
  story: (t: Task) => Task | undefined;
  /** 这张需求还没收工的修复卡 */
  fixCard: (story: Task) => Task | undefined;
  /** 还没关的会话（可能还在准备、没 worktree） */
  session: (id: string) => TermSession | undefined;
  /** 这个会话里还有一组缺陷没修完 */
  occupied: (unitId: string) => boolean;
  /** 每天几点开修复卡 */
  batchAt: string;
}

const isOpenTask = (t: Task | undefined): t is Task => Boolean(t && OPEN_STATUS.has(t.status));

const openSessionOf = (id: string): TermSession | undefined => {
  const s = getTermSession(id);
  return s && s.status !== "closed" ? s : undefined;
};

const defaultSession = (t: Task): TermSession | undefined => getTermSession(resolveRoot(t).id);

export function storyEnv(): StoryEnv {
  const stories = new Map<string, Task | undefined>();
  let cards: Task[] | undefined;
  let busy: Set<string> | undefined;
  return {
    story: (t) => {
      if (!stories.has(t.id)) stories.set(t.id, storyOf(t));
      return stories.get(t.id);
    },
    fixCard: (story) => (cards ??= listTasks([...OPEN_STATUS], 2000).filter((x) => x.source.fixFor)).find((x) => x.source.fixFor === story.id),
    session: openSessionOf,
    occupied: (id) => (busy ??= new Set(listTasks("processing").filter((x) => x.source.handedAt && x.source.rootId).map((x) => x.source.rootId!))).has(id),
    batchAt: userSettings().defectBatchAt,
  };
}

const defaultStoryEnv = storyEnv;

export type DefectRoute = { kind: "hand"; unit: Task } | { kind: "wait"; unit: Task; why: string; batch: boolean };

/**
 * 挂在需求下、还在排队的缺陷往哪走（缺陷不单独建卡、不单独开工）：
 * 需求或它的修复卡有会话 → 整组交进去；都没有 → 等每天定点开修复卡一起修
 */
export function defectRoute(t: Task, env: StoryEnv = defaultStoryEnv()): DefectRoute | string {
  if (t.status !== "understood" && t.status !== "collected") return "不在排队里";
  const story = env.story(t);
  if (!story) return "不挂在需求下";
  if (t.source.jobId || t.source.handedAt) return "已经开过工";
  if (t.stage && t.stage !== "todo") return `已经在${STAGE_LABEL[t.stage]}`;
  if (t.attention) return "卡上还挂着要你回答的问题";
  if (t.source.autostartOff) return "你说了先别做";
  const card = env.fixCard(story);
  for (const unit of [isOpenTask(story) ? story : undefined, card]) {
    const s = unit && env.session(unit.id);
    if (!unit || !s) continue;
    // 准备段还没建好 worktree：等它，别另开修复卡（建了就成了孤儿）
    if (!s.worktree || s.status === "preparing") return { kind: "wait", unit, why: "等会话准备好", batch: false };
    // 你自己开的会话：只沿用原来「测试中、Claude 在跑」才敲字；别的时候往里敲回车会把你输入框里的半句话一起发出去
    if (s.kind === "interactive" && (unit.stage !== "testing" || s.status !== "running")) return { kind: "wait", unit, why: `会话是你开的，Friday 不往里敲；说「#${t.seq} 开工」交进去`, batch: false };
    return env.occupied(unit.id) ? { kind: "wait", unit, why: "等前一组修完", batch: false } : { kind: "hand", unit };
  }
  return { kind: "wait", unit: card ?? story, why: `每天 ${env.batchAt} 跟同需求的缺陷一起修`, batch: true };
}

/** 能交代进会话的，按会话分组：一个会话一次交一组 */
export function pickDefectGroups(tasks: Task[], env: StoryEnv = defaultStoryEnv()): Array<{ unit: Task; defects: Task[] }> {
  const groups = new Map<string, { unit: Task; defects: Task[] }>();
  for (const t of tasks) {
    const r = defectRoute(t, env);
    if (typeof r === "string" || r.kind !== "hand") continue;
    const g = groups.get(r.unit.id) ?? { unit: r.unit, defects: [] };
    g.defects.push(t);
    groups.set(r.unit.id, g);
  }
  return [...groups.values()];
}

/** 需求和修复卡都没有会话的，按需求分组，到点开修复卡 */
export function pickBatchGroups(tasks: Task[], env: StoryEnv = defaultStoryEnv()): Array<{ story: Task; card?: Task; defects: Task[] }> {
  const groups = new Map<string, { story: Task; card?: Task; defects: Task[] }>();
  for (const t of tasks) {
    const r = defectRoute(t, env);
    if (typeof r === "string" || r.kind !== "wait" || !r.batch) continue;
    const story = env.story(t)!;
    const g = groups.get(story.id) ?? { story, ...(r.unit.source.fixFor ? { card: r.unit } : {}), defects: [] };
    g.defects.push(t);
    groups.set(story.id, g);
  }
  return [...groups.values()];
}

/** 挂在需求下的缺陷：一律跟需求走，不建卡、不走通用门禁 */
export function yieldsToStory(t: Task, story: (t: Task) => Task | undefined = storyOf): boolean {
  return taskCategory(t.source) === "defect" && Boolean(story(t));
}

/** 需求（和没挂需求的缺陷）：理解卡审过（或按项目规则不用审）、没过期、依赖齐了就自己开，不看 intake */
export function codeEligible(t: Task, root: (t: Task) => Task | undefined = storyOf, session: (t: Task) => TermSession | undefined = defaultSession): string | undefined {
  if (t.status !== "understood" && t.status !== "collected") return "不在排队里";
  if (yieldsToStory(t, root)) return "跟所属需求一起修，不单独开工";
  const refusal = briefRefusal(t);
  if (refusal) return refusal;
  const b = t.source.brief;
  if (!b) return "还没有理解卡";
  if (b.review === "pending") return "理解卡等你审";
  if (b.review === "rejected") return "方案被打回了";
  if (b.project && b.project !== t.project) return "项目改了，理解卡要重建";
  if (b.stale || b.basis !== briefBasis(t)) return "需求变了，理解卡要重看";
  if (briefBuilding(t.id)) return "理解卡在重写";
  if (t.source.briefFailed) return "理解卡重建失败";
  if (b.review === "none" && reviewFor(b.size, briefPolicy(loadProjects().find((x) => x.name === t.project))) === "pending") return isFridayProject(t.project) ? "friday 项目的方案一律要你审" : "项目改成要审了";
  const waiting = b.deps.find((d) => d.status !== "ready");
  if (waiting) return `等 ${waiting.from ?? "别人"} 给 ${waiting.what}`;
  if (t.attention) return "卡上还挂着要你回答的问题";
  if (t.source.autostartOff) return "你说了先别做";
  const r = resolveProject(t.project!);
  if (r.kind !== "match") return `项目 ${t.project} 不在注册表里`;
  const s = session(t);
  if (s?.kind === "interactive" && s.status !== "closed") return "开着你的交互式会话，不往里敲字";
  return undefined;
}

/** 卡片上那句「Friday 会自己开工」：开关开着、除了并发都满足才有，behind 是前面还在跑的自主任务数。 */
export function autostartPlan(t: Task, env: AutostartEnv & { enabled: boolean }, routes?: StoryEnv): AutostartPlan | undefined {
  if (!env.enabled) return undefined;
  const se = routes ?? env.story;
  if (yieldsToStory(t, env.root ?? se?.story)) {
    const r = defectRoute(t, se);
    if (typeof r === "string") return undefined;
    return { kind: "story", at: new Date(env.now).toISOString(), root: { id: r.unit.id, title: r.unit.title }, ...(r.kind === "wait" ? { waiting: r.why } : {}) };
  }
  return codeEligible(t, env.root, env.session) ? undefined : { kind: "brief", at: new Date(env.now).toISOString(), behind: env.running };
}

/** 从排队的任务里挑出这一轮可以开的，按优先级、再按进来的先后，受并发约束。 */
export function pickAutostart(tasks: Task[], env: AutostartEnv): Task[] {
  const slots = env.max - env.running;
  if (slots <= 0) return [];
  const order = { high: 0, normal: 1, low: 2 } as Record<string, number>;
  return tasks
    .filter((t) => !codeEligible(t, env.root, env.session))
    .sort((a, b) => (order[a.priority] ?? 9) - (order[b.priority] ?? 9) || a.createdAt.localeCompare(b.createdAt))
    .slice(0, slots);
}

export function autostartEnv(now = Date.now()): AutostartEnv & { enabled: boolean } {
  const s = userSettings();
  return { now, running: runningAutonomous(), max: s.autonomousConcurrency, enabled: s.autonomous, story: storyEnv() };
}

export function runningAutonomous(): number {
  return listTasks("processing").filter((t) => t.source.autonomous && !t.source.scheduleId && !t.source.handedAt && t.source.jobId && getJob(t.source.jobId)?.status === "running").length;
}

/** 需求没有会话的缺陷：一进来就挂到修复卡上攒着（卡先不开工，到点再开），列表里收在卡下面 */
export function ensureFixCards(): number {
  let n = 0;
  for (const g of pickBatchGroups([...listTasks("understood"), ...listTasks("collected")])) {
    // 分组是循环前算的，这期间别处可能已经给这个需求建了卡
    const card = g.card ?? fixCardOf(g.story) ?? createFixCard(g.story, g.defects);
    for (const d of g.defects) {
      if (d.source.rootId === card.id) continue;
      updateTask(d.id, { source: { rootId: card.id } });
      n++;
    }
  }
  // 名下缺陷都走空了（交进了需求会话、被收掉）、自己又没开过工的修复卡：收掉，不留空卡
  const open = [...OPEN_STATUS];
  for (const card of listTasks(["understood", "collected"], 2000).filter((x) => x.source.fixFor && !x.source.jobId)) {
    if (listTasks(open, 2000).some((d) => d.source.rootId === card.id)) continue;
    updateTask(card.id, { status: "ignored", progress: "名下没有要修的缺陷了" });
    record({ taskId: card.id, action: "fix_card_dropped", why: "修复卡名下没有要修的缺陷了", how: "收掉空的修复卡", evidence: { storyId: card.source.fixFor }, risk: "reversible" });
  }
  return n;
}

/** 每轮 Meegle 同步后跑一次。开关关着就什么都不做。 */
export async function autostartTick(now = Date.now()): Promise<number> {
  if (!userSettings().autonomous) return 0;
  ensureFixCards();
  const env: AutostartEnv = { now, running: runningAutonomous(), max: userSettings().autonomousConcurrency };
  let started = 0;
  for (const { unit, defects } of pickDefectGroups([...listTasks("understood"), ...listTasks("collected")])) {
    try {
      const r = await handToStorySession(defects, unit);
      if (r === "handed") started += defects.length;
      else console.log(`[autostart] ${unit.title.slice(0, 40)}：会话${r === "busy" ? "在忙" : r === "asking" ? "在等你回答" : "不可用"}，${defects.length} 条缺陷本轮不转交`);
    } catch (e) {
      console.warn(`[autostart] ${unit.title.slice(0, 40)}：交代缺陷出错：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  for (const t of pickAutostart([...listTasks("understood"), ...listTasks("collected")], env)) {
    const brief = t.source.brief!;
    const r = resolveProject(t.project!);
    if (r.kind !== "match") continue;
    try {
      await startAutonomousJob(t, r.project.name, r.project.dir, briefDetail(t, brief), "autostart");
    } catch (e) {
      if (e instanceof TmuxMissingError) {
        console.warn(`[autostart] ${e.message}，本轮不再尝试`);
        break;
      }
      throw e;
    }
    record({
      taskId: t.id,
      action: "autostart",
      why: `理解卡${brief.review === "approved" ? "你审过" : "按项目规则不用审"}、依赖齐了`,
      how: `在 ${r.project.name} 上按理解卡自主开工，没等你点`,
      evidence: { review: brief.review, project: r.project.name, meegleId: t.source.meegleId ?? null },
      risk: "reversible",
    });
    state.notices.push({ title: `Friday 自己开工了 · ${r.project.name}`, body: t.title.slice(0, 120), taskId: t.id });
    started++;
  }
  return started;
}

const BATCH_KEY = "defects:batch:day";

const shanghai = (now: number): { day: string; hm: string } => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(now))
      .map((x) => [x.type, x.value]),
  );
  return { day: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
};

/** 需求和修复卡都没有会话的缺陷：每天到点（上海时间）按需求开一张修复卡，一组一起修。一天只跑一次 */
export async function defectBatchTick(now = Date.now()): Promise<number> {
  const s = userSettings();
  if (!s.autonomous) return 0;
  const { day, hm } = shanghai(now);
  if (hm < s.defectBatchAt || getCursor(BATCH_KEY) === day) return 0;
  let started = 0;
  for (const g of pickBatchGroups([...listTasks("understood"), ...listTasks("collected")])) {
    try {
      await startFixCard(g.card ?? fixCardOf(g.story) ?? createFixCard(g.story, g.defects), g.defects, "autostart");
      started += g.defects.length;
    } catch (e) {
      // tmux 没装：今天这批一条都开不了，不记「跑过」，装好后下一轮同步还能补上
      if (e instanceof TmuxMissingError) {
        console.warn(`[defects] ${e.message}，本轮不再尝试`);
        return started;
      }
      console.warn(`[defects] ${g.story.title.slice(0, 40)}：开修复卡出错：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  setCursor(BATCH_KEY, day);
  return started;
}

/**
 * 挂在需求下的缺陷不该有自己的合并动作和方案审批。老版本给需求开发期间直接开工的缺陷各挂了一份
 * 「合并需求分支」（同一条分支挂三遍），还有缺陷的理解卡等你审：启动时撤掉，别的待审动作不动
 */
export function tidyStoryDefects(): number {
  let n = 0;
  for (const t of listTasks([...OPEN_STATUS], 2000)) {
    if (!yieldsToStory(t)) continue;
    const before = t.pending ?? [];
    const keep = before.filter((p) => p.type !== "git_merge" && p.type !== "brief_approve");
    if (keep.length === before.length) continue;
    updateTask(t.id, { pending: keep });
    record({ taskId: t.id, action: "story_defect_tidied", why: "缺陷跟所属需求一起修，不单独合并、不单独审方案", how: `撤掉 ${before.filter((p) => !keep.includes(p)).map((p) => p.label).join("、")}`, evidence: { dropped: before.filter((p) => !keep.includes(p)).map((p) => p.type) }, risk: "reversible" });
    n++;
  }
  return n;
}
