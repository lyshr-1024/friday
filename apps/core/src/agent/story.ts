import { taskCategory, workItemOf, type Task } from "@friday/shared";
import { findTaskBySource, getTask, listTasks } from "../memory/tasks.js";

export const OPEN_STATUS = new Set<Task["status"]>(["collected", "understood", "processing", "review", "blocked"]);

/** 缺陷挂在哪张需求下：rootId 指的那张（修复卡换回它替的需求），没有就按工单关联的需求号找；收没收工都算 */
export function storyOf(t: Task): Task | undefined {
  if (taskCategory(t) !== "defect") return undefined;
  const r = t.source.rootId ? getTask(t.source.rootId) : undefined;
  if (r) return r.source.fixFor ? (getTask(r.source.fixFor) ?? r) : r;
  const id = workItemOf(t.source)?.parent?.id;
  return id ? findTaskBySource((s) => workItemOf(s)?.id === id || (s.mergedIds ?? []).includes(id), true) : undefined;
}

/** 这张需求还没收工的修复卡 */
export const fixCardOf = (story: Task): Task | undefined => listTasks([...OPEN_STATUS], 2000).find((x) => x.source.fixFor === story.id);
