import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { clearHistory, killWindow, listWindows, newWindow, searchBack, selectWindow, splitWindow } from "../agent/tmux.js";
import { getTermSession, markSeen } from "../memory/termSessions.js";
import { publish } from "../bus.js";

const body = async <T extends z.ZodTypeAny>(c: { req: { json(): Promise<unknown> } }, schema: T) => schema.safeParse(await c.req.json().catch(() => null));
const cwdOf = (id: string) => { const s = getTermSession(id)!; return s.worktree ?? s.repoDir; };

export function ghosttyPrefs(file = join(homedir(), ".config", "ghostty", "config")): { fontFamily?: string; fontSize?: number } {
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch { return {}; }
  const val = (k: string) => text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith(k)).map((l) => l.split("=").slice(1).join("=").trim().replace(/^"|"$/g, "")).at(-1);
  const size = Number(val("font-size"));
  return { ...(val("font-family") ? { fontFamily: val("font-family")! } : {}), ...(size > 0 ? { fontSize: size } : {}) };
}

const pbcopy = (text: string) =>
  new Promise<void>((resolve, reject) => {
    const child = execFile("/usr/bin/pbcopy", { timeout: 3000 }, (err) => (err ? reject(err) : resolve()));
    child.stdin?.on("error", reject);
    child.stdin?.end(text);
  });
let clipboardWriter: (text: string) => Promise<void> = pbcopy;
export function setClipboardWriter(fn: (text: string) => Promise<void>): void {
  clipboardWriter = fn;
}

export const sessions = new Hono()
  .use("/sessions/:id/*", async (c, next) => (getTermSession(c.req.param("id")) ? next() : c.json({ error: "没有这个会话", gone: true }, 404)))
  .post("/sessions/:id/seen", (c) => {
    markSeen(c.req.param("id"));
    publish({ type: "tasks" });
    return c.json({ ok: true });
  })
  .get("/sessions/:id/windows", async (c) => c.json(await listWindows(getTermSession(c.req.param("id"))!.tmuxName)))
  .post("/sessions/:id/windows", async (c) => {
    await newWindow(getTermSession(c.req.param("id"))!.tmuxName, cwdOf(c.req.param("id")));
    return c.json({ ok: true });
  })
  .post("/sessions/:id/windows/:idx/select", async (c) => {
    await selectWindow(getTermSession(c.req.param("id"))!.tmuxName, Number(c.req.param("idx")));
    return c.json({ ok: true });
  })
  .delete("/sessions/:id/windows/:idx", async (c) => c.json({ closed: await killWindow(getTermSession(c.req.param("id"))!.tmuxName, Number(c.req.param("idx"))) }))
  .post("/sessions/:id/split", async (c) => {
    const p = await body(c, z.object({ dir: z.enum(["h", "v"]) }));
    if (!p.success) return c.json({ error: "dir 是 h 或 v" }, 400);
    await splitWindow(getTermSession(c.req.param("id"))!.tmuxName, cwdOf(c.req.param("id")), p.data.dir);
    return c.json({ ok: true });
  })
  .post("/sessions/:id/search", async (c) => {
    const p = await body(c, z.object({ q: z.string().min(1).max(200) }));
    if (!p.success) return c.json({ error: "q 必填" }, 400);
    await searchBack(getTermSession(c.req.param("id"))!.tmuxName, p.data.q);
    return c.json({ ok: true });
  })
  .post("/sessions/:id/clear", async (c) => {
    await clearHistory(getTermSession(c.req.param("id"))!.tmuxName);
    return c.json({ ok: true });
  })
  .post("/clipboard", async (c) => {
    if (!c.req.header("content-type")?.startsWith("application/json")) return c.json({ error: "content-type 必须是 application/json" }, 415);
    const p = await body(c, z.object({ text: z.string().max(1_000_000) }));
    if (!p.success) return c.json({ error: "text 必填" }, 400);
    try {
      await clipboardWriter(p.data.text);
    } catch {
      return c.json({ error: "写入剪贴板失败" }, 500);
    }
    return c.json({ ok: true });
  })
  .get("/terminal/prefs", (c) => c.json(ghosttyPrefs()));
