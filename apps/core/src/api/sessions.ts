import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { AttachError, attach, resizeAttach, subscribe, viewerSession, writeAttach } from "../agent/attach.js";
import { clearHistory, hasSession, killWindow, listWindows, newWindow, searchBack, selectWindow, splitWindow } from "../agent/tmux.js";
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
  .use("/sessions/:id/*", async (c, next) => (getTermSession(c.req.param("id")) ? next() : c.json({ error: "没有这个会话" }, 404)))
  .post("/sessions/:id/attach", async (c) => {
    const p = await body(c, z.object({ cols: z.number(), rows: z.number() }));
    if (!p.success) return c.json({ error: "cols / rows 必填" }, 400);
    const s = getTermSession(c.req.param("id"))!;
    // node-pty 每拉起一个 pty 就漏一个 ptmx（进程退了也不还），会话不在就别拉，否则前端重连会一直漏
    if (s.status === "closed" || !(await hasSession(s.tmuxName))) return c.json({ error: "会话已不在", gone: true }, 404);
    try {
      return c.json({ attachId: attach(s.id, s.tmuxName, p.data.cols, p.data.rows) });
    } catch (e) {
      if (!(e instanceof AttachError)) throw e;
      return c.json({ error: e.message, fatal: true }, 503);
    }
  })
  .get("/sessions/:id/stream", (c) => {
    const attachId = c.req.query("attach") ?? "";
    if (viewerSession(attachId) !== c.req.param("id")) return c.json({ error: "没有这个 attach" }, 404);
    return streamSSE(c, async (stream) => {
      await new Promise<void>((resolve) => {
        let ping: NodeJS.Timeout | undefined;
        const end = () => { clearInterval(ping); resolve(); };
        const off = subscribe(attachId, (d) => void stream.writeSSE({ data: JSON.stringify({ d }) }).catch(() => {}), end);
        if (!off) return resolve();
        ping = setInterval(() => void stream.writeSSE({ data: JSON.stringify({ ping: 1 }) }).catch(() => {}), 15_000);
        stream.onAbort(() => { off(); end(); });
      });
    });
  })
  .post("/sessions/:id/input", async (c) => {
    const p = await body(c, z.object({ attach: z.string(), data: z.string().max(65536) }));
    if (!p.success) return c.json({ error: "attach / data 必填" }, 400);
    if (viewerSession(p.data.attach) !== c.req.param("id") || !writeAttach(p.data.attach, p.data.data)) return c.json({ error: "没有这个 attach" }, 404);
    return c.json({ ok: true });
  })
  .post("/sessions/:id/resize", async (c) => {
    const p = await body(c, z.object({ attach: z.string(), cols: z.number(), rows: z.number() }));
    if (!p.success) return c.json({ error: "attach / cols / rows 必填" }, 400);
    return resizeAttach(p.data.attach, p.data.cols, p.data.rows) ? c.json({ ok: true }) : c.json({ error: "没有这个 attach" }, 404);
  })
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
