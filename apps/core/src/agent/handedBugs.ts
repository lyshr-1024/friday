import type { Task } from "@friday/shared";
import { listTasks, updateTask } from "../memory/tasks.js";
import { state } from "../scheduler/index.js";
import { closeRunForTask } from "./runLog.js";

export function settleHandedBugs(rootId: string, why: string): number {
  const bugs = listTasks("processing").filter((t) => t.source.rootId === rootId && t.source.handedAt && !t.source.jobId);
  for (const b of bugs) {
    updateTask(b.id, { status: "blocked", progress: why });
    closeRunForTask(b.id, "no_report");
    state.notices.push({ title: "缺陷没交付", body: `${b.title}：${why}`, taskId: b.id });
  }
  return bugs.length;
}

/** 交接标记：重开或你接手时清掉，门禁和「开始做」才认它是一条普通缺陷 */
export function clearHanded(t: Task): Partial<Task> {
  return t.source.handedAt ? { source: { handedAt: undefined, autonomous: undefined, jobId: undefined } } : {};
}
