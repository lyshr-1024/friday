import { describe, expect, it } from "vitest";
import { createJob, finishJob } from "../memory/jobs.js";
import { closeTaskTerminal, isIdle, quietFor, terminalState } from "./terminal.js";
import { getJob } from "../memory/jobs.js";
import { app } from "../api/index.js";
import { createTask, getTask } from "../memory/tasks.js";

describe("终端忙不忙：看 PTY 最近有没有输出", () => {
  it("3 秒内有输出算忙，安静 3 秒算空闲，从没输出过算空闲", () => {
    const now = 100_000;
    expect(quietFor(now - 500, now)).toBe(false);
    expect(quietFor(now - 2999, now)).toBe(false);
    expect(quietFor(now - 3000, now)).toBe(true);
    expect(quietFor(undefined, now)).toBe(true);
  });

  it("没有活着的 PTY 就不算空闲（没法往里敲）", () => {
    createJob({ id: "term-1", project: "demo", dir: "/tmp", task: "修 bug", logPath: "/tmp/x.log" });
    expect(isIdle("term-1")).toBe(false);
  });

  it("终端状态：内嵌 job 没有 PTY 就是断了，只有外部终端才算 external，结束了也是 gone", () => {
    createJob({ id: "term-3", project: "demo", dir: "/tmp", task: "x", logPath: "/tmp/x.log", terminal: "embedded" });
    expect(terminalState("term-3")).toBe("gone");
    createJob({ id: "term-4", project: "demo", dir: "/tmp", task: "x", logPath: "/tmp/x.log", terminal: "ghostty" });
    expect(terminalState("term-4")).toBe("external");
    finishJob("term-4", 0);
    expect(terminalState("term-4")).toBe("gone");
    expect(terminalState("no-such-job")).toBe("gone");
  });

  it("任务标完成 → 它的 job 收尾、记账；/done 一条绑终端的任务也一样", async () => {
    createJob({ id: "term-close", project: "demo", dir: "/tmp", task: "x", logPath: "/tmp/x.log", terminal: "embedded" });
    const task = createTask({ title: "demo：close", kind: "code", source: { jobId: "term-close" }, project: "demo", status: "processing" });
    expect(closeTaskTerminal(task, "测试")).toBe(false); // 没有活着的 PTY，但 job 要收尾
    expect(getJob("term-close")!.status).toBe("done");
    const audit = (await (await app.request(`/audit?taskId=${task.id}`)).json()) as Array<{ action: string }>;
    expect(audit.some((e) => e.action === "terminal_closed")).toBe(true);

    createJob({ id: "term-close-2", project: "demo", dir: "/tmp", task: "y", logPath: "/tmp/x.log", terminal: "embedded" });
    const t2 = createTask({ title: "demo：close2", kind: "code", source: { jobId: "term-close-2" }, project: "demo", status: "processing" });
    await app.request(`/tasks/${t2.id}/done`, { method: "POST" });
    expect(getTask(t2.id)!.status).toBe("done");
    expect(getJob("term-close-2")!.status).toBe("done");
  });
});
