import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryFile } from "@friday/shared";
import { config } from "../config.js";
import { dropNoteTask } from "./noteTask.js";
import { deleteTodo } from "./todos.js";

export const MEMORY_FILES: Record<MemoryFile, string> = { projects: "projects.md", decisions: "decisions.md", people: "people.md" };

export function memoryPath(name: MemoryFile): string {
  return join(config.dataDir, MEMORY_FILES[name]);
}

export function readMemoryFile(name: MemoryFile): string {
  try {
    return readFileSync(memoryPath(name), "utf8");
  } catch {
    return "";
  }
}

// 先写临时文件再改名，避免写一半被读到。
export function writeMemoryFile(name: MemoryFile, content: string): void {
  const path = memoryPath(name);
  writeFileSync(`${path}.tmp`, content);
  renameSync(`${path}.tmp`, path);
}

/** 从 people.md 里找这个人的条目（按姓名或英文名包含匹配）。 */
export function personNote(userName: string, people = readMemoryFile("people")): string | undefined {
  const tokens = userName
    .replace(/[()（）]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  const sections = people.split(/^## /m).slice(1);
  for (const sec of sections) {
    const [title = "", ...rest] = sec.split("\n");
    if (tokens.some((t) => title.toLowerCase().includes(t.toLowerCase()))) {
      return `${title.trim()}：${rest.filter((l) => l.trim()).map((l) => l.replace(/^-\s*/, "").trim()).join("；")}`;
    }
  }
  return undefined;
}

/** people.md 里按「## 名字」找条目：有则在末尾追加一行备注，没有则新建一节。返回追加的那一行。 */
export function upsertPerson(name: string, note: string, current = readMemoryFile("people"), write = writeMemoryFile): string {
  const stamp = new Date().toISOString().slice(0, 10);
  const line = `- 备注（${stamp}，Friday 自动）：${note}`;
  const header = `## ${name}`;
  let next: string;
  if (current.includes(`\n${header}\n`) || current.startsWith(`${header}\n`)) {
    const idx = current.indexOf(header);
    const after = current.indexOf("\n## ", idx + header.length);
    const end = after === -1 ? current.length : after;
    next = `${current.slice(0, end).trimEnd()}\n${line}\n${current.slice(end)}`;
  } else {
    next = `${current.trimEnd()}\n\n${header}\n${line}\n`;
  }
  write("people", next);
  return line;
}

/** 撤销一笔可逆动作。 */
export function undoWrite(plan: { kind: string; id?: string; name?: string; line?: string }): boolean {
  if (plan.kind === "drop_note_task" && plan.id) return dropNoteTask(plan.id);
  // Slack 撤回、Meegle 流转不在这里做：要调外部接口，由 api/tasks.ts 的撤销路由分派
  if (plan.kind === "delete_slack_message") return false;
  // 旧账本里的条目还指着 todos 表，留着让它们仍可撤销
  if (plan.kind === "delete_todo" && plan.id) return deleteTodo(plan.id);
  if (plan.kind === "remove_people_line" && plan.line) {
    const cur = readMemoryFile("people");
    if (!cur.includes(plan.line)) return false;
    writeMemoryFile("people", cur.replace(`${plan.line}\n`, "").replace(plan.line, ""));
    return true;
  }
  return false;
}
