import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

// esbuild 不认识 node:sqlite，会把 node: 前缀剥掉导致运行时找不到包，改为运行时 require。
const { DatabaseSync: Database } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
import { config } from "../config.js";
import { MARKDOWN_TEMPLATES, SCHEMA } from "./schema.js";

let instance: DatabaseSync | undefined;

export function initMemory(dir = config.dataDir): DatabaseSync {
  if (instance) return instance;
  mkdirSync(join(dir, "logs"), { recursive: true });
  for (const [name, content] of Object.entries(MARKDOWN_TEMPLATES)) {
    const file = join(dir, name);
    if (!existsSync(file)) writeFileSync(file, content);
  }
  instance = new Database(join(dir, "todos.db"));
  instance.exec("PRAGMA journal_mode = WAL");
  instance.exec(SCHEMA);
  migrate(instance);
  return instance;
}

// 增量列：CREATE TABLE IF NOT EXISTS 不会给老库加列，这里按需补。
function migrate(d: DatabaseSync): void {
  const cols = (d.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!cols.includes("title")) d.exec("ALTER TABLE conversations ADD COLUMN title TEXT");
  const inboxCols = (d.prepare("PRAGMA table_info(inbox)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!inboxCols.includes("thread_id")) d.exec("ALTER TABLE inbox ADD COLUMN thread_id TEXT");
  const jobCols = (d.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!jobCols.includes("claude_session_id")) d.exec("ALTER TABLE jobs ADD COLUMN claude_session_id TEXT");
  if (!jobCols.includes("terminal")) d.exec("ALTER TABLE jobs ADD COLUMN terminal TEXT");
  const threadCols = (d.prepare("PRAGMA table_info(threads)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!threadCols.includes("anchor_ts")) d.exec("ALTER TABLE threads ADD COLUMN anchor_ts TEXT");
  const taskCols = (d.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!taskCols.includes("attention")) d.exec("ALTER TABLE tasks ADD COLUMN attention TEXT");
  if (!taskCols.includes("pinned")) d.exec("ALTER TABLE tasks ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
}

export function db(): DatabaseSync {
  return instance ?? initMemory();
}
