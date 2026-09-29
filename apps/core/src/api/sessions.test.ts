import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "./index.js";
import { createTask } from "../memory/tasks.js";
import { getTermSession } from "../memory/termSessions.js";
import { setTmuxRunner } from "../agent/tmux.js";
import { openSession, setLauncher, worktreeReady } from "../agent/sessions.js";
import { setPtySpawner } from "../agent/attach.js";
import { setClipboardWriter } from "./sessions.js";

const wt = mkdtempSync(join(tmpdir(), "friday-wt-"));
execFileSync("git", ["init", "-q", wt]);
let calls: string[][] = [];
let written: string[] = [];
beforeEach(() => {
  calls = [];
  written = [];
  setTmuxRunner(async (args) => {
    calls.push(args);
    if (args[0] === "-V") return "tmux 3.5a";
    if (args[4] === "list-windows") return "0|claude|1\n1|zsh|0\n";
    return "";
  });
  setLauncher(async () => {});
  setPtySpawner(() => ({ onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), write: (d) => void written.push(d), resize: () => {}, kill: () => {} }));
});
const post = (path: string, body: unknown = {}) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function session() {
  const t = createTask({ title: "会话接口", kind: "verbal", source: {}, status: "processing", project: "app" });
  const jobId = await openSession(t, t, { kind: "interactive", project: "app", repoDir: "/r/app", task: "x" });
  await worktreeReady(jobId, wt);
  return t.id;
}

describe("/sessions", () => {
  it("attach 后输入写进 pty，带回车才记输入时间", async () => {
    const id = await session();
    const { attachId } = (await (await post(`/sessions/${id}/attach`, { cols: 120, rows: 40 })).json()) as { attachId: string };
    const before = getTermSession(id)!.lastInputAt!;
    await new Promise((r) => setTimeout(r, 5));
    await post(`/sessions/${id}/input`, { attach: attachId, data: "ls" });
    expect(getTermSession(id)!.lastInputAt).toBe(before);
    await post(`/sessions/${id}/input`, { attach: attachId, data: "\r" });
    expect(written).toEqual(["ls", "\r"]);
    expect(getTermSession(id)!.lastInputAt! > before).toBe(true);
  });

  it("没有 attach 的输入 404", async () => {
    const id = await session();
    expect((await post(`/sessions/${id}/input`, { attach: "nope", data: "x" })).status).toBe(404);
  });

  it("seen 记看过时间", async () => {
    const id = await session();
    expect((await post(`/sessions/${id}/seen`)).status).toBe(200);
    expect(getTermSession(id)!.seenAt).toBeTruthy();
  });

  it("窗口：列出、新建在 worktree 里、只剩一个不关", async () => {
    const id = await session();
    const list = (await (await app.request(`/sessions/${id}/windows`)).json()) as Array<{ index: number; name: string }>;
    expect(list.map((w) => w.name)).toEqual(["claude", "zsh"]);
    await post(`/sessions/${id}/windows`);
    expect(calls.some((c) => c[4] === "new-window" && c.includes(wt))).toBe(true);
    expect((await app.request(`/sessions/${id}/windows/1`, { method: "DELETE" })).status).toBe(200);
  });

  it("不存在的会话 404", async () => {
    expect((await app.request(`/sessions/nope/windows`)).status).toBe(404);
  });

  it("clipboard：非 JSON content-type 415 且不写剪贴板", async () => {
    const wrote: string[] = [];
    setClipboardWriter(async (t) => void wrote.push(t));
    const r = await app.request("/clipboard", { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ text: "x" }) });
    expect(r.status).toBe(415);
    expect(wrote).toEqual([]);
    expect((await post("/clipboard", { text: "y" })).status).toBe(200);
    expect(wrote).toEqual(["y"]);
  });

  it("clipboard：写入失败 500", async () => {
    setClipboardWriter(async () => { throw new Error("EPIPE"); });
    expect((await post("/clipboard", { text: "y" })).status).toBe(500);
  });
});
