import type { Task, TaskStatus } from "@friday/shared";
import { record } from "../memory/audit.js";
import { lessonFromTask } from "./lessons.js";
import { listTasks, addPending, getTask, removePending, updatePending, updateTask } from "../memory/tasks.js";
import { listThreads } from "../memory/threads.js";
import { loadProjects } from "../memory/projects.js";
import { addProjectHints, hintsFrom } from "../memory/projectHints.js";
import { closeTaskTerminal } from "./terminal.js";
import { closeTaskThread } from "./pipeline.js";

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
  /** 重写「通过前请确认」那几条。方案改了之后旧列表就对不上了，得能从会话里换掉 */
  verify?: string[];
  /** 用户回答「这条是哪个项目的」：归属写到任务上，线索沉淀进 projects.md */
  project?: string;
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

  const project = patch.project?.trim();
  if (project && project !== task.project) {
    const known = loadProjects().find((p) => p.name === project);
    if (known) {
      // 用户答了归属就把 Friday 的提问清掉——问题已经解决，不该还挂在「待我决定」里。
      // 终端在问的（question）是另一回事，它还在等答案，不能顺手清。
      task = updateTask(taskId, { project: known.name, ...(task.attention === "intake" ? { attention: undefined } : {}) })!;
      changed.push(`项目 → ${known.name}`);
      // 顺带记住线索：标题里的【BO】这类标记、工单页面的地址前缀，下次同类自动归
      const links = [task.source.url, ...(task.understanding ?? "").match(/https?:\/\/[^\s)）」】]+/g) ?? []].filter((u): u is string => Boolean(u));
      const hints = hintsFrom(task.title, links);
      const r = addProjectHints(known.name, hints);
      if (r.changed) changed.push(`记住线索（${[...r.added.aliases, ...r.added.urls].join("、")}）`);
      // 同一个需求下的其他几条归属是同一个答案，一起定了，别再逐条问
      const story = task.source.linkedStoryId;
      if (story) {
        const siblings = listTasks().filter(
          (t) => t.id !== taskId && t.source.linkedStoryId === story && !t.project && t.status !== "done" && t.status !== "ignored",
        );
        for (const s of siblings) {
          updateTask(s.id, { project: known.name, ...(s.attention === "intake" ? { attention: undefined, progress: `归属跟着同需求那条一起定了：${known.name}` } : {}) });
        }
        if (siblings.length) changed.push(`同需求另外 ${siblings.length} 条一起归到 ${known.name}`);
      }
    }
  }

  const verify = patch.verify?.map((v) => v.trim()).filter(Boolean).slice(0, 12);
  if (verify?.length && JSON.stringify(verify) !== JSON.stringify(task.report?.verify ?? [])) {
    const prev = task.report;
    task = updateTask(taskId, {
      report: {
        summary: prev?.summary ?? "",
        changes: prev?.changes ?? [],
        testSteps: prev?.testSteps ?? [],
        testResult: prev?.testResult ?? "",
        screenshots: prev?.screenshots ?? [],
        verify,
        at: new Date().toISOString(),
        // 换了列表就把勾选清掉：新条目没人验过，继承旧勾会让用户以为验过了
        checked: verify.map(() => false),
      },
    })!;
    changed.push(prev?.verify?.length ? "验收列表（已勾选状态清零）" : "验收列表");
  }

  const reply = (task.pending ?? []).find((p) => p.type === "slack_reply");
  if (patch.dropReply && reply) {
    // 「不用回了」跟在列表里忽略是同一个判断：Friday 认为该回，你说不用
    task = removePending(taskId, reply.id) ?? task;
    changed.push("撤掉回复");
  } else if (patch.replyDraft?.trim()) {
    const text = patch.replyDraft.trim().slice(0, 2000);
    if (reply) {
      if (text !== reply.detail) {
        // 标记改过：审核通过时不再按「原样发出」记一笔
        task = updatePending(taskId, reply.id, { detail: text, payload: { ...reply.payload, text, edited: true } }) ?? task;
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
    // 收工时草稿还挂着 = 没用上它，跟列表里点完成 / 忽略记一样的经验
    task = updateTask(taskId, { status: patch.status, attention: undefined, ...(closing ? { pending: [] } : {}) })!;
    changed.push(`状态 → ${STATUS_LABEL[patch.status]}`);
    if (closing) lessonFromTask(task, patch.status === "ignored" ? "ignored" : "done_without_reply");
    if (closing) {
      closeTaskTerminal(task, "用户在会话里说这条任务收工了");
      closeTaskThread(task, patch.status === "ignored" ? "ignored" : "done");
      const t = task;
      void import("./pipeline.js").then((m) => m.cleanupTaskWorktree(t, "用户在会话里说这条任务收工了")).catch(() => {});
    }
  }

  if (changed.length) {
    record({ taskId, action: "task_update", why, how: `改了：${changed.join("、")}`, evidence: { ...patch }, risk: "reversible" });
  }
  return { task, changed };
}
