import { randomUUID } from "node:crypto";
import type { AuditEvent, AuditStatus, Risk } from "@friday/shared";
import { db } from "./db.js";

interface Row {
  id: string;
  task_id: string | null;
  ts: string;
  action: string;
  why: string;
  how: string;
  evidence: string;
  risk: Risk;
  reversible: number;
  status: AuditStatus;
  undo: string | null;
}

// delete_todo 是旧账本里的，todos 表不再写新条目，但已有的账要能撤销
export type Undo =
  | { kind: "drop_note_task"; id: string }
  | { kind: "delete_todo"; id: string }
  | { kind: "remove_people_line"; name: string; line: string }
  | { kind: "delete_slack_message"; channel: string; ts: string }
  | { kind: "meegle_state"; projectKey: string; workItemId: string; backTo: string }
  | { kind: "meegle_node"; projectKey: string; workItemId: string; nodeKey: string }
  | { kind: "restore_memory"; snapshot: { handbooks: Record<string, string>; decisions: string; people: string; projects: string } }
  | { kind: "restore_task"; row: Record<string, string | number | null> }
  | { kind: "stage_set"; taskId: string; stage: string | null }
  | { kind: "none" };

const toEvent = (r: Row): AuditEvent => ({
  id: r.id,
  ...(r.task_id ? { taskId: r.task_id } : {}),
  ts: r.ts,
  action: r.action,
  why: r.why,
  how: r.how,
  evidence: JSON.parse(r.evidence) as Record<string, unknown>,
  risk: r.risk,
  reversible: r.reversible === 1,
  status: r.status,
});

/** 记一笔账。可逆动作带 undo 说明书，撤销时照着做。 */
export function record(input: {
  taskId?: string;
  action: string;
  why: string;
  how: string;
  evidence?: Record<string, unknown>;
  risk: Risk;
  status?: AuditStatus;
  undo?: Undo;
}): AuditEvent {
  const id = randomUUID();
  const reversible = Boolean(input.undo && input.undo.kind !== "none");
  db()
    .prepare("INSERT INTO audit (id, task_id, ts, action, why, how, evidence, risk, reversible, status, undo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, input.taskId ?? null, new Date().toISOString(), input.action, input.why, input.how, JSON.stringify(input.evidence ?? {}), input.risk, reversible ? 1 : 0, input.status ?? "done", input.undo ? JSON.stringify(input.undo) : null);
  return getEvent(id)!;
}

export function getEvent(id: string): AuditEvent | undefined {
  const r = db().prepare("SELECT * FROM audit WHERE id = ?").get(id) as unknown as Row | undefined;
  return r ? toEvent(r) : undefined;
}

export function undoPlan(id: string): Undo | undefined {
  const r = db().prepare("SELECT undo FROM audit WHERE id = ?").get(id) as { undo: string | null } | undefined;
  return r?.undo ? (JSON.parse(r.undo) as Undo) : undefined;
}

export function setEventStatus(id: string, status: AuditStatus): boolean {
  return db().prepare("UPDATE audit SET status = ? WHERE id = ?").run(status, id).changes > 0;
}

/** 发送前先记一笔待定账，拿到 ts 之后回填 undo。 */
export function setEventUndo(id: string, undo: Undo): boolean {
  return db().prepare("UPDATE audit SET undo = ?, reversible = ? WHERE id = ?").run(JSON.stringify(undo), undo.kind === "none" ? 0 : 1, id).changes > 0;
}

/** 把补充信息（比如失败原因）合并进已有的 evidence，不整条覆盖。 */
export function updateEventEvidence(id: string, patch: Record<string, unknown>): boolean {
  const ev = getEvent(id);
  if (!ev) return false;
  return db().prepare("UPDATE audit SET evidence = ? WHERE id = ?").run(JSON.stringify({ ...ev.evidence, ...patch }), id).changes > 0;
}

export function listAudit(opts: { taskId?: string; limit?: number; since?: string } = {}): AuditEvent[] {
  const limit = opts.limit ?? 200;
  const rows = (
    opts.taskId
      ? db().prepare("SELECT * FROM audit WHERE task_id = ? ORDER BY ts DESC LIMIT ?").all(opts.taskId, limit)
      : opts.since
        ? db().prepare("SELECT * FROM audit WHERE ts >= ? ORDER BY ts DESC LIMIT ?").all(opts.since, limit)
        : db().prepare("SELECT * FROM audit ORDER BY ts DESC LIMIT ?").all(limit)
  ) as unknown as Row[];
  return rows.map(toEvent);
}
