import { Hono } from "hono";
import { createConversation, currentConversation, deleteConversation, getConversation, listConversations } from "../memory/conversations.js";

export const conversation = new Hono()
  .get("/conversations", (c) => c.json(listConversations()))
  .get("/conversation", (c) => c.json(currentConversation()))
  .get("/conversation/:id", (c) => {
    const conv = getConversation(c.req.param("id"));
    return conv ? c.json(conv) : c.json({ error: "会话不存在" }, 404);
  })
  .post("/conversation/new", (c) => c.json(createConversation(), 201))
  .delete("/conversation/:id", (c) => (deleteConversation(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "会话不存在" }, 404)));
