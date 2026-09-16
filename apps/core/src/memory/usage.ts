import { randomUUID } from "node:crypto";
import type { UsageEntry, UsageRange, UsageSummary } from "@friday/shared";
import { db } from "./db.js";

/** 一次 Claude 调用的账：SDK 的 result 消息按模型分开报，一个模型一行。 */
export function addUsage(label: string, turns: number, models: Array<{ model: string; inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number; costUsd: number }>): void {
  if (!models.length) return;
  const at = new Date().toISOString();
  // 一次调用可能按模型落好几行，它们共享 call_id——并发调用会撞上同一毫秒，不能拿时间戳当次数
  const callId = randomUUID();
  const stmt = db().prepare("INSERT INTO usage (id, call_id, at, label, model, input_tokens, output_tokens, cache_read, cache_write, cost_usd, turns) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const m of models) stmt.run(randomUUID(), callId, at, label, m.model, m.inputTokens, m.outputTokens, m.cacheRead, m.cacheWrite, m.costUsd, turns);
}

/** 起算时刻：今天是本地零点，7d / 30d 从此刻往前推整天 */
export function rangeStart(range: UsageRange, now = new Date()): string {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  if (range === "7d") d.setDate(d.getDate() - 6);
  if (range === "30d") d.setDate(d.getDate() - 29);
  return d.toISOString();
}

interface Row {
  key: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  cost_usd: number;
}

const toEntry = (r: Row): UsageEntry => ({
  key: r.key,
  calls: r.calls,
  inputTokens: r.input_tokens,
  outputTokens: r.output_tokens,
  cacheRead: r.cache_read,
  cacheWrite: r.cache_write,
  costUsd: r.cost_usd,
});

const GROUP = `SELECT %COL% AS key, COUNT(DISTINCT call_id) AS calls, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
  SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write, SUM(cost_usd) AS cost_usd
  FROM usage WHERE at >= ? GROUP BY %COL% ORDER BY cost_usd DESC`;

export function usageSummary(range: UsageRange, now = new Date()): UsageSummary {
  const since = rangeStart(range, now);
  const byLabel = (db().prepare(GROUP.replaceAll("%COL%", "label")).all(since) as unknown as Row[]).map(toEntry);
  const byModel = (db().prepare(GROUP.replaceAll("%COL%", "model")).all(since) as unknown as Row[]).map(toEntry);
  const total = byLabel.reduce(
    (acc, e) => ({
      key: "total",
      calls: acc.calls + e.calls,
      inputTokens: acc.inputTokens + e.inputTokens,
      outputTokens: acc.outputTokens + e.outputTokens,
      cacheRead: acc.cacheRead + e.cacheRead,
      cacheWrite: acc.cacheWrite + e.cacheWrite,
      costUsd: acc.costUsd + e.costUsd,
    }),
    { key: "total", calls: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
  );
  return { range, since, total, byLabel, byModel };
}
