import { Hono } from "hono";
import { z } from "zod";
import { mainConversationId } from "../memory/mainConversation.js";
import { addMessage, conversationExists } from "../memory/conversations.js";
import { addNoteTask } from "../memory/noteTask.js";

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
    const task = addNoteTask({ ...input, ...(conversationId && conversationId !== mainConversationId() ? { source: { conversationId } } : {}) });
    if (conversationId && conversationExists(conversationId)) {
      addMessage(conversationId, { role: "user", kind: "note", content: `记 ${task.title}` });
      addMessage(conversationId, { role: "assistant", kind: "note", content: `已记到待办：${task.title}`, payload: task });
    }
    return c.json(task, 201);
  });
