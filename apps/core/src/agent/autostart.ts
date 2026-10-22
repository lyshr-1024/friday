import { STAGE_LABEL, briefRefusal, type AutostartPlan, type Task, type TermSession } from "@friday/shared";
import { record } from "../memory/audit.js";
import { getJob } from "../memory/jobs.js";
import { resolveProject } from "../memory/projects.js";
import { listTasks, updateTask } from "../memory/tasks.js";
import { state } from "../scheduler/index.js";
import { userSettings } from "../settings.js";
import { getTermSession } from "../memory/termSessions.js";
import { briefDetail } from "./brief.js";
import { handToStorySession, startAutonomousJob } from "./pipeline.js";
import { resolveRoot } from "./sessions.js";
import { TmuxMissingError } from "./tmux.js";

/**
 * Friday 自己开自主任务的门禁。看的是「这次交付被直接收下的概率」，不是时间：
 * worktree + 守卫 + 合并前审核已经把破坏面压到零，白干的代价只剩 token 和一份废报告。
 * 所以只接缺陷（需求要先对方案）、只接 intake 判成 start 且把握够高的、项目归属得是事实不是猜的。
 */
export const AUTOSTART_MAX_RUNNING = 1;
/** 缺陷刚建时描述常被反复改，等一个同步周期再开 */
export const AUTOSTART_SETTLE_MS = 15 * 60_000;

