import { Hono } from "hono";
import { createConversation, currentConversation } from "../memory/conversations.js";

export const conversation = new Hono()
  .get("/conversation", (c) => c.json(currentConversation()))
  .post("/conversation/new", (c) => c.json(createConversation(), 201));
