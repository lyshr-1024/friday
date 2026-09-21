import { meegleIdsIn } from "./infer.js";
import { findTaskBySource, listTasks, updateTask } from "./tasks.js";
import { listThreads } from "./threads.js";

/**
 * 给存量的 Slack 任务补上「聊的是哪个需求」。
 * Meegle 工单的关联字段下次同步就会自动补齐（source 是合并写的），但 Slack 那边
 * 的关联只在新线程进来时建，老任务不会回溯——这里补一次。
 */
export function backfillSlackLinks(): number {
  const threads = new Map(listThreads("all", 500).map((t) => [t.id, t]));
  let n = 0;
  for (const task of listTasks()) {
    if (task.kind !== "slack" || task.source.linkedStoryId) continue;
    const thread = task.source.threadId ? threads.get(task.source.threadId) : undefined;
    if (!thread) continue;
    const ids = meegleIdsIn(thread.items.map((i) => i.text).join("\n"));
    if (!ids.length) continue;
    // 优先取任务板里真有的那条工单，这样界面上能点过去
    const hit = ids.map((id) => findTaskBySource((s) => s.meegleId === id, true)).find(Boolean);
    const storyId = hit?.source.meegleId ?? ids[0]!;
    updateTask(task.id, {
      source: { linkedStoryId: storyId, ...(hit?.title ? { linkedStoryName: hit.title } : {}) },
      ...(!task.project && hit?.project ? { project: hit.project } : {}),
    });
    n += 1;
  }
  return n;
}
