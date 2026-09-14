import type { Task, TaskSource } from "@friday/shared";
import { db } from "./db.js";
import { createTask, listTasks, updateTask } from "./tasks.js";

/**
 * 「记一条待办」统一建成任务。
 * 原来写的是 todos 表，但启动器删掉之后那张表在界面上已经没有出口——写进去用户看不见。
 * 现在一律进 tasks，落在左栏「待办」分组里，来源靠 kind 区分。
 *
 * 注意 source 不要放 threadId：线程本身那条任务是靠 findTaskBySource(threadId) 找回来的，
 * 再挂一条同 threadId 的会让它匹配到哪条变得不确定。线程派生的待办用 fromTaskId 关联。
 */
export function addNoteTask(input: { text: string; due?: string; source?: TaskSource; kind?: "verbal" | "slack" }): Task {
  const text = input.text.trim();
  const title = text.length > 80 ? `${text.slice(0, 79)}…` : text;
  return createTask({
    title,
    kind: input.kind ?? "verbal",
    source: input.source ?? {},
    status: "understood",
    // 标题截断过就把全文留在理解里，免得长待办看不到后半句
    ...(title === text ? {} : { understanding: text }),
    ...(input.due ? { due: input.due } : {}),
  });
}

/** 撤销「记一条待办」：标成 ignored 而不是物理删除，保留痕迹。 */
export function dropNoteTask(id: string): boolean {
  return Boolean(updateTask(id, { status: "ignored" }));
}

/**
 * 把 todos 表里还没搬过来的本地待办补成任务。
 * 启动器删掉之后 todos 写进去就没人看得见了，库里攒了几十条。全量搬会一次涌进左栏把
 * 真正在办的事淹掉，所以只搬最近 `days` 天的，更早的留在表里不动。
 */
export function migrateLocalTodos(days = 1, now = Date.now()): number {
  const since = new Date(now - days * 86_400_000).toISOString();
  const rows = db()
    .prepare("SELECT id, text, due FROM todos WHERE source = 'local' AND done = 0 AND created_at > ? ORDER BY created_at")
    .all(since) as Array<{ id: string; text: string; due: string | null }>;
  if (!rows.length) return 0;
  // 同一句话在 todos 里可能重复写过好几遍，搬过去只留一条
  const seen = new Set(listTasks().map((t) => t.title));
  let n = 0;
  for (const r of rows) {
    const text = r.text.trim();
    const title = text.length > 80 ? `${text.slice(0, 79)}…` : text;
    if (!text || seen.has(title)) continue;
    seen.add(title);
    addNoteTask({ text, ...(r.due ? { due: r.due } : {}) });
    // 搬过来的标记成已完成，免得下次启动又搬一遍
    db().prepare("UPDATE todos SET done = 1 WHERE id = ?").run(r.id);
    n += 1;
  }
  return n;
}
