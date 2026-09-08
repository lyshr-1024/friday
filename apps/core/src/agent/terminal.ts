import type { TerminalState } from "@friday/shared";
import { getJob } from "../memory/jobs.js";
import { getSession, write } from "./pty.js";

/**
 * Friday 往内嵌终端里说话。终端里的 Claude Code 正在输出时不能插话（会插进它的帧里），
 * 所以只在它空闲时敲：上一次 Stop 之后没有新输入 = 空闲；忙就先攒着，下一次 Stop 到了再送。
 */
const lastStop = new Map<string, number>();
const lastInput = new Map<string, number>();
const pending = new Map<string, string[]>();

export function markStop(jobId: string): void {
  lastStop.set(jobId, Date.now());
  flush(jobId);
}

export function markInput(jobId: string): void {
  lastInput.set(jobId, Date.now());
}

export function isIdle(jobId: string): boolean {
  const stop = lastStop.get(jobId);
  const input = lastInput.get(jobId);
  if (stop !== undefined) return (input ?? 0) < stop;
  // 还没有过 Stop：带任务开场白的会话一起来就在干活，不算空闲；没带任务的交互式会话一起来就等着输入
  return input === undefined && !getJob(jobId)?.task;
}

// 文本和回车分两次写：连着发 Claude Code 会把整串当成粘贴，尾随的回车变成换行留在输入框里不提交
const ENTER_DELAY_MS = 200;

function send(jobId: string, text: string): boolean {
  const ok = write(jobId, text);
  if (!ok) return false;
  markInput(jobId);
  setTimeout(() => write(jobId, "\r"), ENTER_DELAY_MS);
  return true;
}

function flush(jobId: string): void {
  const queue = pending.get(jobId);
  const next = queue?.shift();
  if (next === undefined) return;
  if (!send(jobId, next)) pending.delete(jobId);
}

export type SayResult = "sent" | "queued" | "no-terminal";

export function say(jobId: string, text: string): SayResult {
  const live = getSession(jobId);
  if (!live || live.exited !== undefined) return "no-terminal";
  if (isIdle(jobId)) return send(jobId, text) ? "sent" : "no-terminal";
  pending.set(jobId, [...(pending.get(jobId) ?? []), text]);
  return "queued";
}

/** 任务卡上显示用：终端到底在不在、在不在干活 */
export function terminalState(jobId: string): TerminalState {
  const live = getSession(jobId);
  if (live && live.exited === undefined) return isIdle(jobId) ? "idle" : "busy";
  const job = getJob(jobId);
  // 从没在 sidecar 里开过 PTY 的运行中 job 是外部终端（Ghostty / Terminal）
  return job?.status === "running" && !live ? "external" : "gone";
}

export function pendingCount(jobId: string): number {
  return pending.get(jobId)?.length ?? 0;
}

/** 测试用：清掉某个 job 的状态 */
export function resetTerminalState(jobId: string): void {
  lastStop.delete(jobId);
  lastInput.delete(jobId);
  pending.delete(jobId);
}
