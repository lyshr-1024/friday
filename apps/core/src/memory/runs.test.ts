import { describe, expect, it } from "vitest";
import { createRun, finishRun, pendingRunsForTask, runByJob, runsForTask, runsSummary, setRunOutcome } from "./runs.js";

describe("runs 账本", () => {
  it("开工 → 退出 → 结局，一行走完", () => {
    createRun({ id: "j1", jobId: "j1", taskId: "t1", project: "whale-console", kind: "autonomous", trigger: "autostart", intakeConfidence: 85 });
    expect(runByJob("j1")).toMatchObject({ outcome: "pending", intakeConfidence: 85, trigger: "autostart" });
    finishRun("j1", { exit: "report", branch: "fix/x", tipSha: "abc", filesChanged: 4, insertions: 34, deletions: 16, costUsd: 1.2, model: "claude-opus-5" });
    expect(pendingRunsForTask("t1")).toHaveLength(1);
    setRunOutcome("j1", "merged_as_is");
    expect(runByJob("j1")).toMatchObject({ exit: "report", branch: "fix/x", outcome: "merged_as_is", costUsd: 1.2 });
    expect(runByJob("j1")!.endedAt).toBeTruthy();
    expect(runByJob("j1")!.outcomeAt).toBeTruthy();
    expect(pendingRunsForTask("t1")).toEqual([]);
    expect(runsForTask("t1").map((r) => r.id)).toEqual(["j1"]);
  });

  it("逐文件增删和主干名存成 JSON，读回来原样", () => {
    createRun({ id: "j5", jobId: "j5", taskId: "t5", project: "demo", kind: "autonomous", trigger: "retry" });
    const files = [{ path: "a.ts", insertions: 3, deletions: 1 }, { path: "b.png", insertions: 0, deletions: 0 }];
    finishRun("j5", { exit: "report", filesChanged: 2, insertions: 3, deletions: 1, diffFiles: files, diffBase: "master" });
    expect(runByJob("j5")).toMatchObject({ diffFiles: files, diffBase: "master" });
  });

  it("交互式轮次不算 job 的主记录：runByJob 只认 autonomous / query", () => {
    createRun({ id: "j9#1", jobId: "j9", taskId: "t9", project: "demo", kind: "interactive_round", trigger: "user" });
    expect(runByJob("j9")).toBeUndefined();
  });

  it("汇总按项目 + 类型：结局计数、成本合计、耗时中位数（分钟）", () => {
    createRun({ id: "j2", jobId: "j2", taskId: "t2", project: "whale-console", kind: "autonomous", trigger: "retry" });
    finishRun("j2", { exit: "no_report", costUsd: 0.4 });
    setRunOutcome("j2", "rejected", "没报告");
    const p = runsSummary("30d").byProject.find((x) => x.project === "whale-console" && x.kind === "autonomous")!;
    expect(p.runs).toBe(2);
    expect(p.mergedAsIs).toBe(1);
    expect(p.rejected).toBe(1);
    expect(p.costUsd).toBeCloseTo(1.6);
    expect(p.medianMinutes).toBeGreaterThanOrEqual(0);
  });

  it("没结束的运行不进耗时中位数", () => {
    createRun({ id: "j3", jobId: "j3", taskId: "t3", project: "lonely", kind: "autonomous", trigger: "retry" });
    const p = runsSummary("30d").byProject.find((x) => x.project === "lonely")!;
    expect(p).toMatchObject({ runs: 1, pending: 1, costUsd: 0, medianMinutes: 0 });
  });
});
