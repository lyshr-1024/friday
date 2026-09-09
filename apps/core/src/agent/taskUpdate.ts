import type { Task, TaskStatus } from "@friday/shared";
import { record } from "../memory/audit.js";
import { addPending, getTask, removePending, updatePending, updateTask } from "../memory/tasks.js";
import { listThreads } from "../memory/threads.js";

export interface TaskPatch {
  understanding?: string;
  plan?: string;
  progress?: string;
  /** 改写（或新建）待审的 Slack 回复草稿：用户点「通过并执行」发的就是这段 */
  replyDraft?: string;
  /** 用户决定不用回了：撤掉待审的 Slack 回复 */
  dropReply?: boolean;
  /** 用户在会话里说"做完了 / 不用管了 / 先放着 / 卡住了"：任务状态由用户定，Friday 只是执行 */
  status?: Extract<TaskStatus, "processing" | "review" | "blocked" | "done" | "ignored">;
}

const STATUS_LABEL: Record<string, string> = { processing: "Friday 在做", review: "等你决定", blocked: "卡住了", done: "已完成", ignored: "已忽略" };

/** 会话里聊出来的结论回流到任务卡：理解 / 方案 / 进展 / 回复草稿。都是可逆写，留痕。 */
export function updateTaskFromChat(taskId: string, patch: TaskPatch, why = "会话里和用户聊出来的"): { task: Task; changed: string[] } | undefined {
  let task = getTask(taskId);
  if (!task) return undefined;
  const changed: string[] = [];

  const fields: Partial<Pick<Task, "understanding" | "plan" | "progress">> = {};
  for (const k of ["understanding", "plan", "progress"] as const) {
    const v = patch[k]?.trim();
    if (v && v !== task[k]) {
      fields[k] = v.slice(0, 4000);
      changed.push({ understanding: "理解", plan: "方案", progress: "进展" }[k]);
    }
  }
  if (Object.keys(fields).length) task = updateTask(taskId, fields)!;

  const reply = (task.pending ?? []).find((p) => p.type === "slack_reply");
  if (patch.dropReply && reply) {
    task = removePending(taskId, reply.id) ?? task;
    changed.push("撤掉回复");
  } else if (patch.replyDraft?.trim()) {
    const text = patch.replyDraft.trim().slice(0, 2000);
    if (reply) {
      if (text !== reply.detail) {
        task = updatePending(taskId, reply.id, { detail: text, payload: { ...reply.payload, text } }) ?? task;
        changed.push("回复草稿");
      }
    } else if (task.source.threadId) {
      // 之前没挂回复动作：从 Slack 线程补齐频道 / 线程 ts
      const thread = listThreads("all", 300).find((t) => t.id === task!.source.threadId);
      const first = thread?.items[0];
      if (thread && first) {
        task = addPending(taskId, {
          type: "slack_reply",
          label: `回复 ${thread.userName}`,
          detail: text,
          payload: { channel: first.channelId, text, ...(thread.kind === "mention" ? { threadTs: thread.items.at(-1)!.ts } : {}), userName: thread.userName },
        }) ?? task;
        changed.push("新挂回复草稿");
      }
    }
  }

  if (patch.status && patch.status !== task.status) {
    // 收工 / 忽略时把"等你看"标记和没发出去的待审动作一起清掉，不然列表里还挂着
    const closing = patch.status === "done" || patch.status === "ignored";
    task = updateTask(taskId, { status: patch.status, attention: undefined, ...(closing ? { pending: [] } : {}) })!;
    changed.push(`状态 → ${STATUS_LABEL[patch.status]}`);
  }

  if (changed.length) {
    record({ taskId, action: "task_update", why, how: `改了：${changed.join("、")}`, evidence: { ...patch }, risk: "reversible" });
  }
  return { task, changed };
}
