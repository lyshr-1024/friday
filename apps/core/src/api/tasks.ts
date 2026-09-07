import { Hono } from "hono";
import { z } from "zod";
import type { Task } from "@friday/shared";
import { undoWrite } from "../agent/autowrite.js";
import { executePending } from "../agent/pipeline.js";
import { loadSlackCreds, postMessage, slackCaller } from "../connectors/slack.js";
import { listAudit, record, setEventStatus, undoPlan } from "../memory/audit.js";
import { createTask, getTask, taskBoard, updateTask } from "../memory/tasks.js";

const newTask = z.object({
  title: z.string().trim().min(1).max(200),
  note: z.string().max(4000).optional(),
  url: z.string().url().optional(),
  project: z.string().max(80).optional(),
  due: z.iso.date().optional(),
});

export const tasks = new Hono()
  .get("/tasks", (c) => c.json(taskBoard()))
  .get("/tasks/:id", (c) => {
    const t = getTask(c.req.param("id"));
    return t ? c.json(t) : c.json({ error: "任务不存在" }, 404);
  })
  // 口头 / 文档：用户直接交代的事
  .post("/tasks", async (c) => {
    const parsed = newTask.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "title 不能为空" }, 400);
    const { title, note, url, project, due } = parsed.data;
    const t = createTask({ title, kind: url ? "doc" : "verbal", source: { ...(note ? { note } : {}), ...(url ? { url } : {}) }, ...(project ? { project } : {}), ...(due ? { due } : {}) });
    record({ taskId: t.id, action: "task_create", why: "你交代的", how: url ? "带文档链接建任务" : "建任务", evidence: { title, note: note ?? null, url: url ?? null }, risk: "read" });
    return c.json(t, 201);
  })
  .post("/tasks/:id/approve/:actionId", async (c) => {
    const creds = await loadSlackCreds();
    const call = creds ? slackCaller(creds) : undefined;
    try {
      const t: Task = await executePending(c.req.param("id"), c.req.param("actionId"), {
        slackPost: async (channel, text, threadTs) => {
          if (!call) throw new Error("Slack 未接入");
          return postMessage(call, channel, text, threadTs);
        },
      });
      return c.json(t);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      record({ taskId: c.req.param("id"), action: "approve_failed", why: "执行审核通过的动作失败", how: message, risk: "irreversible", status: "failed" });
      return c.json({ error: message }, 500);
    }
  })
  .post("/tasks/:id/reject", async (c) => {
    const { reason } = (await c.req.json().catch(() => ({}))) as { reason?: string };
    const t = getTask(c.req.param("id"));
    if (!t) return c.json({ error: "任务不存在" }, 404);
    record({ taskId: t.id, action: "review_rejected", why: reason ?? "你打回了", how: "任务退回处理中，待审核动作作废", evidence: { reason: reason ?? null, dropped: (t.pending ?? []).map((p) => p.label) }, risk: "read" });
    return c.json(updateTask(t.id, { status: "processing", pending: [], progress: `被打回：${reason ?? "无说明"}` }));
  })
  .post("/tasks/:id/done", (c) => {
    const t = updateTask(c.req.param("id"), { status: "done", pending: [] });
    return t ? c.json(t) : c.json({ error: "任务不存在" }, 404);
  })
  .post("/tasks/:id/ignore", (c) => {
    const t = updateTask(c.req.param("id"), { status: "ignored", pending: [] });
    return t ? c.json(t) : c.json({ error: "任务不存在" }, 404);
  })
  .get("/audit", (c) => c.json(listAudit({ ...(c.req.query("taskId") ? { taskId: c.req.query("taskId")! } : {}), limit: Number(c.req.query("limit") ?? 200) })))
  .post("/audit/:id/undo", (c) => {
    const plan = undoPlan(c.req.param("id"));
    if (!plan) return c.json({ error: "这笔不可撤销" }, 400);
    const ok = undoWrite(plan);
    if (ok) setEventStatus(c.req.param("id"), "undone");
    return ok ? c.json({ ok: true }) : c.json({ error: "撤销失败（内容可能已被改动）" }, 409);
  });
