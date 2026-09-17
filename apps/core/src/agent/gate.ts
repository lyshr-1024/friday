import type { Lesson, LessonKind, ThreadBrief } from "@friday/shared";

export const DEFAULT_THRESHOLD = 100;
export const MIN_THRESHOLD = 60;
export const WINDOW = 20;

export function decide(brief: ThreadBrief, threshold: number): "auto" | "queue" {
  // 阈值封顶 100：到顶等于关掉自动发送，不能让模型自评满分把它绕过去。
  if (threshold >= 100) return "queue";
  return brief.needsReply && brief.reply && brief.confidence >= threshold ? "auto" : "queue";
}

/**
 * 自己开工改代码的闸门。和回复共用阈值表与校准逻辑，默认同样是 100（全部挂起等人点）——
 * 用户看下来觉得判得准了，把阈值调下来它才开始自己开。
 */
export function decideStart(confidence: number, threshold: number): "auto" | "queue" {
  if (threshold >= 100) return "queue";
  return confidence >= threshold ? "auto" : "queue";
}

/** 负信号按代价大小抬阈值：已发出去要撤回最重，你自己回了 / 自己敲进终端最轻 */
const BACKOFF: Record<string, number> = { auto_undone: 20, rejected: 10, ignored: 10, done_without_reply: 5, relayed_direct: 5 };

export function backoff(threshold: number, kind: LessonKind): number {
  return Math.min(100, threshold + (BACKOFF[kind] ?? 0));
}

export interface Stats {
  total: number;
  approved: number;
  calibrationError: number;
}

export function stats(lessons: Lesson[]): Stats {
  const window = lessons.slice(0, WINDOW);
  const total = window.length;
  const approved = window.filter((l) => l.kind === "approved").length;
  if (!total) return { total: 0, approved: 0, calibrationError: 0 };
  const avgConfidence = window.reduce((sum, l) => sum + l.confidence, 0) / total;
  return { total, approved, calibrationError: Math.abs(avgConfidence - (approved / total) * 100) };
}

export function suggest(current: number, s: Stats): number | undefined {
  if (s.total < WINDOW || s.approved / s.total < 0.9 || s.calibrationError >= 10) return undefined;
  return current - 10 >= MIN_THRESHOLD ? current - 10 : undefined;
}
