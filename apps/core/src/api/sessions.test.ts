import { beforeEach, describe, expect, it } from "vitest";
import { app } from "./index.js";
import { createTask } from "../memory/tasks.js";
import { getTermSession, updateTermSession } from "../memory/termSessions.js";
import { setTmuxPath, setTmuxRunner } from "../agent/tmux.js";
import { openSession, setLauncher, worktreeReady } from "../agent/sessions.js";
import { resetAttachBreaker, setPtySpawner } from "../agent/attach.js";
import { setClipboardWriter } from "./sessions.js";
import { onTerminal, type SocketLike } from "./terminalSocket.js";
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
function fakeSocket() {
  const sent: unknown[] = [];
  let closed: number | undefined;
  const handlers: Record<string, Array<(v?: unknown) => void>> = {};
  const ws: SocketLike = {
    readyState: 1,
    send: (d) => void sent.push(JSON.parse(d)),
    close: (code) => {
      if (closed !== undefined) return;
      closed = code;
      ws.readyState = 3;
      (handlers.close ?? []).forEach((f) => f());
    },
    on: (e: string, fn: (v?: unknown) => void) => void (handlers[e] ??= []).push(fn),
  };
  return { ws, sent, closed: () => closed, emit: (e: string, v: unknown) => (handlers[e] ?? []).forEach((f) => f(v)) };
}
const post = (path: string, body: unknown = {}) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function session() {
  const t = createTask({ title: "会话接口", kind: "verbal", source: {}, status: "processing", project: "app" });
  const jobId = await openSession(t, t, { kind: "interactive", project: "app", repoDir: R, task: "x" });
  wt = freshWorktree();
  await worktreeReady(jobId, wt);
  return t.id;
}

describe("/sessions", () => {
  it("连上后按键写进 pty、尺寸跟着调；回车不再记输入时间（输入由 UserPromptSubmit hook 记）", async () => {
    const id = await session();
    const sizes: number[][] = [];
    setPtySpawner(() => ({ onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), write: (d) => void written.push(d), resize: (c, r) => void sizes.push([c, r]), kill: () => {} }));
    const f = fakeSocket();
    await onTerminal(f.ws, id, 120, 40);
    const before = getTermSession(id)!.lastInputAt!;
    await new Promise((r) => setTimeout(r, 5));
    f.emit("message", JSON.stringify({ i: "ls" }));
    f.emit("message", JSON.stringify({ i: "\r" }));
    f.emit("message", JSON.stringify({ r: [100, 30] }));
    f.emit("message", "不是 JSON");
    expect(written).toEqual(["ls", "\r"]);
    expect(sizes).toEqual([[100, 30]]);
    expect(getTermSession(id)!.lastInputAt).toBe(before);
    expect(f.closed()).toBeUndefined();
  });

  it("pty 的输出原样推下去；连接一断就收掉 tmux 客户端", async () => {
    const id = await session();
    let out = (_d: string) => {};
    let killed = 0;
    setPtySpawner(() => ({ onData: (fn) => { out = fn; return { dispose() {} }; }, onExit: () => ({ dispose() {} }), write: () => {}, resize: () => {}, kill: () => void killed++ }));
    const f = fakeSocket();
    await onTerminal(f.ws, id, 120, 40);
    out("\u001b[2J你好");
    expect(f.sent).toContainEqual({ d: "\u001b[2J你好" });
    f.ws.close(1000);
    expect(killed).toBe(1);
  });

  it("拉起 tmux 失败：发 fatal 后关连接，不留观众", async () => {
    const id = await session();
    setPtySpawner(() => { throw new Error("posix_spawnp failed"); });
    const f = fakeSocket();
    await onTerminal(f.ws, id, 120, 40);
    expect(f.sent).toEqual([{ fatal: true, error: expect.stringContaining("posix_spawnp") }]);
    expect(f.closed()).toBe(4500);
  });

  const noTmux = () => {
    let spawned = 0;
    setPtySpawner(() => { spawned++; return { onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), write: () => {}, resize: () => {}, kill: () => {} }; });
    setTmuxRunner(async (args) => {
      if (args[4] === "has-session") throw new Error("can't find session");
      return "";
    });
    return () => spawned;
  };

  it("会话行还在 preparing、tmux 里暂时没有（kill 再重建的间隙）：retry，不拉 pty、不算 gone", async () => {
    const t = createTask({ title: "重建中", kind: "verbal", source: {}, status: "processing", project: "app" });
    await openSession(t, t, { kind: "interactive", project: "app", repoDir: R, task: "x" });
    expect(getTermSession(t.id)!.status).toBe("preparing");
    const spawned = noTmux();
    const f = fakeSocket();
    await onTerminal(f.ws, t.id, 120, 40);
    expect(f.sent).toEqual([{ retry: true, error: "会话还没起来" }]);
    expect(f.closed()).toBe(4503);
    expect(spawned()).toBe(0);
  });

  it("会话行 running / exited 而 tmux 里找不到：同样 retry（交给对账去判 closed）", async () => {
    const id = await session();
    const spawned = noTmux();
    const a = fakeSocket();
    await onTerminal(a.ws, id, 120, 40);
    expect(a.closed()).toBe(4503);
    updateTermSession(id, { status: "exited" });
    const b = fakeSocket();
    await onTerminal(b.ws, id, 120, 40);
    expect(b.closed()).toBe(4503);
    expect(spawned()).toBe(0);
  });

  it("会话行 closed：gone，不拉 pty；没有这一行也是 gone", async () => {
    const id = await session();
    updateTermSession(id, { status: "closed" });
    const spawned = noTmux();
    const a = fakeSocket();
    await onTerminal(a.ws, id, 120, 40);
    expect(a.sent).toEqual([{ gone: true, error: "会话已不在" }]);
    expect(a.closed()).toBe(4404);
    const b = fakeSocket();
    await onTerminal(b.ws, "nope", 120, 40);
    expect(b.closed()).toBe(4404);
    expect(spawned()).toBe(0);
  });

  it("tmux 客户端退出（pty exit）：关连接，前端据此重连", async () => {
    const id = await session();
    let exit = () => {};
    setPtySpawner(() => ({ onData: () => ({ dispose() {} }), onExit: (fn) => { exit = fn; return { dispose() {} }; }, write: () => {}, resize: () => {}, kill: () => {} }));
    const f = fakeSocket();
    await onTerminal(f.ws, id, 120, 40);
    exit();
    expect(f.closed()).toBe(4000);
  });

  it("准备段回报已被占用的 worktree：409", async () => {
    await session();
    const t = createTask({ title: "撞车", kind: "verbal", source: {}, status: "processing", project: "app" });
    const jobId = await openSession(t, t, { kind: "interactive", project: "app", repoDir: R, task: "x" });
    const r = await post(`/jobs/${jobId}/worktree`, { path: wt });
    expect(r.status).toBe(409);
    expect(getTermSession(t.id)!.status).toBe("exited");
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
