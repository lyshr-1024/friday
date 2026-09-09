import { randomUUID } from "node:crypto";
import type { DeliveryReport, PendingAction, Task, TaskAttention, TaskBoard, TaskKind, TaskSource, TaskStatus, Urgency } from "@friday/shared";
import { db } from "./db.js";
import { publish } from "../bus.js";

interface Row {
  id: string;
  title: string;
  kind: TaskKind;
  source: string;
  project: string | null;
  status: TaskStatus;
  priority: Urgency;
  understanding: string | null;
  plan: string | null;
  progress: string | null;
  report: string | null;
  pending: string | null;
  due: string | null;
  attention: TaskAttention | null;
  pinned: number;
  created_at: string;
  updated_at: string;
}

const toTask = (r: Row): Task => ({
  id: r.id,
  title: r.title,
  kind: r.kind,
  source: JSON.parse(r.source) as TaskSource,
  ...(r.project ? { project: r.project } : {}),
  status: r.status,
  priority: r.priority,
  ...(r.understanding ? { understanding: r.understanding } : {}),
  ...(r.plan ? { plan: r.plan } : {}),
  ...(r.progress ? { progress: r.progress } : {}),
  ...(r.report ? { report: JSON.parse(r.report) as DeliveryReport } : {}),
  ...(r.pending ? { pending: JSON.parse(r.pending) as PendingAction[] } : {}),
  ...(r.due ? { due: r.due } : {}),
  ...(r.attention ? { attention: r.attention } : {}),
  ...(r.pinned ? { pinned: true } : {}),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const STATUSES: TaskStatus[] = ["collected", "understood", "processing", "review", "done", "blocked", "ignored"];
const now = () => new Date().toISOString();

export function createTask(input: {
  title: string;
  kind: TaskKind;
  source: TaskSource;
  project?: string;
  priority?: Urgency;
  understanding?: string;
  plan?: string;
  due?: string;
  status?: TaskStatus;
}): Task {
  const id = randomUUID();
  const t = now();
  db()
    .prepare(
      "INSERT INTO tasks (id, title, kind, source, project, status, priority, understanding, plan, due, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(id, input.title.slice(0, 200), input.kind, JSON.stringify(input.source), input.project ?? null, input.status ?? "collected", input.priority ?? "normal", input.understanding ?? null, input.plan ?? null, input.due ?? null, t, t);
  publish({ type: "tasks" });
  return getTask(id)!;
}

export function getTask(id: string): Task | undefined {
  const r = db().prepare("SELECT * FROM tasks WHERE id = ?").get(id) as unknown as Row | undefined;
  return r ? toTask(r) : undefined;
}

/** 按来源找已存在的任务，避免同一线程 / 工单重复建。 */
export function findTaskBySource(pred: (s: TaskSource) => boolean, includeClosed = false): Task | undefined {
  const rows = db()
    .prepare(includeClosed ? "SELECT * FROM tasks ORDER BY updated_at DESC" : "SELECT * FROM tasks WHERE status NOT IN ('done', 'ignored') ORDER BY updated_at DESC")
    .all() as unknown as Row[];
  const r = rows.find((row) => pred(JSON.parse(row.source) as TaskSource));
  return r ? toTask(r) : undefined;
}

export function updateTask(
  id: string,
  patch: Partial<Pick<Task, "title" | "project" | "status" | "priority" | "understanding" | "plan" | "progress" | "report" | "pending" | "due" | "source" | "attention" | "pinned">>,
): Task | undefined {
  const cur = getTask(id);
  if (!cur) return undefined;
  const next = { ...cur, ...patch, source: { ...cur.source, ...(patch.source ?? {}) } };
  db()
    .prepare(
      "UPDATE tasks SET title = ?, project = ?, status = ?, priority = ?, understanding = ?, plan = ?, progress = ?, report = ?, pending = ?, due = ?, source = ?, attention = ?, pinned = ?, updated_at = ? WHERE id = ?",
    )
    .run(
      next.title,
      next.project ?? null,
      next.status,
      next.priority,
      next.understanding ?? null,
      next.plan ?? null,
      next.progress ?? null,
      next.report ? JSON.stringify(next.report) : null,
      next.pending && next.pending.length ? JSON.stringify(next.pending) : null,
      next.due ?? null,
      JSON.stringify(next.source),
      next.attention ?? null,
      next.pinned ? 1 : 0,
      now(),
      id,
    );
  publish({ type: "tasks" });
  return getTask(id);
}

export function listTasks(status?: TaskStatus | TaskStatus[], limit = 200): Task[] {
  const wanted = status ? (Array.isArray(status) ? status : [status]) : undefined;
  const rows = (
    wanted
      ? db().prepare(`SELECT * FROM tasks WHERE status IN (${wanted.map(() => "?").join(",")}) ORDER BY updated_at DESC LIMIT ?`).all(...wanted, limit)
      : db().prepare("SELECT * FROM tasks ORDER BY updated_at DESC LIMIT ?").all(limit)
  ) as unknown as Row[];
  return rows.map(toTask);
}

export function taskBoard(): TaskBoard {
  const tasks = listTasks(undefined, 500);
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
  for (const t of tasks) counts[t.status]++;
  return { tasks: tasks.filter((t) => t.status !== "ignored"), counts };
}

export function addPending(id: string, action: Omit<PendingAction, "id">): Task | undefined {
  const cur = getTask(id);
  if (!cur) return undefined;
  return updateTask(id, { pending: [...(cur.pending ?? []), { id: randomUUID(), ...action }], status: "review" });
}

export function updatePending(id: string, actionId: string, patch: Partial<Pick<PendingAction, "detail" | "payload" | "label">>): Task | undefined {
  const cur = getTask(id);
  if (!cur?.pending?.some((a) => a.id === actionId)) return undefined;
  return updateTask(id, { pending: cur.pending.map((a) => (a.id === actionId ? { ...a, ...patch } : a)) });
}

export function removePending(id: string, actionId: string): Task | undefined {
  const cur = getTask(id);
  if (!cur?.pending?.some((a) => a.id === actionId)) return undefined;
  return updateTask(id, { pending: cur.pending.filter((a) => a.id !== actionId) });
}

export function takePending(id: string, actionId: string): { task: Task; action: PendingAction } | undefined {
  const cur = getTask(id);
  const action = cur?.pending?.find((a) => a.id === actionId);
  if (!cur || !action) return undefined;
  const rest = cur.pending!.filter((a) => a.id !== actionId);
  const task = updateTask(id, { pending: rest })!;
  return { task, action };
}
