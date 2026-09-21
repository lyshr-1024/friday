import type { TerminalState } from "@friday/shared";
import type { Task } from "@friday/shared";
import { finishJob, getJob, reapStaleJobs } from "../memory/jobs.js";
import { record } from "../memory/audit.js";
import { closeTerminalById, inputText, isAlive } from "./ghostty.js";
import { publish } from "../bus.js";

/**
 * Friday 往终端里说话。
 *
 * 内嵌 PTY 时代能直接往文件描述符写字节，还能靠「最近 3 秒有没有输出」判断忙闲。换成外部
 * Ghostty 窗口之后两样都没了：只能走 AppleScript 注入，忙闲只能靠 Stop hook——它每轮结束
 * 都会回报一次，收到就是这轮说完了。
 *
 * 判不准的时候直接发：Claude Code 忙时输入会进它自己的缓冲区，不会丢，最多是晚一轮被读到。
 * 这比攒在 Friday 这边等一个可能永远不来的信号好。
 */

/** 最近一次 Stop hook 的时间：有记录且晚于上次说话 = 这轮说完了 */
const lastStop = new Map<string, number>();
const lastSaid = new Map<string, number>();

/** Stop hook 到了：这轮说完了。 */
export function markStop(jobId: string): void {
  lastStop.set(jobId, Date.now());
}

/** 说完这轮了没。没有任何 Stop 记录时按「说完了」算——宁可直接发，也不要攒着不发。 */
export function isIdle(jobId: string): boolean {
  const stop = lastStop.get(jobId);
  const said = lastSaid.get(jobId);
  if (stop === undefined) return true;
  return said === undefined || stop > said;
}

export type SayResult = "sent" | "no-terminal";

/**
 * 往这条 job 的 Ghostty 窗口里说一句。窗口已经关掉就返回 no-terminal，调用方据此改口径。
 * 不再有 queued：外部窗口攒着没意义，Claude Code 自己的缓冲区比 Friday 这边更可靠。
 */
export async function say(jobId: string, text: string): Promise<SayResult> {
  const job = getJob(jobId);
  if (!job?.ghosttyId || job.status !== "running") return "no-terminal";
  // 窗口可能已经被关掉，而 job 还标着 running：先问一句，免得谎报「已转达」
  if (!(await isAlive(job.ghosttyId))) {
    finishJob(jobId, 0);
    publish({ type: "terminal", jobId, state: "gone" });
    return "no-terminal";
  }
  const ok = await inputText(job.ghosttyId, text);
  if (!ok) return "no-terminal";
  lastSaid.set(jobId, Date.now());
  return "sent";
}

/** 任务卡上显示用：窗口还在不在、这轮说完了没。 */
export function terminalState(jobId: string): TerminalState {
  const job = getJob(jobId);
  if (!job || job.status !== "running") return "gone";
  return isIdle(jobId) ? "idle" : "busy";
}

/**
 * 扫一遍还标着 running 的 job，窗口已经没了的收尾并推给前端。
 *
 * 用户 ⌘W 手动关掉窗口没有任何回调，不主动问一句就永远发现不了——卡片上那圈光
 * 会一直跑、「N 个终端在跑」也一直算着它。所以定时扫 + 工作台窗口聚焦时扫。
 * 每个 job 一次 osascript，所以不放在读状态的路径上（任务板 30 秒一拉还有 SSE，
 * 摊到每次渲染就太贵了）。
 */
export async function sweepClosedTerminals(): Promise<string[]> {
  const dead = await reapStaleJobs(isAlive);
  for (const jobId of dead) publish({ type: "terminal", jobId, state: "gone" });
  return dead;
}

/**
 * 窗口可能被你手动关掉，而 job 还标着 running。问一次 Ghostty，关了就收尾。
 * 要跑 osascript，所以只在真正需要准确值的地方调（任务卡刷新、说话之前）。
 */
export async function refreshTerminalState(jobId: string): Promise<TerminalState> {
  const job = getJob(jobId);
  if (!job || job.status !== "running") return "gone";
  if (!job.ghosttyId) return isIdle(jobId) ? "idle" : "busy";
  if (await isAlive(job.ghosttyId)) return isIdle(jobId) ? "idle" : "busy";
  finishJob(jobId, 0);
  publish({ type: "terminal", jobId, state: "gone" });
  return "gone";
}

/**
 * 关掉一个终端：关 Ghostty 窗口（里面的 Claude Code 跟着结束），job 收尾并记账。
 * taskId 可选——手动关终端时任务不一定还在。
 */
export async function closeJobTerminal(jobId: string, why: string, taskId?: string): Promise<boolean> {
  const job = getJob(jobId);
  const closed = job?.ghosttyId ? await closeTerminalById(job.ghosttyId) : false;
  if (job?.status === "running") finishJob(jobId, 0);
  if (closed || job?.status === "running") {
    record({
      ...(taskId ? { taskId } : {}),
      action: "terminal_closed",
      why,
      how: closed ? "关掉 Ghostty 窗口，job 收尾" : "job 收尾（窗口已不在）",
      evidence: { jobId, project: job?.project ?? null },
      risk: "reversible",
    });
  }
  lastStop.delete(jobId);
  lastSaid.delete(jobId);
  // 返回值表示「有没有真的关掉一个还开着的窗口」——job 收尾不算
  return closed;
}

export async function closeTaskTerminal(task: Pick<Task, "id" | "source">, why: string): Promise<boolean> {
  const jobId = task.source.jobId;
  if (!jobId) return false;
  return closeJobTerminal(jobId, why, task.id);
}

export const TERMINAL_STATE_LABEL: Record<TerminalState, string> = {
  busy: "终端还在这一轮里干活",
  idle: "终端说完了，在等你",
  gone: "终端已经关掉了",
};
