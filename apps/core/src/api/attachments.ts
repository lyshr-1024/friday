import { Hono } from "hono";
import { z } from "zod";
import { MAX_ATTACHMENT_BYTES, readAttachment, saveAttachment } from "../memory/attachments.js";

const body = z.object({
  name: z.string().min(1).max(200),
  mime: z.string().min(1).max(100),
  data: z.string().min(1),
});

export const attachments = new Hono()
  .post("/attachments", async (c) => {
    const parsed = body.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "需要 name / mime / base64 data" }, 400);
    const buf = Buffer.from(parsed.data.data, "base64");
    if (!buf.length) return c.json({ error: "内容为空" }, 400);
    if (buf.length > MAX_ATTACHMENT_BYTES) return c.json({ error: "附件超过 20MB" }, 413);
    return c.json(saveAttachment(parsed.data.name, parsed.data.mime, buf), 201);
  })
  .get("/attachments/:id", (c) => {
    const found = readAttachment(c.req.param("id"));
    if (!found) return c.json({ error: "附件不存在" }, 404);
    c.header("content-type", found.meta.mime);
    c.header("cache-control", "private, max-age=86400");
    c.header("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(found.meta.name)}`);
    return c.body(new Uint8Array(found.data));
  });
