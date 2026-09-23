import { isQueryTask } from "@friday/shared";
import { record } from "../../memory/audit.js";
import { CONV_SCAN_LIMIT, listInbox } from "../../memory/inbox.js";
import { conversationKey } from "../../memory/infer.js";
import { listTasks, removePending, updateTask } from "../../memory/tasks.js";
import { finishTask } from "../pipeline.js";

const OPEN = ["processing", "review", "blocked"] as const;

/** 消息状态以 Slack 为准，这是「已经处理完的事又冒出来」的根治点。 */
export function settleQueryTasks(): number {
  const settled = new Set(
    listInbox(true, CONV_SCAN_LIMIT)
      .filter((i) => i.done)
      .map(conversationKey),
  );
  let n = 0;
  for (const t of listTasks([...OPEN], 200)) {
    const conv = t.source.conversation;
    if (!conv || !settled.has(conv) || !isQueryTask(t.source)) continue;
    for (const p of t.pending ?? []) if (p.type === "slack_reply") removePending(t.id, p.id);
    updateTask(t.id, { status: "done", attention: undefined, progress: "你自己在 Slack 里回了" });
    record({
      taskId: t.id,
      action: "slack_settled_by_user",
      why: "你在 Slack 里已经读过或回过",
      how: "任务收掉，草稿撤下",
      evidence: { conversation: conv },
      risk: "read",
    });
    n += 1;
  }
  return n;
}

/** 挂了这么久没动过的 Slack 待决定自动归档：你没回，也不打算回了。 */
export const STALE_MS = 24 * 3600_000;

/** 挂着这些待审动作说明事情本身还没做，不能因为「放了一天」就归档掉。 */
const EXECUTABLE = new Set(["start_job", "git_merge"]);

/** 判据只看多久没动过，不猜读没读——读过没回和没看见，一天之后是同一个结论。 */
export async function archiveStaleTasks(now = Date.now()): Promise<number> {
  let n = 0;
  for (const t of listTasks(["review", "blocked"], 200)) {
    if (!t.source.conversation) continue;
    const idle = now - Date.parse(t.updatedAt);
    if (idle < STALE_MS) continue;
    if ((t.pending ?? []).some((p) => EXECUTABLE.has(p.type))) continue;
    if (!(await finishTask(t.id, "ignored", "超过一天没动，自动归档"))) continue;
    const days = Math.floor(idle / 86400_000);
    record({
      taskId: t.id,
      action: "archived_stale",
      why: `这条挂了 ${days} 天没动`,
      how: "自动归档，回复草稿作废，没有发出去",
      evidence: { conversation: t.source.conversation, idleDays: days },
      risk: "reversible",
      undo: { kind: "reopen_task", id: t.id, status: t.status },
    });
    n += 1;
  }
  return n;
}
