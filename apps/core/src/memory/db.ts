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
  // 判断链路删掉了，这三张表连同里面的数据一起收走
  for (const t of ["threads", "lessons", "thresholds"]) d.exec(`DROP TABLE IF EXISTS ${t}`);
  const linksSql = (d.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'links'").get() as { sql?: string } | undefined)?.sql ?? "";
  if (linksSql && !linksSql.includes("'slack'")) {
    d.exec("ALTER TABLE links RENAME TO links_old");
    d.exec(SCHEMA);
    d.exec("INSERT INTO links SELECT id, from_kind, from_ref, to_kind, to_ref, source, why, created_at, updated_at FROM links_old");
    d.exec("DROP TABLE links_old");
  }
  const cols = (d.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!cols.includes("title")) d.exec("ALTER TABLE conversations ADD COLUMN title TEXT");
  const inboxCols = (d.prepare("PRAGMA table_info(inbox)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!inboxCols.includes("thread_ts")) d.exec("ALTER TABLE inbox ADD COLUMN thread_ts TEXT");
  if (!inboxCols.includes("prior")) d.exec("ALTER TABLE inbox ADD COLUMN prior TEXT");
  const jobCols = (d.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!jobCols.includes("claude_session_id")) d.exec("ALTER TABLE jobs ADD COLUMN claude_session_id TEXT");
  if (!jobCols.includes("terminal")) d.exec("ALTER TABLE jobs ADD COLUMN terminal TEXT");
  // Ghostty 的 terminal id：开窗口时拿到，say / focus / close 都靠它认窗口
  if (!jobCols.includes("ghostty_id")) d.exec("ALTER TABLE jobs ADD COLUMN ghostty_id TEXT");
  // 这个 job 是替哪条任务干的：开工时写死归属，终端连回来时按它认领，
  // 不然每开一次工就长出一条新任务（工单的 meegleId / linkedStoryId 全丢）
  if (!jobCols.includes("task_id")) d.exec("ALTER TABLE jobs ADD COLUMN task_id TEXT");
  const taskCols = (d.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!taskCols.includes("attention")) d.exec("ALTER TABLE tasks ADD COLUMN attention TEXT");
  if (!taskCols.includes("pinned")) d.exec("ALTER TABLE tasks ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
  if (!taskCols.includes("stage")) d.exec("ALTER TABLE tasks ADD COLUMN stage TEXT");
  if (!taskCols.includes("stage_by")) d.exec("ALTER TABLE tasks ADD COLUMN stage_by TEXT");
  if (!taskCols.includes("stage_at")) d.exec("ALTER TABLE tasks ADD COLUMN stage_at TEXT");
  if (!taskCols.includes("stage_prev")) d.exec("ALTER TABLE tasks ADD COLUMN stage_prev TEXT");
  if (!taskCols.includes("stage_hint")) d.exec("ALTER TABLE tasks ADD COLUMN stage_hint TEXT");
  if (!taskCols.includes("released_at")) d.exec("ALTER TABLE tasks ADD COLUMN released_at TEXT");
  // 开工提案曾经会把工单推进 review，于是「待我决定」里堆的全是还没开工的工单，
  // 而「缺陷」分组反而是空的。挂着开工提案、没有别的待审动作的，放回待办里。
  d.exec(`UPDATE tasks SET status = 'understood'
          WHERE status = 'review'
            AND pending LIKE '%"start_job"%'
            AND pending NOT LIKE '%"slack_reply"%'
            AND pending NOT LIKE '%"git_merge"%'
            AND pending NOT LIKE '%"handbook_apply"%'`);

  // 存量任务补 stage：status 七态里 understood/processing/review 的语义被 stage 接管了。
  // 只补「要写代码的活」——Slack 回消息类没有阶段，留空。
  // 判据全是库里已有的事实，不猜：有分支就是已经动手了。
  d.exec(`UPDATE tasks SET stage = CASE
            WHEN status = 'done' THEN 'released'
            WHEN status = 'review' THEN 'testing'
            WHEN status = 'processing' THEN 'dev'
            WHEN json_extract(source, '$.branch') IS NOT NULL THEN 'dev'
            ELSE 'todo'
          END,
          stage_by = 'auto'
          WHERE stage IS NULL
            AND json_extract(source, '$.threadId') IS NULL
            AND json_extract(source, '$.fromTaskId') IS NULL`);
}

export function db(): DatabaseSync {
  return instance ?? initMemory();
}
