import { Hono } from "hono";
import { startQueryJob } from "../agent/slack/queryJob.js";
import { channelNode, conversationKey, slackNode, taskNode } from "../memory/infer.js";
import { CONV_SCAN_LIMIT, listInbox } from "../memory/inbox.js";
import { linkUp, neighbors, unlink } from "../memory/links.js";
import { addNoteTask } from "../memory/noteTask.js";
import { getTask } from "../memory/tasks.js";

const bare = (name: string) => name.replace(/^#/, "");

const findConversation = (conv: string) => listInbox(true, CONV_SCAN_LIMIT).filter((i) => conversationKey(i) === conv).sort((a, b) => Number(a.ts) - Number(b.ts));

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
  })
  // 按需求建的频道：整个频道归到一条需求上，同频道后续消息直接查表
  .post("/slack/channel/:name/task", async (c) => {
    const name = bare(c.req.param("name"));
    const { taskId } = (await c.req.json().catch(() => ({}))) as { taskId?: string };
    if (!taskId || !getTask(taskId)) return c.json({ error: "任务不存在" }, 404);
    linkUp(channelNode(name), taskNode(taskId), "user", "你手动指定这个频道对应这条需求");
    return c.json({ ok: true });
  })
  .delete("/slack/channel/:name/task/:taskId", (c) => {
    unlink(channelNode(bare(c.req.param("name"))), taskNode(c.req.param("taskId")), "你说过这个频道不对应这条需求");
    return c.json({ ok: true });
  })
  .get("/slack/channels", (c) => {
    const counts = new Map<string, number>();
    for (const i of listInbox(true, CONV_SCAN_LIMIT)) {
      if (i.kind !== "mention") continue;
      const name = bare(i.channelName);
      if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const channels = [...counts].map(([name, messageCount]) => {
      const hit = neighbors(channelNode(name), "task").map((n) => ({ n, task: getTask(n.ref) })).find((x) => x.task);
      return {
        name,
        messageCount,
        ...(hit ? { taskId: hit.n.ref, taskTitle: hit.task!.title, source: hit.n.source, why: hit.n.why } : {}),
      };
    });
    channels.sort((a, b) => b.messageCount - a.messageCount);
    return c.json({ channels });
  });
