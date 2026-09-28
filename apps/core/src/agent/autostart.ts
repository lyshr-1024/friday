import type { Task } from "@friday/shared";
import { listAudit, record } from "../memory/audit.js";
import { getJob } from "../memory/jobs.js";
import { resolveProject } from "../memory/projects.js";
import { listTasks } from "../memory/tasks.js";
import { state } from "../scheduler/index.js";
import { userSettings } from "../settings.js";
import { startAutonomousJob } from "./pipeline.js";

/**
 * Friday 自己开自主任务的门禁。看的是「这次交付被直接收下的概率」，不是时间：
 * worktree + 守卫 + 合并前审核已经把破坏面压到零，白干的代价只剩 token 和一份废报告。
 * 所以只接缺陷（需求要先对方案）、只接 intake 判成 start 且把握够高的、项目归属得是事实不是猜的。
 */
export const AUTOSTART_MIN_CONFIDENCE = 80;
export const AUTOSTART_MAX_RUNNING = 1;
export const AUTOSTART_PER_DAY = 3;
/** 缺陷刚建时描述常被反复改，等一个同步周期再开 */
export const AUTOSTART_SETTLE_MS = 15 * 60_000;

export interface AutostartEnv {
  now: number;
  running: number;
  startedToday: number;
}

export function eligible(t: Task, env: AutostartEnv): string | undefined {
  if (t.status !== "understood" || t.kind !== "meegle") return "不在排队里";
  if (t.source.meegleType !== "issue") return "不是缺陷";
  if (t.source.jobId) return "已经有终端";
  if (t.attention) return "卡上还挂着要你回答的问题";
  const v = t.source.intake;
  if (!v) return "还没判断过";
  if (v.kind !== "start") return `判成 ${v.kind}：${v.why}`;
  if ((v.confidence ?? 0) < AUTOSTART_MIN_CONFIDENCE) return `把握只有 ${v.confidence ?? 0}`;
  if (!t.project) return "没有项目归属";
  if (v.project !== t.project) return `intake 判的是 ${v.project}，卡上归 ${t.project}`;
  if (env.now - Date.parse(t.createdAt) < AUTOSTART_SETTLE_MS) return "刚进来，等描述稳定";
  return undefined;
}

/** 从排队的任务里挑出这一轮可以开的，按优先级、再按进来的先后，受并发和每日上限约束。 */
export function pickAutostart(tasks: Task[], env: AutostartEnv): Task[] {
  const slots = Math.min(AUTOSTART_MAX_RUNNING - env.running, AUTOSTART_PER_DAY - env.startedToday);
  if (slots <= 0) return [];
  const order = { high: 0, normal: 1, low: 2 } as Record<string, number>;
  return tasks
    .filter((t) => !eligible(t, env))
    .sort((a, b) => (order[a.priority] ?? 9) - (order[b.priority] ?? 9) || a.createdAt.localeCompare(b.createdAt))
    .slice(0, slots);
}

function runningAutonomous(): number {
  return listTasks("processing").filter((t) => t.source.autonomous && t.source.jobId && getJob(t.source.jobId)?.status === "running").length;
}

function startedSinceMidnight(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return listAudit({ since: d.toISOString(), limit: 500 }).filter((e) => e.action === "autostart").length;
}

/** 每轮 Meegle 同步后跑一次。开关关着就什么都不做。 */
export async function autostartTick(now = Date.now()): Promise<number> {
  if (!userSettings().autonomous) return 0;
  const env: AutostartEnv = { now, running: runningAutonomous(), startedToday: startedSinceMidnight(now) };
  let started = 0;
  for (const t of pickAutostart(listTasks("understood"), env)) {
    const v = t.source.intake!;
    const r = resolveProject(t.project!);
    if (r.kind !== "match") continue;
    record({
      taskId: t.id,
      action: "autostart",
      why: `缺陷描述够具体（把握 ${v.confidence}）：${v.why}`,
      how: `在 ${r.project.name} 上自主开工，没等你点`,
      evidence: { confidence: v.confidence, project: r.project.name, meegleId: t.source.meegleId ?? null },
      risk: "reversible",
    });
    await startAutonomousJob(t, r.project.name, r.project.dir, `${v.detail}\n\n背景：${t.understanding ?? ""}`);
    state.notices.push({ title: `Friday 自己开工了 · ${r.project.name}`, body: t.title.slice(0, 120), taskId: t.id });
    started++;
  }
  return started;
}
