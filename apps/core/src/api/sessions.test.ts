import { beforeEach, describe, expect, it } from "vitest";
import { app } from "./index.js";
import { createTask } from "../memory/tasks.js";
import { getTermSession } from "../memory/termSessions.js";
import { setTmuxPath, setTmuxRunner } from "../agent/tmux.js";
import { openSession, setLauncher, worktreeReady } from "../agent/sessions.js";
import { resetAttachBreaker, setPtySpawner } from "../agent/attach.js";
import { setClipboardWriter } from "./sessions.js";
import { addTestWorktree, mainRepo } from "../agent/testRepos.js";

const R = mainRepo("app");
let wt = "";
let seq = 0;
const freshWorktree = () => addTestWorktree(R, `app-feat-api-${seq++}`);
let calls: string[][] = [];
let written: string[] = [];
let active: number | Error = 0;
beforeEach(() => {
  calls = [];
  written = [];
  active = 0;
  setTmuxPath("/fake/tmux");
  resetAttachBreaker();
  setTmuxRunner(async (args) => {
    calls.push(args);
    if (args[0] === "-V") return "tmux 3.5a";
    if (args[4] === "list-windows") return "0|claude|1\n1|zsh|0\n";
    if (args[4] === "display-message") {
      if (active instanceof Error) throw active;
      return `${active}\n`;
    }
    return "";
  });
  setLauncher(async () => {});
  setPtySpawner(() => ({ onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), write: (d) => void written.push(d), resize: () => {}, kill: () => {} }));
});
const post = (path: string, body: unknown = {}) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function session() {
  const t = createTask({ title: "会话接口", kind: "verbal", source: {}, status: "processing", project: "app" });
  const jobId = await openSession(t, t, { kind: "interactive", project: "app", repoDir: R, task: "x" });
  wt = freshWorktree();
  await worktreeReady(jobId, wt);
  return t.id;
}

describe("/sessions", () => {
  it("attach 后输入写进 pty；回车不再记输入时间（输入由 UserPromptSubmit hook 记）", async () => {
    const id = await session();
    const { attachId } = (await (await post(`/sessions/${id}/attach`, { cols: 120, rows: 40 })).json()) as { attachId: string };
    const before = getTermSession(id)!.lastInputAt!;
    await new Promise((r) => setTimeout(r, 5));
    await post(`/sessions/${id}/input`, { attach: attachId, data: "ls" });
    await post(`/sessions/${id}/input`, { attach: attachId, data: "\r" });
    expect(written).toEqual(["ls", "\r"]);
    expect(getTermSession(id)!.lastInputAt).toBe(before);
  });

  it("拉起 tmux 失败：503 fatal，不留观众；输入 404", async () => {
    const id = await session();
    setPtySpawner(() => { throw new Error("posix_spawnp failed"); });
    const r = await post(`/sessions/${id}/attach`, { cols: 120, rows: 40 });
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ fatal: true, error: expect.stringContaining("posix_spawnp") });
    expect((await post(`/sessions/${id}/input`, { attach: "x", data: "a" })).status).toBe(404);
  });

  it("tmux 里已经没有这个会话：attach 回 404 gone，不拉起 pty（否则前端无限重连）", async () => {
    const id = await session();
    let spawned = 0;
    setPtySpawner(() => { spawned++; return { onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), write: () => {}, resize: () => {}, kill: () => {} }; });
    setTmuxRunner(async (args) => {
      if (args[4] === "has-session") throw new Error("can't find session");
      return "";
    });
    const r = await post(`/sessions/${id}/attach`, { cols: 120, rows: 40 });
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ gone: true });
    expect(spawned).toBe(0);
  });

  it("tmux 客户端退出（pty exit）：stream 结束，前端据此重连", async () => {
    const id = await session();
    let exit = () => {};
    setPtySpawner(() => ({ onData: () => ({ dispose() {} }), onExit: (fn) => { exit = fn; return { dispose() {} }; }, write: () => {}, resize: () => {}, kill: () => {} }));
    const { attachId } = (await (await post(`/sessions/${id}/attach`, { cols: 120, rows: 40 })).json()) as { attachId: string };
    const res = await app.request(`/sessions/${id}/stream?attach=${attachId}`);
    const reader = res.body!.getReader();
    const drained = (async () => { for (;;) if ((await reader.read()).done) return "ended"; })();
    setTimeout(() => exit(), 20);
    expect(await Promise.race([drained, new Promise((r) => setTimeout(() => r("hung"), 1000))])).toBe("ended");
    expect((await post(`/sessions/${id}/input`, { attach: attachId, data: "a" })).status).toBe(404);
  });

  it("准备段回报已被占用的 worktree：409", async () => {
    await session();
    const t = createTask({ title: "撞车", kind: "verbal", source: {}, status: "processing", project: "app" });
    const jobId = await openSession(t, t, { kind: "interactive", project: "app", repoDir: R, task: "x" });
    const r = await post(`/jobs/${jobId}/worktree`, { path: wt });
    expect(r.status).toBe(409);
    expect(getTermSession(t.id)!.status).toBe("exited");
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
