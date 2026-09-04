import { Hono } from "hono";
import { z } from "zod";
import type { MemoryFileResponse } from "@friday/shared";
import { memoryPath, readMemoryFile, writeMemoryFile } from "../memory/files.js";

const name = z.enum(["projects", "decisions", "people"]);
const body = z.object({ content: z.string().max(200_000) });

export const memory = new Hono()
  .get("/memory/:name", (c) => {
    const parsed = name.safeParse(c.req.param("name"));
    if (!parsed.success) return c.json({ error: "未知文件" }, 404);
    const res: MemoryFileResponse = { name: parsed.data, path: memoryPath(parsed.data), content: readMemoryFile(parsed.data) };
    return c.json(res);
  })
  .put("/memory/:name", async (c) => {
    const parsed = name.safeParse(c.req.param("name"));
    if (!parsed.success) return c.json({ error: "未知文件" }, 404);
    const data = body.safeParse(await c.req.json().catch(() => null));
    if (!data.success) return c.json({ error: "content 必须是字符串" }, 400);
    writeMemoryFile(parsed.data, data.data.content);
    const res: MemoryFileResponse = { name: parsed.data, path: memoryPath(parsed.data), content: data.data.content };
    return c.json(res);
  });
