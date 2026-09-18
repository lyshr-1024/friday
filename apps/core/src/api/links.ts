import { Hono } from "hono";
import { z } from "zod";
import type { LinkKind } from "@friday/shared";
import { allLinks, linkUp, linksOf, unlink } from "../memory/links.js";
import { projectOfUrl } from "../memory/infer.js";
import { record } from "../memory/audit.js";

const KINDS = ["task", "meegle", "thread", "branch", "url", "project"] as const;
const node = z.object({ kind: z.enum(KINDS), ref: z.string().min(1).max(400) });
const edge = z.object({ from: node, to: node, why: z.string().max(200).optional() });

export const links = new Hono()
  .get("/links", (c) => {
    const kind = c.req.query("kind") as LinkKind | undefined;
    const ref = c.req.query("ref");
    if (kind && ref) return c.json({ links: linksOf({ kind, ref }) });
    return c.json({ links: allLinks() });
  })
  // 你说「这个是对的」：记成 user 级，之后的自动推断不会改它
  .post("/links", async (c) => {
    const parsed = edge.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "from / to 不合法" }, 400);
    const { from, to, why } = parsed.data;
    const link = linkUp(from, to, "user", why ?? "你指定的关联");
    if (!link) return c.json({ error: "这两个连不起来" }, 400);
    record({ action: "link_set", why: "用户指定关联", how: `${from.kind}:${from.ref} ↔ ${to.kind}:${to.ref}`, evidence: { from, to }, risk: "reversible" });
    return c.json({ link });
  })
  // 你说「这个不对」：断开并记否决，自动推断不会再连回来
  .post("/links/reject", async (c) => {
    const parsed = edge.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "from / to 不合法" }, 400);
    const { from, to, why } = parsed.data;
    unlink(from, to, why ?? "你说过这两个不是一回事");
    record({ action: "link_rejected", why: why ?? "用户否决了这条关联", how: `断开 ${from.kind}:${from.ref} ↔ ${to.kind}:${to.ref}`, evidence: { from, to }, risk: "reversible" });
    return c.json({ ok: true });
  })
  // 浏览器 A 档：你在哪个页面 → 哪个项目
  .get("/links/by-url", (c) => {
    const url = c.req.query("url") ?? "";
    if (!url) return c.json({ error: "缺 url" }, 400);
    const project = projectOfUrl(url);
    return c.json({ project: project ?? null, links: linksOf({ kind: "url", ref: url }) });
  });
