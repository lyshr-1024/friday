import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Snapshot, SummonAction } from "@friday/shared";
import { summon } from "../agent/summon/index.js";
import { finishTask } from "../agent/pipeline.js";
import { addNoteTask } from "../memory/noteTask.js";
import { getTask } from "../memory/tasks.js";
import { readMemoryFile, writeMemoryFile } from "../memory/files.js";

export const summonApi = new Hono()
  .post("/summon", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { snapshot?: Snapshot };
    if (!body.snapshot?.app) return c.json({ error: "缺 snapshot" }, 400);
    // 判断不对时第一个要问的是「它到底看到了什么」：标题空多半是辅助功能权限没给
    const a = body.snapshot.app;
    console.log(`[summon] ${a.name} 标题=${JSON.stringify(a.title)} 权限(辅助/自动化/录屏)=${[body.snapshot.permissions.accessibility, body.snapshot.permissions.automation, body.snapshot.permissions.screen].map((x) => (x ? "√" : "×")).join("")}`);
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
        await finishTask(action.taskId, "done", "在呼出模式里标记完成");
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
