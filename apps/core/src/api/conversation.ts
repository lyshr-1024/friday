import { Hono } from "hono";
import { isRunning, partialAnswer, runningIds } from "../agent/runs.js";
import { createConversation, currentConversation, deleteConversation, getConversation, listConversations } from "../memory/conversations.js";

export const conversation = new Hono()
  .get("/conversations", (c) => {
    const running = new Set(runningIds());
    return c.json(listConversations().map((conv) => ({ ...conv, running: running.has(conv.id) })));
  })
  .get("/conversation", (c) => {
    const conv = currentConversation();
    return c.json({ ...conv, running: isRunning(conv.id), partial: partialAnswer(conv.id) ?? "" });
  })
  .get("/conversation/:id", (c) => {
    const conv = getConversation(c.req.param("id"));
    return conv ? c.json({ ...conv, running: isRunning(conv.id), partial: partialAnswer(conv.id) ?? "" }) : c.json({ error: "会话不存在" }, 404);
  })
  .post("/conversation/new", (c) => c.json(createConversation(), 201))
  .delete("/conversation/:id", (c) => (deleteConversation(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "会话不存在" }, 404)));
