import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Snapshot, SummonAction } from "@friday/shared";
import { summon } from "../agent/summon/index.js";
import { addNoteTask } from "../memory/noteTask.js";
import { getTask, updateTask } from "../memory/tasks.js";
import { readMemoryFile, writeMemoryFile } from "../memory/files.js";

export const summonApi = new Hono()
  .post("/summon", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { snapshot?: Snapshot };
    if (!body.snapshot?.app) return c.json({ error: "缺 snapshot" }, 400);
    return streamSSE(c, async (stream) => {
      for await (const ev of summon(body.snapshot!)) await stream.writeSSE({ data: JSON.stringify(ev) });
    });
  })
  .post("/summon/act", async (c) => {
    const { action } = (await c.req.json().catch(() => ({}))) as { action?: SummonAction };
    if (!action?.kind) return c.json({ error: "缺 action" }, 400);
    switch (action.kind) {
      case "create_task": {
        const task = addNoteTask({ text: action.title, source: { summon: true } });
        return c.json({ ok: true, taskId: task.id, message: "已建成任务" });
      }
      case "mark_done": {
        if (!getTask(action.taskId)) return c.json({ error: "任务不存在" }, 404);
        updateTask(action.taskId, { status: "done", attention: undefined, pending: [] });
        return c.json({ ok: true, taskId: action.taskId, message: "已标完成" });
      }
      case "note": {
        writeMemoryFile("decisions", `${readMemoryFile("decisions")}\n- ${action.text}\n`);
        return c.json({ ok: true, message: "已记进记忆库" });
      }
      default:
        return c.json({ error: `不支持的动作 ${action.kind}` }, 400);
    }
  });
