import { describe, expect, it } from "vitest";
import { createJob } from "../memory/jobs.js";
import { isIdle, markInput, markStop, resetTerminalState } from "./terminal.js";

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
});
