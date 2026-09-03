import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
  instance = new DatabaseSync(join(dir, "todos.db"));
  instance.exec("PRAGMA journal_mode = WAL");
  instance.exec(SCHEMA);
  return instance;
}

export function db(): DatabaseSync {
  return instance ?? initMemory();
}
