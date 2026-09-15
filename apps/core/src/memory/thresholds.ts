import { AUTOSTART_CATEGORY, REPLY_CATEGORIES, type GateCategory } from "@friday/shared";
import { DEFAULT_THRESHOLD } from "../agent/gate.js";
import { db } from "./db.js";

export function getThreshold(category: GateCategory): number {
  const row = db().prepare("SELECT value FROM thresholds WHERE category = ?").get(category) as { value: number } | undefined;
  return row?.value ?? DEFAULT_THRESHOLD;
}

export function setThreshold(category: GateCategory, value: number): void {
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  db()
    .prepare("INSERT INTO thresholds (category, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(category) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(category, clamped, new Date().toISOString());
}

export const GATE_CATEGORIES: GateCategory[] = [...REPLY_CATEGORIES, AUTOSTART_CATEGORY];

export function allThresholds(): Record<GateCategory, number> {
  return Object.fromEntries(GATE_CATEGORIES.map((c) => [c, getThreshold(c)])) as Record<GateCategory, number>;
}
