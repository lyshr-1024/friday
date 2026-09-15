import { REPLY_CATEGORIES, type ReplyCategory } from "@friday/shared";
import { DEFAULT_THRESHOLD } from "../agent/gate.js";
import { db } from "./db.js";

export function getThreshold(category: ReplyCategory): number {
  const row = db().prepare("SELECT value FROM thresholds WHERE category = ?").get(category) as { value: number } | undefined;
  return row?.value ?? DEFAULT_THRESHOLD;
}

export function setThreshold(category: ReplyCategory, value: number): void {
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  db()
    .prepare("INSERT INTO thresholds (category, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(category) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(category, clamped, new Date().toISOString());
}

export function allThresholds(): Record<ReplyCategory, number> {
  return Object.fromEntries(REPLY_CATEGORIES.map((c) => [c, getThreshold(c)])) as Record<ReplyCategory, number>;
}
