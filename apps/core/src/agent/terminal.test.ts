import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTask, getTask, updateTask } from "../memory/tasks.js";
import { createJob, finishJob, getJob } from "../memory/jobs.js";
import { getTermSession } from "../memory/termSessions.js";
import { listAudit } from "../memory/audit.js";
import { setTmuxRunner } from "./tmux.js";
import { openSession, setLauncher, worktreeReady } from "./sessions.js";
import { say, sweepClosedTerminals } from "./terminal.js";
import { finishTask } from "./pipeline.js";

let calls: string[][] = [];
let alive = new Set<string>();
let listFails = false;
beforeEach(() => {
  calls = [];
  listFails = false;
  setTmuxRunner(async (args) => {
    calls.push(args);
    if (args[0] === "-V") return "tmux 3.5a";
    const sub = args[4];
    const target = (args[args.indexOf("-t") + 1] ?? "").replace(/^=/, "").replace(/:.*$/, "");
    if (sub === "has-session" && !alive.has(target)) throw new Error("can't find session");
    if (sub === "list-sessions") {
      if (listFails) throw Object.assign(new Error("spawn tmux EAGAIN"), { code: "EAGAIN" });
      return [...alive].join("\n");
    }
    if (sub === "kill-session") alive.delete(target);
    if (sub === "rename-session") { alive.delete(target); alive.add(args.at(-1)!); }
    return "";
  });
  setLauncher(async (_req, name) => { alive.add(name); });
});

async function running(title: string, extra: Record<string, unknown> = {}) {
  const t = createTask({ title, kind: "verbal", source: extra, status: "processing", project: "app" });
  const jobId = await openSession(t, t, { kind: "interactive", project: "app", repoDir: "/r/app", task: "x" });
  await worktreeReady(jobId, `/r/app-${t.id.slice(0, 6)}`);
  return { t, jobId };
}

describe("tmux 版终端", () => {
  it("say 走 send-keys 并记下输入时间", async () => {
    const { t, jobId } = await running("说话");
    const before = getTermSession(t.id)!.lastInputAt!;
    await new Promise((r) => setTimeout(r, 5));
    expect(await say(jobId, "先提交")).toBe("sent");
    expect(calls.some((c) => c[4] === "send-keys" && c.at(-1) === "先提交")).toBe(true);
    expect(getTermSession(t.id)!.lastInputAt! > before).toBe(true);
  });

  it("tmux 列不出来（不是没有 server）时对账什么都不动", async () => {
    const { t, jobId } = await running("抖动");
    alive.clear();
    listFails = true;
    expect(await sweepClosedTerminals()).toEqual([]);
    expect(getTermSession(t.id)!.status).toBe("running");
    expect(getJob(jobId)!.status).toBe("running");
  });

  it("tmux 里已经没有的会话才收：会话 closed、job 结束", async () => {
    const { t, jobId } = await running("没了");
    alive.delete(getTermSession(t.id)!.tmuxName);
    expect(await sweepClosedTerminals()).toContain(jobId);
    expect(getTermSession(t.id)!.status).toBe("closed");
    expect(getJob(jobId)!.status).not.toBe("running");
  });

  it("缺陷收工不杀需求的会话；需求收工才杀", async () => {
    const { t: root } = await running("需求");
    const bug = createTask({ title: "缺陷", kind: "meegle", source: { rootId: root.id }, status: "processing" });
    await finishTask(bug.id, "done", "测试");
    expect(calls.some((c) => c[4] === "kill-session")).toBe(false);
    expect(getTermSession(root.id)!.status).toBe("running");
    await finishTask(root.id, "done", "测试");
    expect(calls.some((c) => c[4] === "kill-session")).toBe(true);
    expect(getTermSession(root.id)!.status).toBe("closed");
  });

  it("收工后 worktree 目录还在就记 worktree_kept，Friday 自己不删", async () => {
    const dir = mkdtempSync(join(tmpdir(), "app-feat-keep-"));
    const t = createTask({ title: "留着", kind: "verbal", source: {}, status: "processing", project: "app" });
    const jobId = await openSession(t, t, { kind: "interactive", project: "app", repoDir: "/r/app", task: "x" });
    await worktreeReady(jobId, dir);
    await finishTask(t.id, "done", "测试");
    expect(listAudit({ limit: 50 }).some((e) => e.taskId === t.id && e.action === "worktree_kept")).toBe(true);
    expect(getTask(t.id)!.source.worktree).toBe(dir);
  });
});

describe("窗口 / 会话没了：任务得跟着收尾，不能一直挂在 processing", () => {
  const job = (id: string) => createJob({ id, project: "demo", dir: "/tmp", task: "x", logPath: "/tmp/x.log" });

  it("Friday 自主派的：会话没了又没交付报告 → 卡住，写明会话已不在", async () => {
    job("sw-auto");
    const t = createTask({ title: "demo：auto", kind: "code", source: { jobId: "sw-auto", autonomous: true }, project: "demo", status: "processing" });
    expect(await sweepClosedTerminals()).toContain("sw-auto");
    const after = getTask(t.id)!;
    expect(after.status).toBe("blocked");
    expect(after.progress).toContain("会话已不在");
  });

  it("以前漏掉的也兜住：job 早就收了尾、自主任务还挂着", async () => {
    job("sw-old");
    finishJob("sw-old", -1);
    const t = createTask({ title: "demo：old", kind: "code", source: { jobId: "sw-old", autonomous: true }, project: "demo", status: "processing" });
    await sweepClosedTerminals();
    expect(getTask(t.id)!.status).toBe("blocked");
  });

  it("你自己开的交互式终端：任务完不完成仍由你说，只把进展改对，不拼「之前：」", async () => {
    job("sw-mine");
    const t = createTask({ title: "demo：mine", kind: "code", source: { jobId: "sw-mine" }, project: "demo", status: "processing" });
    updateTask(t.id, { progress: "旧进展" });
    await sweepClosedTerminals();
    const after = getTask(t.id)!;
    expect(after.status).toBe("processing");
    expect(after.progress).toBe("终端会话已结束（会话已不在）");
    await sweepClosedTerminals();
    expect(getTask(t.id)!.progress).toBe(after.progress);
  });
});
