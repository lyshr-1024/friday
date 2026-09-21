import type { InboxItem, Task } from "@friday/shared";
import { meegleIdsIn, slackNode, taskNode } from "../../memory/infer.js";
import { neighbors, rejected } from "../../memory/links.js";

export interface AttachHit {
  taskId: string;
  why: string;
}

/** 同一人同一频道近期挂过哪些任务。上层给实现，纯函数测试里给桩。 */
export type RecentLookup = (item: InboxItem) => Array<{ taskId: string; userName: string; hoursAgo: number }>;

export const RECENT_MAX_HOURS = 48;

export function hardSignal(item: InboxItem, tasks: Task[], recent: RecentLookup): AttachHit | undefined {
  const byId = new Map(tasks.map((t) => [t.id, t]));

  for (const id of meegleIdsIn(item.text)) {
    const hit = tasks.find((t) => t.source.meegleId === id || t.source.linkedStoryId === id);
    if (hit) return { taskId: hit.id, why: `消息里提到了工单 ${id}` };
  }

  for (const r of recent(item)) {
    if (r.hoursAgo > RECENT_MAX_HOURS || !byId.has(r.taskId)) continue;
    return { taskId: r.taskId, why: `${r.userName} ${r.hoursAgo} 小时前在这个频道说的也是这条` };
  }
  return undefined;
}

/** 候选：还没收工的任务，减去你说过「不是这条」的 */
export function candidateTasks(conv: string, tasks: Task[]): Task[] {
  const me = slackNode(conv);
  return tasks.filter((t) => !rejected(me, taskNode(t.id)));
}

/** 这段对话已经挂上的任务 */
export function attachedTasks(conv: string): string[] {
  return neighbors(slackNode(conv), "task").map((n) => n.ref);
}
