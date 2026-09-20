import { describe, expect, it } from "vitest";
import { createJob, finishJob } from "../memory/jobs.js";
import { closeTaskTerminal, isIdle, markStop, terminalState } from "./terminal.js";
import { getJob } from "../memory/jobs.js";
import { app } from "../api/index.js";
import { createTask, getTask } from "../memory/tasks.js";

describe("终端说完这轮了没：靠 Stop hook，不再读输出流", () => {
  it("从没收到过 Stop 也算空闲——宁可直接发，也不要攒着不发", () => {
    createJob({ id: "term-idle", project: "demo", dir: "/tmp", task: "x", logPath: "/tmp/x.log", terminal: "ghostty" });
    expect(isIdle("term-idle")).toBe(true);
  });

  it("Stop hook 到了就是说完了", () => {
    createJob({ id: "term-stop", project: "demo", dir: "/tmp", task: "x", logPath: "/tmp/x.log", terminal: "ghostty" });
    markStop("term-stop");
    expect(isIdle("term-stop")).toBe(true);
  });

  it("终端状态：job 在跑就按 Stop 判忙闲，收了尾一律 gone", () => {
    createJob({ id: "term-4", project: "demo", dir: "/tmp", task: "x", logPath: "/tmp/x.log", terminal: "ghostty" });
    expect(terminalState("term-4")).toBe("idle");
    finishJob("term-4", 0);
    expect(terminalState("term-4")).toBe("gone");
    expect(terminalState("no-such-job")).toBe("gone");
  });

  it("任务标完成 → 它的 job 收尾、记账；/done 一条绑终端的任务也一样", async () => {
    createJob({ id: "term-close", project: "demo", dir: "/tmp", task: "x", logPath: "/tmp/x.log", terminal: "ghostty" });
    const task = createTask({ title: "demo：close", kind: "code", source: { jobId: "term-close" }, project: "demo", status: "processing" });
    // 没记下 ghosttyId（窗口早没了），关不到窗口但 job 要收尾
    expect(await closeTaskTerminal(task, "测试")).toBe(false);
    expect(getJob("term-close")!.status).toBe("done");
    const audit = (await (await app.request(`/audit?taskId=${task.id}`)).json()) as Array<{ action: string }>;
    expect(audit.some((e) => e.action === "terminal_closed")).toBe(true);

    createJob({ id: "term-close-2", project: "demo", dir: "/tmp", task: "y", logPath: "/tmp/x.log", terminal: "ghostty" });
    const t2 = createTask({ title: "demo：close2", kind: "code", source: { jobId: "term-close-2" }, project: "demo", status: "processing" });
    await app.request(`/tasks/${t2.id}/done`, { method: "POST" });
    expect(getTask(t2.id)!.status).toBe("done");
    expect(getJob("term-close-2")!.status).toBe("done");
  });
});
