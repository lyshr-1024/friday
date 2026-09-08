import { describe, expect, it } from "vitest";
import { createJob } from "../memory/jobs.js";
import { finishJob } from "../memory/jobs.js";
import { isIdle, markInput, markStop, resetTerminalState, terminalState } from "./terminal.js";

describe("往终端里说话的空闲判定", () => {
  it("带任务的会话一起来在干活，Stop 之后才空闲，有输入又变忙", () => {
    createJob({ id: "term-1", project: "demo", dir: "/tmp", task: "修 bug", logPath: "/tmp/x.log" });
    resetTerminalState("term-1");
    expect(isIdle("term-1")).toBe(false);
    markStop("term-1");
    expect(isIdle("term-1")).toBe(true);
    markInput("term-1");
    expect(isIdle("term-1")).toBe(false);
  });

  it("没带任务的交互式会话一起来就等着输入，算空闲", () => {
    createJob({ id: "term-2", project: "demo", dir: "/tmp", logPath: "/tmp/x.log" });
    resetTerminalState("term-2");
    expect(isIdle("term-2")).toBe(true);
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
});
