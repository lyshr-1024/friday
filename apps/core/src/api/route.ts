import { Hono } from "hono";
import { z } from "zod";
import { route as routeConversation } from "../agent/route.js";

/** 用户在自由对话里说了第一句：判断接着哪段旧会话，还是新话题。 */
export const route = new Hono().post("/route", async (c) => {
  const parsed = z.object({ prompt: z.string().trim().min(1).max(4000) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "prompt 不能为空" }, 400);
  return c.json(await routeConversation(parsed.data.prompt));
});
