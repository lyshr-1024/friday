import { Hono } from "hono";
import { z } from "zod";
import { addMessage, conversationExists } from "../memory/conversations.js";
import { addLocalTodo, listOpenTodos } from "../memory/todos.js";

const body = z.object({
  text: z.string().trim().min(1).max(2000),
  due: z.iso.date().optional(),
  conversationId: z.string().uuid().optional(),
});

export const note = new Hono()
  .post("/note", async (c) => {
    const parsed = body.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "text 不能为空，due 需为 YYYY-MM-DD" }, 400);
    const { conversationId, ...input } = parsed.data;
    const todo = addLocalTodo(input);
    if (conversationId && conversationExists(conversationId)) {
      addMessage(conversationId, { role: "user", kind: "note", content: `记 ${todo.text}` });
      addMessage(conversationId, { role: "assistant", kind: "note", content: `已记录：${todo.text}`, payload: todo });
    }
    return c.json(todo, 201);
  })
  .get("/todos", (c) => c.json(listOpenTodos()));
