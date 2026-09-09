import { describe, expect, it } from "vitest";
import { createJob, finishJob } from "../memory/jobs.js";
import { isIdle, quietFor, terminalState } from "./terminal.js";

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
});
