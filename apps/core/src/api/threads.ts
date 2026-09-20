import { Hono } from "hono";
import type { ThreadsResponse } from "@friday/shared";
import { buildBrief } from "../agent/brief.js";
import { enrichThread } from "../agent/enrich.js";
import { applyReversibleWrites } from "../agent/autowrite.js";
import { threadToTask } from "../agent/pipeline.js";
import { getThread, listThreads, setThreadBrief, setThreadStatus } from "../memory/threads.js";
import { clearTombstone } from "../memory/tasks.js";
import { state } from "../scheduler/index.js";

export const threads = new Hono()
  .get("/threads", (c) => {
    const res: ThreadsResponse = { threads: listThreads("open"), lastSyncAt: state.lastSyncAt, nextSyncAt: state.nextSyncAt, lastError: state.lastError, configured: state.configured };
    return c.json(res);
  })
  .get("/threads/:id", (c) => {
    const t = getThread(c.req.param("id"));
    return t ? c.json(t) : c.json({ error: "线程不存在" }, 404);
  })
  // 手动重做功课（比如补了 people.md 或项目频道之后）
  .post("/threads/:id/refresh", async (c) => {
    const t = getThread(c.req.param("id"));
    if (!t) return c.json({ error: "线程不存在" }, 404);
    // 你亲手点的「重做功课」，意图明确：撤掉墓碑，让它重新建得出来
    clearTombstone({ threadId: t.id });
    const enrichment = await enrichThread(t);
    const brief = await buildBrief(t, enrichment);
    if (!brief) return c.json({ error: "情境卡生成失败" }, 502);
    // 你亲手点的「重做功课」：这时才建任务
    const task = await threadToTask(t, brief, enrichment.project?.name, { create: true });
    const writes = applyReversibleWrites(t, brief, task?.id);
    setThreadBrief(t.id, { ...brief, context: [...brief.context, ...writes], ...(enrichment.context.length ? { priorMessages: enrichment.context } : {}) }, enrichment.project?.name);
    return c.json(getThread(t.id));
  })
  .post("/threads/:id/done", (c) => (setThreadStatus(c.req.param("id"), "done") ? c.json({ ok: true }) : c.json({ error: "线程不存在" }, 404)))
  .post("/threads/:id/ignore", (c) => (setThreadStatus(c.req.param("id"), "ignored") ? c.json({ ok: true }) : c.json({ error: "线程不存在" }, 404)));
