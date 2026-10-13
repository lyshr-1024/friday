import { Hono } from "hono";
import { z } from "zod";
import { busyReason, fireSchedule, toView } from "../agent/schedule.js";
import { record } from "../memory/audit.js";
import { deleteSchedule, getSchedule, listSchedules, setLastRun, updateSchedule } from "../memory/schedules.js";

export const schedules = new Hono()
  .get("/schedules", (c) => c.json({ items: listSchedules().map(toView) }))
  .patch("/schedules/:id", async (c) => {
    const p = z.object({ enabled: z.boolean() }).safeParse(await c.req.json().catch(() => null));
    if (!p.success) return c.json({ error: "要带 enabled" }, 400);
    const s = updateSchedule(c.req.param("id"), { enabled: p.data.enabled });
    if (!s) return c.json({ error: "没有这条定时任务" }, 404);
    record({ action: "schedule_updated", why: p.data.enabled ? "你打开了定时任务" : "你关掉了定时任务", how: s.title, evidence: { scheduleId: s.id }, risk: "reversible" });
    return c.json(toView(s));
  })
  .post("/schedules/:id/run", async (c) => {
    const s = getSchedule(c.req.param("id"));
    if (!s) return c.json({ error: "没有这条定时任务" }, 404);
    const busy = busyReason(s);
    if (busy) return c.json({ error: busy }, 409);
    const r = await fireSchedule(s, "manual");
    setLastRun(s.id, { ok: r.ok, result: r.result, ...(r.ref ? { ref: r.ref } : {}) });
    return c.json(r);
  })
  .delete("/schedules/:id", (c) => {
    const s = getSchedule(c.req.param("id"));
    if (!s || !deleteSchedule(s.id)) return c.json({ error: "没有这条定时任务" }, 404);
    record({ action: "schedule_removed", why: "你在定时任务列表里删了它", how: s.title, evidence: { schedule: s }, risk: "reversible" });
    return c.json({ ok: true });
  });
