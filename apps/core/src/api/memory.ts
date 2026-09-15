import { Hono } from "hono";
import { z } from "zod";
import type { MemoryFileResponse } from "@friday/shared";
import { memoryPath, readMemoryFile, writeMemoryFile } from "../memory/files.js";
import { handbookPath, listHandbooks, readHandbook, writeHandbook } from "../memory/handbooks.js";

const name = z.enum(["projects", "decisions", "people"]);
const body = z.object({ content: z.string().max(200_000) });

/** 手册文件名由项目名来，只放行已经存在的那些，不让任意路径写进记忆库目录 */
const knownHandbook = (slug: string): boolean => listHandbooks().includes(slug);

export const memory = new Hono()
  .get("/handbooks", (c) => c.json({ files: listHandbooks() }))
  .get("/handbooks/:slug", (c) => {
    const slug = c.req.param("slug");
    if (!knownHandbook(slug)) return c.json({ error: "没有这份手册" }, 404);
    return c.json({ name: slug, path: handbookPath(slug), content: readHandbook(slug) });
  })
  .put("/handbooks/:slug", async (c) => {
    const slug = c.req.param("slug");
    if (!knownHandbook(slug)) return c.json({ error: "没有这份手册" }, 404);
    const data = body.safeParse(await c.req.json().catch(() => null));
    if (!data.success) return c.json({ error: "content 必须是字符串" }, 400);
    writeHandbook(slug, data.data.content);
    return c.json({ name: slug, path: handbookPath(slug), content: data.data.content });
  })
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
