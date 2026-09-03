import { Hono } from "hono";
import { z } from "zod";
import { addLocalTodo, listOpenTodos } from "../memory/todos.js";

const body = z.object({
  text: z.string().trim().min(1).max(2000),
  due: z.iso.date().optional(),
});

export const note = new Hono()
  .post("/note", async (c) => {
    const parsed = body.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "text 不能为空，due 需为 YYYY-MM-DD" }, 400);
    return c.json(addLocalTodo(parsed.data), 201);
  })
  .get("/todos", (c) => c.json(listOpenTodos()));