export interface AutostartEnv {
  now: number;
  running: number;
  /** 设置页「把握门槛」，intake 的 confidence 不低于它才开 */
  minConfidence: number;
  /** intake 判的项目在不在注册表里；缺省查 projects.md */
  knownProject?: (name: string) => boolean;
  /** 缺陷所属的需求；缺省按 resolveRoot 找 */
  root?: (t: Task) => Task | undefined;
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

const defaultStoryEnv: StoryEnv = {
  root: defaultRoot,
  session: getTermSession,
  occupied: (id) => listTasks("processing").some((x) => x.source.rootId === id && x.source.handedAt),
};

export function testingStoryBug(t: Task, env: StoryEnv = defaultStoryEnv): { root: Task } | string {
  if (t.status !== "understood" || t.kind !== "meegle") return "不在排队里";
  if (t.source.meegleType !== "issue") return "不是缺陷";
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

export function eligible(t: Task, env: AutostartEnv): string | undefined {
  if (t.status !== "understood" || t.kind !== "meegle") return "不在排队里";
  if (t.source.meegleType !== "issue") return "不是缺陷";
  if (t.source.jobId) return "已经有终端";
  if ((env.root ?? defaultRoot)(t)?.stage === "testing") return "需求在测试中，走需求会话那条路";
  // 只接还没开始的：测试中说明改过了在等测试，进行中说明你自己在改
  if (t.stage && t.stage !== "todo") return `已经在${STAGE_LABEL[t.stage]}`;
  if (t.attention) return "卡上还挂着要你回答的问题";
  const v = t.source.intake;
  if (!v) return "还没判断过";
  if (v.kind !== "start") return `判成 ${v.kind}：${v.why}`;
  if ((v.confidence ?? 0) < env.minConfidence) return `把握 ${v.confidence ?? 0}，门槛 ${env.minConfidence}`;
  if (t.source.autostartOff) return "你说了先别做";
  // 卡上没项目时用 intake 判的：判错了代价只是在错的仓库白跑一次，worktree 隔离着，改项目会整体回退
  if (!t.project) {
    if (!v.project) return "没有项目归属";
    if (!(env.knownProject ?? ((n) => resolveProject(n).kind === "match"))(v.project)) return `intake 判的 ${v.project} 不在项目注册表里`;
  } else if (t.source.projectBy !== "user" && v.project !== t.project) return `intake 判的是 ${v.project}，卡上归 ${t.project}`;
  if (env.now - Date.parse(t.createdAt) < AUTOSTART_SETTLE_MS) return "刚进来，等描述稳定";
  return undefined;
}

/** 需求：理解卡审过（或按项目规则不用审）、没过期、依赖齐了就自己开，不看 intake、不等稳定期 */
export function storyEligible(t: Task): string | undefined {
  if (t.status !== "understood" && t.status !== "collected") return "不在排队里";
  const refusal = briefRefusal(t);
  if (refusal) return refusal;
  const b = t.source.brief;
  if (!b) return "还没有理解卡";
  if (b.review === "pending") return "理解卡等你审";
  if (b.review === "rejected") return "方案被打回了";
  if (b.stale) return "需求变了，理解卡要重看";
  const waiting = b.deps.find((d) => d.status !== "ready");
  if (waiting) return `等 ${waiting.from ?? "别人"} 给 ${waiting.what}`;
  if (t.attention) return "卡上还挂着要你回答的问题";
  if (t.source.autostartOff) return "你说了先别做";
  return undefined;
}

/**
 * 卡片上那句「Friday 会自己开工 · HH:mm」：开关开着、除了「等描述稳定」和并发都满足才有。
 * at 是稳定期结束的时刻（已过就是现在），behind 是前面还在跑的自主任务数。
 */
export function autostartPlan(t: Task, env: AutostartEnv & { enabled: boolean }): AutostartPlan | undefined {
  if (!env.enabled) return undefined;
  const story = storyPlan(t, { ...defaultStoryEnv, enabled: true }, env.now);
  if (story) return story;
  if (t.source.brief) return storyEligible(t) ? undefined : { kind: "brief", at: new Date(env.now).toISOString(), behind: env.running };
  if (eligible(t, { ...env, now: Number.MAX_SAFE_INTEGER })) return undefined;
  const at = Math.max(env.now, Date.parse(t.createdAt) + AUTOSTART_SETTLE_MS);
  return { kind: "gate", at: new Date(at).toISOString(), behind: env.running };
}

/** 从排队的任务里挑出这一轮可以开的，按优先级、再按进来的先后，受并发约束。 */
export function pickAutostart(tasks: Task[], env: AutostartEnv): Task[] {
  const slots = AUTOSTART_MAX_RUNNING - env.running;
  if (slots <= 0) return [];
  const order = { high: 0, normal: 1, low: 2 } as Record<string, number>;
  return tasks
    .filter((t) => !eligible(t, env) || !storyEligible(t))
    .sort((a, b) => (order[a.priority] ?? 9) - (order[b.priority] ?? 9) || a.createdAt.localeCompare(b.createdAt))
    .slice(0, slots);
}

export function runningAutonomous(): number {
  return listTasks("processing").filter((t) => t.source.autonomous && !t.source.scheduleId && !t.source.handedAt && t.source.jobId && getJob(t.source.jobId)?.status === "running").length;
}

/**
 * 设置页调门槛时看的：排队里判成「可以开工」的缺陷有几条，按这个门槛能放进来几条。
 * 不看「刚进来等稳定」和并发——那两个只影响什么时候开，不影响开不开。
 */
export function previewAutostart(tasks: Task[], minConfidence: number): { pass: number; candidates: number } {
  const candidates = tasks.filter(
    (t) => t.status === "understood" && t.kind === "meegle" && t.source.meegleType === "issue" && t.source.intake?.kind === "start" && !t.source.jobId && (!t.stage || t.stage === "todo"),
  );
  const env: AutostartEnv = { now: Number.MAX_SAFE_INTEGER, running: 0, minConfidence };
  return { pass: candidates.filter((t) => !eligible(t, env)).length, candidates: candidates.length };
}

/** 每轮 Meegle 同步后跑一次。开关关着就什么都不做。 */
export async function autostartTick(now = Date.now()): Promise<number> {
  if (!userSettings().autonomous) return 0;
  const env: AutostartEnv = { now, running: runningAutonomous(), minConfidence: userSettings().autonomousMinConfidence };
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
    const brief = t.source.brief;
    if (brief && !storyEligible(t)) {
      const r = resolveProject(t.project!);
      if (r.kind !== "match") continue;
      const s = getTermSession(resolveRoot(t).id);
      if (s?.kind === "interactive" && s.status !== "closed") {
        console.log(`[autostart] ${t.title.slice(0, 40)}：开着你的交互式会话，不往里敲字，跳过`);
        continue;
      }
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
      continue;
    }
    const v = t.source.intake!;
    const r = resolveProject(t.project ?? v.project!);
    if (r.kind !== "match") continue;
    const s = getTermSession(resolveRoot(t).id);
    if (s?.kind === "interactive" && s.status !== "closed") {
      console.log(`[autostart] ${t.title.slice(0, 40)}：它的需求开着你的交互式会话，不往里敲字，跳过`);
      continue;
    }
    let task = t;
    if (!t.project) {
      task = updateTask(t.id, { project: r.project.name, source: { projectBy: "friday" } })!;
      record({ taskId: t.id, action: "project_guessed", why: `卡上没定项目，用 intake 判的（把握 ${v.confidence}）`, how: `归到 ${r.project.name}，不对就在会话里说，Friday 在它上面做的会整体撤掉`, evidence: { project: r.project.name, confidence: v.confidence ?? null }, risk: "reversible" });
    }
    try {
      await startAutonomousJob(task, r.project.name, r.project.dir, `${v.detail}\n\n背景：${t.understanding ?? ""}`, "autostart");
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
      why: `缺陷描述够具体（把握 ${v.confidence}）：${v.why}`,
      how: `在 ${r.project.name} 上自主开工，没等你点`,
      evidence: { confidence: v.confidence, project: r.project.name, meegleId: t.source.meegleId ?? null },
      risk: "reversible",
    });
    state.notices.push({ title: `Friday 自己开工了 · ${r.project.name}`, body: t.title.slice(0, 120), taskId: t.id });
    started++;
  }
  return started;
}
