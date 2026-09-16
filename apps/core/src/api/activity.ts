import { Hono } from "hono";
import { z } from "zod";
import { addShellActivity } from "../memory/activity.js";

const body = z.object({
  cwd: z.string().trim().min(1),
  branch: z.string().trim().max(200).optional(),
  cmd: z.string().trim().max(2000).optional(),
  exitCode: z.number().int().optional(),
});

export const activity = new Hono().post("/activity", async (c) => {
  const parsed = body.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "cwd 不能为空" }, 400);
  const { exitCode, ...rest } = parsed.data;
  addShellActivity({ ...rest, ...(exitCode !== undefined ? { exitCode } : {}) });
  return c.json({ ok: true });
});
