import { Hono } from "hono";
import { markDepReady, setBriefSize, startBriefJob } from "../agent/briefJob.js";

export const brief = new Hono()
  .post("/tasks/:id/brief", async (c) => {
    try {
      const r = await startBriefJob(c.req.param("id"));
      return "error" in r ? c.json({ error: r.error }, r.status) : c.json(r);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  })
  .patch("/tasks/:id/brief", async (c) => {
    const { size } = await c.req.json<{ size?: unknown }>().catch(() => ({ size: undefined }));
    if (size !== "small" && size !== "large") return c.json({ error: "size 只能是 small 或 large" }, 400);
    const r = setBriefSize(c.req.param("id"), size);
    return typeof r === "string" ? c.json({ error: r }, 404) : c.json(r);
  })
  .post("/tasks/:id/brief/deps/:index/ready", (c) => {
    const index = Number(c.req.param("index"));
    if (!Number.isInteger(index)) return c.json({ error: "依赖下标得是整数" }, 400);
    const r = markDepReady(c.req.param("id"), index);
    return typeof r === "string" ? c.json({ error: r }, 404) : c.json(r);
  });
