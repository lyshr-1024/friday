import { beforeEach, describe, expect, it } from "vitest";
import { app } from "./index.js";
import { createJob } from "../memory/jobs.js";
import { createTask, getTask } from "../memory/tasks.js";
import { getTermSession } from "../memory/termSessions.js";
import { setTmuxRunner } from "../agent/tmux.js";
import { openSession, setLauncher, worktreeReady } from "../agent/sessions.js";
import { addTestWorktree, mainRepo } from "../agent/testRepos.js";

describe("终端任务", () => {
  it("hook 回报最后一轮，退出回报改状态并进通知队列", async () => {
    const conv = (await (await app.request("/conversation/new", { method: "POST" })).json()) as { id: string };
    createJob({ id: "job-t", project: "demo", dir: "/tmp", task: "修 bug", conversationId: conv.id, logPath: "/tmp/nope.log" });
    const msg = await app.request("/jobs/job-t/message", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "改好了，跑了测试都过" }) });
    expect(msg.status).toBe(200);
    const exit = await app.request("/jobs/job-t/exit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: 0 }) });
    const job = (await exit.json()) as { status: string; exitCode: number; lastMessage: string };
    expect(job).toMatchObject({ status: "done", exitCode: 0, lastMessage: "改好了，跑了测试都过" });
    const c = (await (await app.request(`/conversation/${conv.id}`)).json()) as { messages: Array<{ kind: string; content: string }> };
    expect(c.messages.at(-1)).toMatchObject({ kind: "run" });
    expect(c.messages.at(-1)!.content).toContain("退出码 0");
    const notices = (await (await app.request("/notifications")).json()) as Array<{ title: string }>;
    expect(notices.some((n) => n.title.includes("demo"))).toBe(true);
    expect((await app.request("/jobs/job-t/log")).status).toBe(200);
  });
});

describe("hook 事件驱动状态位", () => {
  beforeEach(() => {
    setTmuxRunner(async (args) => (args[0] === "-V" ? "tmux 3.5a" : args[4] === "list-windows" ? "0|claude|1\n" : ""));
    setLauncher(async () => {});
  });
  const hook = (jobId: string, body: unknown) => app.request(`/jobs/${jobId}/message`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const R = mainRepo("app");
  const wt = (name: string) => addTestWorktree(R, name, `feat/${name}`);
  async function open(title: string) {
    const t = createTask({ title, kind: "verbal", source: {}, status: "processing", project: "app" });
    const jobId = await openSession(t, t, { kind: "interactive", project: "app", repoDir: R, task: "x" });
    return { t, jobId };
  }

  it("UserPromptSubmit 记输入时间（Esc、斜杠命令、空回车都不会有这条）", async () => {
    const { t, jobId } = await open("提交输入");
    expect(await worktreeReady(jobId, wt("jh-a"))).toBeTruthy();
    const before = getTermSession(t.id)!.lastInputAt!;
    await new Promise((r) => setTimeout(r, 5));
    expect((await hook(jobId, { event: "UserPromptSubmit", sessionId: "s-1" })).status).toBe(200);
    expect(getTermSession(t.id)!.lastInputAt! > before).toBe(true);
  });

  it("Notification idle_prompt 当作这轮停了", async () => {
    const { t, jobId } = await open("空闲提示");
    expect(await worktreeReady(jobId, wt("jh-b"))).toBeTruthy();
    expect(getTermSession(t.id)!.lastStopAt).toBeUndefined();
    await hook(jobId, { event: "Notification", notificationType: "idle_prompt", message: "Claude is waiting for your input", sessionId: "s-2" });
    expect(getTermSession(t.id)!.lastStopAt).toBeTruthy();
  });

  it("准备段期间 core 重启：SessionStart 带 cwd 到了而会话还在 preparing，按 cwd 补 worktree 并转 running", async () => {
    const { t, jobId } = await open("补 worktree");
    const dir = wt("jh-c");
    await hook(jobId, { event: "SessionStart", source: "startup", sessionId: "s-3", cwd: dir });
    expect(getTermSession(t.id)).toMatchObject({ status: "running", worktree: dir, branch: "feat/jh-c" });
    expect(getTask(t.id)!.source.worktree).toBe(dir);
  });

  it("SessionStart 的 cwd 是主仓：不当成 worktree", async () => {
    const { t, jobId } = await open("主仓 cwd");
    await hook(jobId, { event: "SessionStart", source: "startup", sessionId: "s-4", cwd: R });
    expect(getTermSession(t.id)!.status).toBe("preparing");
    expect(getTermSession(t.id)!.worktree).toBeUndefined();
  });
});
