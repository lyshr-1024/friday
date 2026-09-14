import type { Thread, ThreadBrief } from "@friday/shared";
import { record } from "../memory/audit.js";
import { readMemoryFile, writeMemoryFile } from "../memory/files.js";
import { markAutoDone } from "../memory/threads.js";
import { addNoteTask, dropNoteTask } from "../memory/noteTask.js";
import { deleteTodo } from "../memory/todos.js";

/**
 * 情境卡里的可逆写：记待办、更新 people.md。按 permission.ts 属 reversible：自动做、记账、可撤销、每个线程每类只做一次。
 */
export function applyReversibleWrites(thread: Thread, brief: ThreadBrief, taskId?: string): string[] {
  const done: string[] = [];
  if (brief.todo && markAutoDone(thread.id, "todo")) {
    const todo = addNoteTask({
      text: brief.todo.text,
      ...(brief.todo.due ? { due: brief.todo.due } : {}),
      kind: "slack",
      source: taskId ? { fromTaskId: taskId } : {},
    });
    record({
      ...(taskId ? { taskId } : {}),
      action: "todo_add",
      why: `${thread.userName} 的消息里有需要你之后做的事`,
      how: "建成一条待办任务",
      evidence: { text: todo.title, due: todo.due ?? null, threadId: thread.id },
      risk: "reversible",
      undo: { kind: "drop_note_task", id: todo.id },
    });
    done.push(`已记待办：${brief.todo.text}`);
  }
  if (brief.person && markAutoDone(thread.id, "person")) {
    const line = upsertPerson(thread.userName, brief.person);
    record({
      ...(taskId ? { taskId } : {}),
      action: "people_note",
      why: `对 ${thread.userName} 有值得记住的新信息`,
      how: "在 people.md 该人条目下追加一行备注",
      evidence: { name: thread.userName, line },
      risk: "reversible",
      undo: { kind: "remove_people_line", name: thread.userName, line },
    });
    done.push(`已更新人物：${thread.userName}`);
  }
  return done;
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
