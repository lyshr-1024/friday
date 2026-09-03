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
  return instance;
}

export function db(): DatabaseSync {
  return instance ?? initMemory();
}
