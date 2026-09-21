import type { RollbackReason, Stage, StageHint, Task } from "@friday/shared";
import { STAGE_ORDER, STAGE_LABEL } from "@friday/shared";
import { getTask, updateTask } from "../memory/tasks.js";
import { listAudit, record } from "../memory/audit.js";
import { signalScore, bumpSignal } from "../memory/stageSignals.js";

/** 弱信号问够这么多次、且从没被否过，就升级成强信号直接推 */
export const PROMOTE_AFTER = 3;

export const stageIndex = (s: Stage): number => STAGE_ORDER.indexOf(s);

/** 往前走才叫推进。相等或往回都不是 */
export function isAdvance(from: Stage | undefined, to: Stage): boolean {
  return stageIndex(to) > stageIndex(from ?? "todo");
}

/**
 * 一条信号够不够硬。强信号直接推，弱信号先问一句。
 * 弱信号被确认够 PROMOTE_AFTER 次且一次没被否过，就当强信号用。
 */
export function isStrong(signal: string, score: { confirmed: number; rejected: number }): boolean {
  if (STRONG_SIGNALS.has(signal)) return true;
  return score.rejected === 0 && score.confirmed >= PROMOTE_AFTER;
}

/**
 * 这些信号是本机能直接看到的事实，不依赖别人及时更新，所以直接推。
 * MR 建了、Slack 里说验收通过这些不在里面——前者不等于提测，后者依赖对方发言。
 */
export const STRONG_SIGNALS = new Set(["branch_commit", "terminal_delivered", "user_said"]);

export interface StageSignal {
  signal: string;
  to: Stage;
  /** 弱信号时卡片上问的那句话 */
  ask: string;
  why: string;
}

/** 推进的结果：真推了，还是只挂了一问 */
export type StageOutcome = { kind: "advanced"; task: Task } | { kind: "asked"; task: Task } | { kind: "skipped"; why: string };

/**
 * 收到一条信号。强信号直接推并记账（可撤回），弱信号挂一问等用户答。
 * 只往前推，不自动往回拨——往回拨错了你会以为活退回去了，代价比往前推错大得多。
 */
export function onSignal(taskId: string, sig: StageSignal): StageOutcome {
  const t = getTask(taskId);
  if (!t) return { kind: "skipped", why: "任务不在了" };
  if (!t.stage) return { kind: "skipped", why: "这条任务没有阶段（Slack 回消息类不走阶段）" };
  if (!isAdvance(t.stage, sig.to)) return { kind: "skipped", why: `${STAGE_LABEL[t.stage]} 不该往 ${STAGE_LABEL[sig.to]} 推` };

  if (!isStrong(sig.signal, signalScore(sig.signal))) {
    const hint: StageHint = { to: sig.to, ask: sig.ask, signal: sig.signal, at: new Date().toISOString() };
    return { kind: "asked", task: updateTask(taskId, { stageHint: hint })! };
  }
  return { kind: "advanced", task: advance(t, sig.to, "auto", sig.why, sig.signal) };
}

function advance(t: Task, to: Stage, by: "auto" | "user", why: string, signal?: string): Task {
  const at = new Date().toISOString();
  const next = updateTask(t.id, {
    stage: to,
    stageBy: by,
    stageAt: at,
    stagePrev: t.stage,
    stageHint: undefined,
    // released 是终态：上线了这条就算完，从板上收走
    ...(to === "released" ? { status: "done" as const, releasedAt: at } : {}),
  })!;
  record({
    taskId: t.id,
    action: "stage_advance",
    why,
    how: `${t.stage ? STAGE_LABEL[t.stage] : "无"} → ${STAGE_LABEL[to]}`,
    evidence: { from: t.stage ?? null, to, by, ...(signal ? { signal } : {}) },
    risk: "reversible",
    undo: { kind: "stage_set", taskId: t.id, stage: t.stage ?? null },
  });
  return next;
}

