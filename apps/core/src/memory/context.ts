import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { listOpenTodos } from "./todos.js";

export interface MemoryContext {
  projects: string;
  decisions: string;
  people: string;
  todos: string;
}

const LIMIT = 4000;

function readMd(name: string): string {
  const file = join(config.dataDir, name);
  if (!existsSync(file)) return "";
  const text = readFileSync(file, "utf8").replace(/<!--[\s\S]*?-->/g, "").trim();
  return text.length > LIMIT ? `${text.slice(0, LIMIT)}\n…（已截断）` : text;
}

export function loadMemoryContext(): MemoryContext {
  const todos = listOpenTodos()
    .slice(0, 30)
    .map((t) => `- [${t.source}] ${t.text}${t.due ? `（截止 ${t.due}）` : ""}`)
    .join("\n");
  return { projects: readMd("projects.md"), decisions: readMd("decisions.md"), people: readMd("people.md"), todos };
}
