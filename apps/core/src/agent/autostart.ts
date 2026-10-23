import { STAGE_LABEL, briefRefusal, taskCategory, workItemOf, type AutostartPlan, type Task, type TermSession } from "@friday/shared";
import { record } from "../memory/audit.js";
import { getJob } from "../memory/jobs.js";
import { isFridayProject, loadProjects, resolveProject } from "../memory/projects.js";
import { listTasks } from "../memory/tasks.js";
import { state } from "../scheduler/index.js";
import { userSettings } from "../settings.js";
import { getTermSession } from "../memory/termSessions.js";
import { briefBasis, briefDetail, briefPolicy, reviewFor } from "./brief.js";
import { briefBuilding } from "./briefJob.js";
import { handToStorySession, startAutonomousJob } from "./pipeline.js";
import { resolveRoot } from "./sessions.js";
import { TmuxMissingError } from "./tmux.js";

/**
 * Friday 自己开自主任务的门禁。看的是「这次交付被直接收下的概率」，不是时间：
 * worktree + 守卫 + 合并前审核已经把破坏面压到零，白干的代价只剩 token 和一份废报告。
 * 缺陷和需求同一条：要有理解卡，审过（或按项目规则不用审）、没过期、依赖齐了才开。
 */
export interface AutostartEnv {
  now: number;
  running: number;
  /** 设置里的「同时最多几条」 */
  max: number;
  /** 缺陷所属的需求；缺省按 resolveRoot 找 */
  root?: (t: Task) => Task | undefined;
  /** 任务根会话；缺省按 resolveRoot 找 */
  session?: (t: Task) => TermSession | undefined;
}

export interface StoryEnv {
  root: (t: Task) => Task | undefined;
  session: (rootId: string) => TermSession | undefined;
  occupied: (rootId: string) => boolean;
}

const defaultRoot = (t: Task): Task | undefined => {
  const r = resolveRoot(t);
  return r.id === t.id ? undefined : r;
};

const defaultSession = (t: Task): TermSession | undefined => getTermSession(resolveRoot(t).id);

const defaultStoryEnv: StoryEnv = {
  root: defaultRoot,
  session: getTermSession,
  occupied: (id) => listTasks("processing").some((x) => x.source.rootId === id && x.source.handedAt),
};

export function testingStoryBug(t: Task, env: StoryEnv = defaultStoryEnv): { root: Task } | string {
  if (t.status !== "understood" || t.kind !== "work_item") return "不在排队里";
  if (taskCategory(t) !== "defect") return "不是缺陷";
  if (t.source.jobId) return "已经有终端";
  if (t.stage && t.stage !== "todo") return `已经在${STAGE_LABEL[t.stage]}`;
  if (t.attention) return "卡上还挂着要你回答的问题";
  if (t.source.autostartOff) return "你说了先别做";
  const root = env.root(t);
  if (!root) return "不挂在需求下";
  if (root.stage !== "testing") return `需求「${root.title}」不在测试中`;
  const s = env.session(root.id);
  if (!s) return "需求没有会话，Friday 不知道分支在哪";
  if (s.status === "closed") return "需求会话已关";
  if (!s.worktree) return "需求会话没有 worktree";
  if (env.occupied(root.id)) return "等前一条修完";
  return { root };
}

const SESSION_GONE = "需求会话不在，先给需求开终端";
/** 需求在测试中、却因为这些原因接不了：卡上要看得到 */
const STORY_WAITING: Record<string, string> = {
  "等前一条修完": "等前一条修完",
  "需求没有会话，Friday 不知道分支在哪": SESSION_GONE,
  "需求会话已关": SESSION_GONE,
  "需求会话没有 worktree": SESSION_GONE,
};

