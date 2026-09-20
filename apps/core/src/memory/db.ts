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
export function migrate(d: DatabaseSync): void {
  // lessons.kind 的取值范围写死在 CHECK 里，加了新类别只能重建表（SQLite 改不了 CHECK）。
  // 判据用最新加的那个类别：再加新类别时把它换成新的，老库才会重建。
  const lessonsSql = (d.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'lessons'").get() as { sql?: string } | undefined)?.sql ?? "";
  if (lessonsSql && !lessonsSql.includes("relayed_direct")) {
    d.exec("ALTER TABLE lessons RENAME TO lessons_old");
    d.exec(SCHEMA);
    d.exec("INSERT INTO lessons SELECT id, task_id, category, kind, draft, final, feedback, confidence, created_at FROM lessons_old");
    d.exec("DROP TABLE lessons_old");
  }
  const cols = (d.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!cols.includes("title")) d.exec("ALTER TABLE conversations ADD COLUMN title TEXT");
  const inboxCols = (d.prepare("PRAGMA table_info(inbox)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!inboxCols.includes("thread_id")) d.exec("ALTER TABLE inbox ADD COLUMN thread_id TEXT");
  if (!inboxCols.includes("thread_ts")) d.exec("ALTER TABLE inbox ADD COLUMN thread_ts TEXT");
  if (!inboxCols.includes("category")) d.exec("ALTER TABLE inbox ADD COLUMN category TEXT");
  const jobCols = (d.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!jobCols.includes("claude_session_id")) d.exec("ALTER TABLE jobs ADD COLUMN claude_session_id TEXT");
  if (!jobCols.includes("terminal")) d.exec("ALTER TABLE jobs ADD COLUMN terminal TEXT");
  // Ghostty 的 terminal id：开窗口时拿到，say / focus / close 都靠它认窗口
  if (!jobCols.includes("ghostty_id")) d.exec("ALTER TABLE jobs ADD COLUMN ghostty_id TEXT");
  // 这个 job 是替哪条任务干的：开工时写死归属，终端连回来时按它认领，
  // 不然每开一次工就长出一条新任务（工单的 meegleId / linkedStoryId 全丢）
  if (!jobCols.includes("task_id")) d.exec("ALTER TABLE jobs ADD COLUMN task_id TEXT");
  const threadCols = (d.prepare("PRAGMA table_info(threads)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!threadCols.includes("anchor_ts")) d.exec("ALTER TABLE threads ADD COLUMN anchor_ts TEXT");
  const taskCols = (d.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!taskCols.includes("attention")) d.exec("ALTER TABLE tasks ADD COLUMN attention TEXT");
  if (!taskCols.includes("pinned")) d.exec("ALTER TABLE tasks ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
  // 开工提案曾经会把工单推进 review，于是「待我决定」里堆的全是还没开工的工单，
  // 而「缺陷」分组反而是空的。挂着开工提案、没有别的待审动作的，放回待办里。
  d.exec(`UPDATE tasks SET status = 'understood'
          WHERE status = 'review'
            AND pending LIKE '%"start_job"%'
            AND pending NOT LIKE '%"slack_reply"%'
            AND pending NOT LIKE '%"git_merge"%'
            AND pending NOT LIKE '%"handbook_apply"%'`);
}

export function db(): DatabaseSync {
  return instance ?? initMemory();
}