/** 用户自己把阶段拨到某一档。想拨哪就拨哪，不限方向——测试打回是常事 */
export function setStage(taskId: string, to: Stage, reason?: RollbackReason, note?: string): Task | undefined {
  const t = getTask(taskId);
  if (!t) return undefined;
  if (t.stage === to) return t;

  // 往回拨：分清是 Friday 推错了还是真被打回了。
  // 推错了要学，被打回是客观事实，学了只会让它越来越不敢推。
  if (!isAdvance(t.stage, to)) return rollback(t, to, reason ?? "bounced", note);
  return advance(t, to, "user", note ?? "你把阶段拨过去了");
}

function rollback(t: Task, to: Stage, reason: RollbackReason, note?: string): Task {
  const at = new Date().toISOString();
  const next = updateTask(t.id, {
    stage: to,
    stageBy: "user",
    stageAt: at,
    stagePrev: t.stage,
    stageHint: undefined,
    // 从「已上线」往回拨说明上线被回滚了，任务得回板上。stage 才是真相，status 只是「在不在板上」
    ...(t.stage === "released" ? { status: "review" as const, releasedAt: undefined } : {}),
    ...(note ? { progress: note } : {}),
  })!;

  // 只有「Friday 推错了」才进学习：把上次推到这儿的那条信号记一笔否。
  if (reason === "misjudged" && t.stageBy === "auto") {
    const sig = lastSignal(t.id);
    if (sig) bumpSignal(sig, "rejected");
  }
  record({
    taskId: t.id,
    action: "stage_rollback",
    why: note ?? (reason === "misjudged" ? "Friday 推错了阶段" : "这条被打回了"),
    how: `${t.stage ? STAGE_LABEL[t.stage] : "无"} → ${STAGE_LABEL[to]}`,
    evidence: { from: t.stage ?? null, to, reason, ...(note ? { note } : {}) },
    risk: "reversible",
    undo: { kind: "stage_set", taskId: t.id, stage: t.stage ?? null },
  });
  return next;
}

/** 用户答了卡片上那一问。答「是」就推过去，两种答案都算一次经验 */
export function answerHint(taskId: string, yes: boolean): Task | undefined {
  const t = getTask(taskId);
  if (!t?.stageHint) return t;
  const { to, signal } = t.stageHint;
  bumpSignal(signal, yes ? "confirmed" : "rejected");
  if (!yes) return updateTask(taskId, { stageHint: undefined });
  return advance(t, to, "auto", "你确认了 Friday 的判断", signal);
}

/** 找这条任务最近一次自动推进用的是哪个信号，撤回时要记到它头上 */
function lastSignal(taskId: string): string | undefined {
  const e = listAudit({ taskId, limit: 20 }).find((x) => x.action === "stage_advance" && x.evidence.by === "auto");
  return typeof e?.evidence.signal === "string" ? e.evidence.signal : undefined;
}

/**
 * 「验收通过」这类话。只认说得很死的几种——
 * 含糊的（「看起来没问题」「应该可以」）不算，它是弱信号，宁可漏判不要误判。
 */
const ACCEPTED = /(验收(通过|过了|完了|没问题|ok)|测试通过|测完了没问题|可以发布|可以上线|没问题了?可以发)/i;

export const saysAccepted = (text: string): boolean => ACCEPTED.test(text);

/**
 * Slack 里有人说验收过了，就给这条消息挂靠到的任务提一问。
 * 不直接推：说这话的是别人，也可能只是随口一句。
 * 比旧版可靠——挂靠是新链路算出来的真任务，不再依赖消息里贴没贴工单链接。
 */
export function onSlackAccepted(taskId: string, text: string, userName: string): StageOutcome {
  if (!saysAccepted(text)) return { kind: "skipped", why: "没说验收过" };
  return onSignal(taskId, {
    signal: "slack_accepted",
    to: "accepted",
    ask: `${userName} 在 Slack 里说验收过了，这条可以转「验收完待发布」吗？`,
    why: `${userName} 在 Slack 里说验收通过`,
  });
}
