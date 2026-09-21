import { Hono } from "hono";
import { startQueryJob } from "../agent/slack/queryJob.js";
import { conversationKey, slackNode, taskNode } from "../memory/infer.js";
import { listInbox } from "../memory/inbox.js";
import { linkUp, unlink } from "../memory/links.js";
import { addNoteTask } from "../memory/noteTask.js";
import { getTask } from "../memory/tasks.js";

const findConversation = (conv: string) => listInbox(true, 500).filter((i) => conversationKey(i) === conv).sort((a, b) => Number(a.ts) - Number(b.ts));

export const slack = new Hono()
  .post("/slack/:conv/attach", async (c) => {
    const conv = c.req.param("conv");
    const { taskId } = (await c.req.json().catch(() => ({}))) as { taskId?: string };
    if (!taskId || !getTask(taskId)) return c.json({ error: "任务不存在" }, 404);
    if (!findConversation(conv).length) return c.json({ error: "对话不存在" }, 404);
    linkUp(slackNode(conv), taskNode(taskId), "user", "你手动挂的");
    return c.json({ ok: true });
  })
  .delete("/slack/:conv/attach/:taskId", (c) => {
    unlink(slackNode(c.req.param("conv")), taskNode(c.req.param("taskId")), "你说过这段对话不是这条任务");
    return c.json({ ok: true });
  })
  .post("/slack/:conv/query", async (c) => {
    const items = findConversation(c.req.param("conv"));
    const last = items.at(-1);
    if (!last) return c.json({ error: "对话不存在" }, 404);
    const task = await startQueryJob(last, last.text, undefined);
    return task ? c.json(task) : c.json({ error: "没有可查的项目，projects.md 里先登记一个" }, 400);
  })
  .post("/slack/:conv/task", (c) => {
    const conv = c.req.param("conv");
    const items = findConversation(conv);
    const first = items[0];
    if (!first) return c.json({ error: "对话不存在" }, 404);
    const task = addNoteTask({ text: first.text, source: { conversation: conv, channelId: first.channelId, userName: first.userName, ...(first.threadTs ? { threadTs: first.threadTs } : {}) } });
    linkUp(slackNode(conv), taskNode(task.id), "user", "你把这段对话建成了任务");
    return c.json(task);
  });
