import { record } from "../../memory/audit.js";
import { listInbox } from "../../memory/inbox.js";
import { conversationKey } from "../../memory/infer.js";
import { listTasks, removePending, updateTask } from "../../memory/tasks.js";

const OPEN = ["processing", "review", "blocked"] as const;

/** 消息状态以 Slack 为准，这是「已经处理完的事又冒出来」的根治点。 */
export function settleQueryTasks(): number {
  const settled = new Set(
    listInbox(true, 500)
      .filter((i) => i.done)
      .map(conversationKey),
  );
  let n = 0;
  for (const t of listTasks([...OPEN], 200)) {
    const conv = t.source.conversation;
    if (!conv || !settled.has(conv) || !t.source.headless) continue;
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
