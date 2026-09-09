import type { TerminalState } from "@friday/shared";
import { getJob } from "../memory/jobs.js";
import { getSession, write } from "./pty.js";

/**
 * Friday 往内嵌终端里说话。终端里的 Claude Code 正在输出时不能插话（会插进它的帧里），
 * 所以只在它空闲时敲。忙不忙直接看 PTY 有没有在输出：Claude Code 干活时 spinner 每 100ms
 * 重绘一帧，空闲时画面完全静止——比 Stop hook + 输入时序可靠（那两个方向都漏过）。
 * 忙就先攒着，安静下来再送。
 */
// 模型思考时偶尔有 2 秒左右的静默间隙，3 秒才算真安静
export const QUIET_MS = 3000;
const pending = new Map<string, string[]>();
const pollers = new Map<string, ReturnType<typeof setInterval>>();

/** 最近 quietMs 内没有输出 = 空闲 */
export function quietFor(lastOutputAt: number | undefined, now = Date.now(), quietMs = QUIET_MS): boolean {
  return now - (lastOutputAt ?? 0) >= quietMs;
}

export function isIdle(jobId: string): boolean {
  const live = getSession(jobId);
  if (!live || live.exited !== undefined) return false;
  return quietFor(live.lastOutputAt);
}

// 文本和回车分两次写：连着发 Claude Code 会把整串当成粘贴，尾随的回车变成换行留在输入框里不提交
const ENTER_DELAY_MS = 200;

function send(jobId: string, text: string): boolean {
  const ok = write(jobId, text);
  if (!ok) return false;
  setTimeout(() => write(jobId, "\r"), ENTER_DELAY_MS);
  return true;
}

function flush(jobId: string): void {
  const queue = pending.get(jobId);
  if (!queue?.length) {
    stopPoller(jobId);
    return;
  }
  if (!isIdle(jobId)) return;
  const next = queue.shift()!;
  if (!send(jobId, next)) {
    pending.delete(jobId);
    stopPoller(jobId);
  }
  if (!queue.length) stopPoller(jobId);
}

function stopPoller(jobId: string): void {
  const t = pollers.get(jobId);
  if (t) clearInterval(t);
  pollers.delete(jobId);
}

/** Stop hook 到了也试着送一次；主要靠轮询等它安静 */
export function markStop(jobId: string): void {
  flush(jobId);
}

export type SayResult = "sent" | "queued" | "no-terminal";

export function say(jobId: string, text: string): SayResult {
  const live = getSession(jobId);
  if (!live || live.exited !== undefined) return "no-terminal";
  if (isIdle(jobId)) return send(jobId, text) ? "sent" : "no-terminal";
  pending.set(jobId, [...(pending.get(jobId) ?? []), text]);
  if (!pollers.has(jobId)) pollers.set(jobId, setInterval(() => flush(jobId), 1000));
  return "queued";
}

/** 任务卡上显示用：终端到底在不在、在不在干活 */
export function terminalState(jobId: string): TerminalState {
  const live = getSession(jobId);
  if (live && live.exited === undefined) return isIdle(jobId) ? "idle" : "busy";
  const job = getJob(jobId);
  if (!job || job.status !== "running") return "gone";
  // 内嵌 PTY 只活在 sidecar 内存里，重启就没了而 job 仍是 running：这是「断了」不是「在外面跑」。老记录没记类型，按内嵌算。
  return job.terminal && job.terminal !== "embedded" ? "external" : "gone";
}

export const TERMINAL_STATE_LABEL: Record<TerminalState, string> = {
  busy: "终端在输出",
  idle: "终端空闲，等指示",
  gone: "终端已断（Friday 重启过，进程已经不在了，要在任务卡上「重新打开终端」才能继续）",
  external: "在外部终端里跑，Friday 看不到过程",
};

export function pendingCount(jobId: string): number {
  return pending.get(jobId)?.length ?? 0;
}

/** 测试用：清掉某个 job 的状态 */
export function resetTerminalState(jobId: string): void {
  pending.delete(jobId);
  stopPoller(jobId);
}