export function storyPlan(t: Task, env: StoryEnv & { enabled: boolean }, now = Date.now()): AutostartPlan | undefined {
  if (!env.enabled) return undefined;
  const root = env.root(t);
  const r = testingStoryBug(t, { ...env, root: () => root });
  const at = new Date(now).toISOString();
  if (typeof r !== "string") return { kind: "story", at, root: { id: r.root.id, title: r.root.title } };
  const waiting = STORY_WAITING[r];
  return waiting && root ? { kind: "story", at, root: { id: root.id, title: root.title }, waiting } : undefined;
}

export function pickStoryBugs(tasks: Task[], env: StoryEnv = defaultStoryEnv): Array<{ task: Task; root: Task }> {
  const order = { high: 0, normal: 1, low: 2 } as Record<string, number>;
  const byRoot = new Map<string, { task: Task; root: Task }>();
  const passed = tasks.flatMap((task) => {
    const r = testingStoryBug(task, env);
    return typeof r === "string" ? [] : [{ task, root: r.root }];
  });
  passed.sort((a, b) => (order[a.task.priority] ?? 9) - (order[b.task.priority] ?? 9) || a.task.createdAt.localeCompare(b.task.createdAt));
  for (const p of passed) if (!byRoot.has(p.root.id)) byRoot.set(p.root.id, p);
  return [...byRoot.values()];
}

/** 缺陷挂在测试中的需求下：不管此刻交代得了交代不了，都走需求会话那条路，不建卡、不走通用门禁 */
export function yieldsToStory(t: Task, root: (t: Task) => Task | undefined = defaultRoot): boolean {
  return taskCategory(t) === "defect" && root(t)?.stage === "testing";
}

/** 缺陷和需求同一条：理解卡审过（或按项目规则不用审）、没过期、依赖齐了就自己开，不看 intake */
export function codeEligible(t: Task, root: (t: Task) => Task | undefined = defaultRoot, session: (t: Task) => TermSession | undefined = defaultSession): string | undefined {
  if (t.status !== "understood" && t.status !== "collected") return "不在排队里";
  const refusal = briefRefusal(t);
  if (refusal) return refusal;
  if (yieldsToStory(t, root)) return "需求在测试中，走需求会话那条路";
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
export function autostartPlan(t: Task, env: AutostartEnv & { enabled: boolean }): AutostartPlan | undefined {
  if (!env.enabled) return undefined;
  const story = storyPlan(t, { ...defaultStoryEnv, enabled: true }, env.now);
  if (story) return story;
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
  return { now, running: runningAutonomous(), max: s.autonomousConcurrency, enabled: s.autonomous };
}

export function runningAutonomous(): number {
  return listTasks("processing").filter((t) => t.source.autonomous && !t.source.scheduleId && !t.source.handedAt && t.source.jobId && getJob(t.source.jobId)?.status === "running").length;
}

/** 每轮 Meegle 同步后跑一次。开关关着就什么都不做。 */
export async function autostartTick(now = Date.now()): Promise<number> {
  if (!userSettings().autonomous) return 0;
  const env: AutostartEnv = { now, running: runningAutonomous(), max: userSettings().autonomousConcurrency };
  let started = 0;
  for (const { task, root } of pickStoryBugs(listTasks("understood"))) {
    try {
      const r = await handToStorySession(task, root);
      if (r === "handed") started++;
      else console.log(`[autostart] ${task.title.slice(0, 40)}：需求会话${r === "busy" ? "在忙" : r === "asking" ? "在等你回答" : "不可用"}，本轮不转交`);
    } catch (e) {
      console.warn(`[autostart] ${task.title.slice(0, 40)}：交代进需求会话出错：${e instanceof Error ? e.message : String(e)}`);
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
      evidence: { review: brief.review, project: r.project.name, workItemId: workItemOf(t.source)?.id ?? null },
      risk: "reversible",
    });
    state.notices.push({ title: `Friday 自己开工了 · ${r.project.name}`, body: t.title.slice(0, 120), taskId: t.id });
    started++;
  }
  return started;
}
