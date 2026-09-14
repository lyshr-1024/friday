import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { listTasks } from "./tasks.js";

export interface MemoryContext {
  projects: string;
  todos: string;
  /** people.md / decisions.md 有没有内容。有就在提示里说一句「需要时 memory_read」 */
  hasPeople: boolean;
  hasDecisions: boolean;
}

const LIMIT = 4000;

function readMd(name: string): string {
  const file = join(config.dataDir, name);
  if (!existsSync(file)) return "";
  const text = readFileSync(file, "utf8").replace(/<!--[\s\S]*?-->/g, "").trim();
  return text.length > LIMIT ? `${text.slice(0, LIMIT)}\n…（已截断）` : text;
}

const nonEmpty = (name: string): boolean => {
  const file = join(config.dataDir, name);
  return existsSync(file) && readFileSync(file, "utf8").trim().length > 0;
};

/**
 * 会话每轮都要重发这段，所以只内联真正高频的。
 * projects 留着——判断「这句话说的是哪个项目」几乎每次都要用名字和别名对一遍。
 * people（约 6.8k）和 decisions（约 4k）大多数对话根本用不到，改成需要时让它自己 memory_read。
 */
export function loadMemoryContext(): MemoryContext {
  const todos = openTodoLines(30).join("\n");
  return { projects: readMd("projects.md"), todos, hasPeople: nonEmpty("people.md"), hasDecisions: nonEmpty("decisions.md") };
}

/** 未完成的待办。记待办已经统一进 tasks 表，todos 表只剩 Meegle 同步用，这里读 tasks。 */
export function openTodoLines(limit: number): string[] {
  return listTasks()
    .filter((t) => t.status === "understood" || t.status === "collected")
    .sort((a, b) => (a.due ?? "9").localeCompare(b.due ?? "9"))
    .slice(0, limit)
    .map((t) => `- [${t.kind}] ${t.title}${t.due ? `（截止 ${t.due}）` : ""}`);
}
