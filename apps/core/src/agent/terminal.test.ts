import { describe, expect, it } from "vitest";
import { createJob, finishJob } from "../memory/jobs.js";
import { closeTaskTerminal, isIdle, markStop, sweepClosedTerminals, terminalState } from "./terminal.js";
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

describe("终端窗口没了：任务得跟着收尾，不能一直挂在 processing", () => {
  const job = (id: string) => createJob({ id, project: "demo", dir: "/tmp", task: "x", logPath: "/tmp/x.log", terminal: "ghostty" });

  it("Friday 自主派的：窗口没了又没交付报告 → 卡住，写明是窗口关了", async () => {
    job("sw-auto");
    const t = createTask({ title: "demo：auto", kind: "code", source: { jobId: "sw-auto", autonomous: true }, project: "demo", status: "processing" });
    // 没记 terminal id 的问不了窗口，当它没了
    expect(await sweepClosedTerminals()).toContain("sw-auto");
    const after = getTask(t.id)!;
    expect(after.status).toBe("blocked");
    expect(after.progress).toContain("终端窗口已关闭");
  });

  it("以前漏掉的也兜住：job 早就收了尾、自主任务还挂着", async () => {
    job("sw-old");
    finishJob("sw-old", -1);
    const t = createTask({ title: "demo：old", kind: "code", source: { jobId: "sw-old", autonomous: true }, project: "demo", status: "processing" });
    await sweepClosedTerminals();
    expect(getTask(t.id)!.status).toBe("blocked");
  });

  it("你自己开的交互式终端：任务完不完成仍由你说，只把进展改对", async () => {
    job("sw-mine");
    const t = createTask({ title: "demo：mine", kind: "code", source: { jobId: "sw-mine" }, project: "demo", status: "processing" });
    await sweepClosedTerminals();
    const after = getTask(t.id)!;
    expect(after.status).toBe("processing");
    expect(after.progress).toMatch(/^终端会话已结束（终端窗口已关闭）/);
    // 再扫一轮不会把「之前：」一层层套上去
    await sweepClosedTerminals();
    expect(getTask(t.id)!.progress).toBe(after.progress);
  });
});
