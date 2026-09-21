import type { Thread, ThreadBrief } from "@friday/shared";
import { record } from "../memory/audit.js";
import { upsertPerson } from "../memory/files.js";
import { markAutoDone } from "../memory/threads.js";

/**
 * 情境卡里的可逆写：更新 people.md。按 permission.ts 属 reversible：自动做、记账、可撤销、每个线程每类只做一次。
 * 原来还会按情境卡的 todo 自动记待办，2026-09-18 随起草能力一起去掉了——
 * 那些待办是模型从指代句里编出来的（「确认张亮问的是哪个 key」），实测创建后 98 分钟内被全部清掉。
 */
export function applyReversibleWrites(thread: Thread, brief: ThreadBrief, taskId?: string): string[] {
  const done: string[] = [];
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
