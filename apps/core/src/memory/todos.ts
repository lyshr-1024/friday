import { randomUUID } from "node:crypto";
import type { Todo, TodoSource } from "@friday/shared";
import { db } from "./db.js";

interface Row {
  id: string;
  text: string;
  source: TodoSource;
  source_id: string | null;
  source_url: string | null;
  due: string | null;
  created_at: string;
  done: number;
}

function toTodo(r: Row): Todo {
  return {
    id: r.id,
    text: r.text,
    source: r.source,
    ...(r.source_url ? { sourceUrl: r.source_url } : {}),
    ...(r.due ? { due: r.due } : {}),
    createdAt: r.created_at,
    done: r.done === 1,
  };
}

const INSERT =
  "INSERT INTO todos (id, text, source, source_id, source_url, due, created_at, done) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";

export function addLocalTodo(input: { text: string; due?: string }): Todo {
  const row: Row = {
    id: randomUUID(),
    text: input.text,
    source: "local",
    source_id: null,
    source_url: null,
    due: input.due ?? null,
    created_at: new Date().toISOString(),
    done: 0,
  };
  db().prepare(INSERT).run(row.id, row.text, row.source, row.source_id, row.source_url, row.due, row.created_at, row.done);
  return toTodo(row);
}

export function listOpenTodos(): Todo[] {
  const rows = db().prepare("SELECT * FROM todos WHERE done = 0 ORDER BY due IS NULL, due, created_at").all() as unknown as Row[];
  return rows.map(toTodo);
}

// 外部源全量同步：已存在的更新文案，消失的标记完成，用 (source, source_id) 去重。
export function syncSourceTodos(source: Exclude<TodoSource, "local">, todos: Todo[]): void {
  const d = db();
  const upsert = d.prepare(
    `${INSERT} ON CONFLICT(source, source_id) WHERE source_id IS NOT NULL DO UPDATE SET text = excluded.text, source_url = excluded.source_url, due = excluded.due, done = 0`,
  );
  const ids = todos.map((t) => t.id);
  d.exec("BEGIN");
  try {
    for (const t of todos) {
      upsert.run(t.id, t.text, source, t.id, t.sourceUrl ?? null, t.due ?? null, t.createdAt, 0);
    }
    const placeholders = ids.map(() => "?").join(",");
    d.prepare(`UPDATE todos SET done = 1 WHERE source = ? AND done = 0${ids.length ? ` AND id NOT IN (${placeholders})` : ""}`).run(source, ...ids);
    d.prepare("INSERT INTO sync_state (source, last_synced_at) VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET last_synced_at = excluded.last_synced_at").run(
      source,
      new Date().toISOString(),
    );
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

export function deleteTodo(id: string): boolean {
  return db().prepare("DELETE FROM todos WHERE id = ?").run(id).changes > 0;
}
