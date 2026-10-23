import { randomBytes } from "node:crypto";
import type { Schedule, ScheduleInput } from "@friday/shared";
import { getTool } from "../connectors/registry.js";
import { db } from "./db.js";

interface Row {
  id: string; title: string; cron: string; enabled: number; executor: Schedule["executor"];
  project: string | null; prompt: string | null; mode: Schedule["mode"]; attended: number;
  server: string | null; tool: string | null; args: string | null;
  anchor_task_id: string | null; conversation_id: string | null; created_at: string; armed_at: string | null;
  last_run_at: string | null; last_result: string | null; last_ok: number | null; last_ref: string | null; history: string;
}

const toSchedule = (r: Row): Schedule => ({
  id: r.id, title: r.title, cron: r.cron, enabled: r.enabled === 1, executor: r.executor,
  ...(r.project ? { project: r.project } : {}),
  ...(r.prompt ? { prompt: r.prompt } : {}),
  mode: r.mode, attended: r.attended === 1,
  ...(r.server ? { server: r.server } : {}),
  ...(r.tool ? { tool: r.tool } : {}),
  ...(r.args ? { args: JSON.parse(r.args) as Record<string, unknown> } : {}),
  ...(r.anchor_task_id ? { anchorTaskId: r.anchor_task_id } : {}),
  ...(r.conversation_id ? { conversationId: r.conversation_id } : {}),
  createdAt: r.created_at,
  ...(r.armed_at ? { armedAt: r.armed_at } : {}),
  ...(r.last_run_at ? { lastRunAt: r.last_run_at } : {}),
  ...(r.last_result !== null ? { lastResult: r.last_result } : {}),
  ...(r.last_ok !== null ? { lastOk: r.last_ok === 1 } : {}),
  ...(r.last_ref ? { lastRef: r.last_ref } : {}),
  history: JSON.parse(r.history) as Schedule["history"],
});

export function getSchedule(id: string): Schedule | undefined {
  const r = db().prepare("SELECT * FROM schedules WHERE id = ?").get(id) as unknown as Row | undefined;
  return r ? toSchedule(r) : undefined;
}

export function listSchedules(): Schedule[] {
  return (db().prepare("SELECT * FROM schedules ORDER BY created_at").all() as unknown as Row[]).map(toSchedule);
}

export function createSchedule(input: ScheduleInput): Schedule {
  const id = `s-${randomBytes(4).toString("hex")}`;
  db()
    .prepare("INSERT INTO schedules (id, title, cron, enabled, executor, project, prompt, mode, attended, server, tool, args, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, input.title, input.cron, input.enabled === false ? 0 : 1, input.executor, input.project ?? null, input.prompt ?? null, input.mode ?? "continue", input.attended ? 1 : 0, input.server ?? null, input.tool ?? null, input.args ? JSON.stringify(input.args) : null, new Date().toISOString());
  return getSchedule(id)!;
}

const COLS: Record<string, string> = {
  title: "title", cron: "cron", enabled: "enabled", executor: "executor", project: "project", prompt: "prompt",
  mode: "mode", attended: "attended", server: "server", tool: "tool", args: "args",
  anchorTaskId: "anchor_task_id", conversationId: "conversation_id",
};

export function updateSchedule(id: string, patch: Partial<Omit<Schedule, "id" | "createdAt" | "armedAt">>, now = new Date()): Schedule | undefined {
  const sets: string[] = [];
  const vals: Array<string | number | null> = [];
  const cur = getSchedule(id);
  if (cur && ((patch.enabled && !cur.enabled) || (patch.cron !== undefined && patch.cron !== cur.cron))) {
    sets.push("armed_at = ?");
    vals.push(now.toISOString());
  }
  for (const [k, v] of Object.entries(patch)) {
    const col = COLS[k];
    if (!col) continue;
    sets.push(`${col} = ?`);
    vals.push(v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : k === "args" ? JSON.stringify(v) : (v as string));
  }
  if (sets.length) db().prepare(`UPDATE schedules SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
  return getSchedule(id);
}

export function deleteSchedule(id: string): boolean {
  return Number(db().prepare("DELETE FROM schedules WHERE id = ?").run(id).changes) > 0;
}

export function setLastRun(id: string, r: { ok: boolean; result: string; ref?: string; at?: string }): void {
  db()
    .prepare("UPDATE schedules SET last_run_at = ?, last_ok = ?, last_result = ?, last_ref = COALESCE(?, last_ref) WHERE id = ?")
    .run(r.at ?? new Date().toISOString(), r.ok ? 1 : 0, r.result.slice(0, 2000), r.ref ?? null, id);
}

export function pushHistory(id: string, item: { at: string; summary: string }): void {
  const s = getSchedule(id);
  if (!s || s.history.some((h) => h.at === item.at)) return;
  const next = [...s.history, item].slice(-5);
  db().prepare("UPDATE schedules SET history = ? WHERE id = ?").run(JSON.stringify(next), id);
}

export function scheduleByConversation(conversationId: string): Schedule | undefined {
  const r = db().prepare("SELECT * FROM schedules WHERE conversation_id = ?").get(conversationId) as unknown as Row | undefined;
  return r ? toSchedule(r) : undefined;
}

/** 启动时调：直接调工具的定时任务，工具没登记就先停着，免得到点无人值守地直连。notify 往主对话发提示（memory 层不能 import 主对话，会绕回 tools.ts） */
export function pauseUnregisteredCalls(notify: (text: string) => void = () => {}): number {
  let n = 0;
  for (const s of listSchedules()) {
    if (!s.enabled || s.executor !== "call" || !s.server || s.server === "friday" || getTool(s.server)) continue;
    updateSchedule(s.id, { enabled: false });
    notify(`定时任务「${s.title}」调的 ${s.server} 还没登记成工具，先暂停了；说「接一下 ${s.server}」登记后再打开`);
    n++;
  }
  return n;
}
