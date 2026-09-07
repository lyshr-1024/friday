import type { Thread, ThreadBrief } from "@friday/shared";
import { readMemoryFile, writeMemoryFile } from "../memory/files.js";
import { markAutoDone } from "../memory/threads.js";
import { addLocalTodo } from "../memory/todos.js";

/**
 * 情境卡里的可逆写：记待办、更新 people.md。按 permission.ts 属 reversible：自动做、留痕、每个线程每类只做一次。
 * 返回做了什么，供日志与情境卡 context 展示。
 */
export function applyReversibleWrites(thread: Thread, brief: ThreadBrief): string[] {
  const done: string[] = [];
  if (brief.todo && markAutoDone(thread.id, "todo")) {
    addLocalTodo(brief.todo.due ? { text: brief.todo.text, due: brief.todo.due } : { text: brief.todo.text });
    done.push(`已记待办：${brief.todo.text}`);
  }
  if (brief.person && markAutoDone(thread.id, "person")) {
    upsertPerson(thread.userName, brief.person);
    done.push(`已更新人物：${thread.userName}`);
  }
  return done;
}

/** people.md 里按「## 名字」找条目：有则在末尾追加一行备注，没有则新建一节。 */
export function upsertPerson(name: string, note: string, current = readMemoryFile("people")): string {
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
  writeMemoryFile("people", next);
  return next;
}
