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
  db()
    .prepare("INSERT INTO todos (id, text, source, source_id, source_url, due, created_at, done) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(row.id, row.text, row.source, row.source_id, row.source_url, row.due, row.created_at, row.done);
  return toTodo(row);
}

export function listOpenTodos(): Todo[] {
  const rows = db().prepare("SELECT * FROM todos WHERE done = 0 ORDER BY due IS NULL, due, created_at").all() as unknown as Row[];
  return rows.map(toTodo);
}
