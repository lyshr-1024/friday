import { Hono } from "hono";
import { startBriefJob } from "../agent/briefJob.js";

export const brief = new Hono().post("/tasks/:id/brief", async (c) => {
  try {
    const r = await startBriefJob(c.req.param("id"));
    return "error" in r ? c.json({ error: r.error }, r.status) : c.json(r);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
