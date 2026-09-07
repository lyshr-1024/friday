import { Hono } from "hono";
import { buildDesk } from "../agent/desk.js";

export const desk = new Hono().get("/desk", async (c) => c.json(await buildDesk()));
