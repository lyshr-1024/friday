import { Hono } from "hono";
import { z } from "zod";
import { addMessage, conversationExists } from "../memory/conversations.js";
import type { TodoSource, TodosSyncResponse } from "@friday/shared";
import { connectors } from "../connectors/index.js";
import { addLocalTodo, listOpenTodos, syncSourceTodos } from "../memory/todos.js";

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
  .get("/todos", async (c) => {
    if (c.req.query("sync") !== "1") return c.json(listOpenTodos());
    const sourceErrors: Partial<Record<TodoSource, string>> = {};
    await Promise.all(
      connectors.map(async (conn) => {
        try {
          syncSourceTodos(conn.source as Exclude<TodoSource, "local">, await conn.fetchTodos());
        } catch (e) {
          sourceErrors[conn.source] = e instanceof Error ? e.message : String(e);
        }
      }),
    );
    const res: TodosSyncResponse = { syncedAt: new Date().toISOString(), todos: listOpenTodos(), sourceErrors };
    return c.json(res);
  });
