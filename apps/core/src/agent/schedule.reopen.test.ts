import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./pipeline.js", async (orig) => ({
  ...(await orig<typeof import("./pipeline.js")>()),
  startAutonomousJob: vi.fn(async (t) => t),
  startInteractiveJob: vi.fn(async (t) => t),
}));
vi.mock("../memory/projects.js", async (orig) => ({
  ...(await orig<typeof import("../memory/projects.js")>()),
  resolveProject: () => ({ kind: "match", project: { name: "demo", dir: "/repo" } }),
}));

import { startAutonomousJob } from "./pipeline.js";
import { fireSchedule } from "./schedule.js";
import { setClaudeFinder } from "./runner.js";
import { setTmuxRunner } from "./tmux.js";
import { createSchedule, getSchedule, updateSchedule } from "../memory/schedules.js";
import { createTask, getTask } from "../memory/tasks.js";
import { createJob, finishJob, getJob, setJobSession } from "../memory/jobs.js";
import { createRun, runByJob, setRunOutcome } from "../memory/runs.js";
import { createTermSession, getTermSession, updateTermSession } from "../memory/termSessions.js";

let calls: string[][] = [];
beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  setClaudeFinder(async () => "/bin/claude");
  setTmuxRunner(async (args) => {
    calls.push(args);
    if (args[0] === "-V") return "tmux 3.5a";
    if (args[4] === "has-session") throw new Error("can't find session");
    return "";
  });
});

/** 长期卡上一轮交付合并后收工：会话关了，worktree 还在 */
function mergedAnchor(scheduleId: string, jobId: string) {
  const wt = mkdtempSync(join(tmpdir(), "friday-sched-reopen-"));
  const t = createTask({ title: "[定时] 修验收", kind: "code", status: "done", project: "demo", source: { scheduleId, jobId, autonomous: true, repoDir: "/repo", worktree: wt } });
  createJob({ id: jobId, project: "demo", dir: wt, logPath: "/tmp/x.log", taskId: t.id, sessionId: t.id });
  setJobSession(jobId, "claude-sess-1");
  finishJob(jobId, 0);
  createTermSession({ id: t.id, project: "demo", repoDir: "/repo", tmuxName: `demo-${jobId}`, kind: "autonomous", jobId });
  updateTermSession(t.id, { status: "closed", worktree: wt });
  createRun({ id: jobId, jobId, taskId: t.id, project: "demo", kind: "autonomous", trigger: "schedule" });
  setRunOutcome(jobId, "merged_as_is");
  updateSchedule(scheduleId, { anchorTaskId: t.id });
  return t;
}

describe("continue 的长期卡已收工、worktree 还在", () => {
  it("无人值守：只重开任务，不接回交互式会话，交给自主开工走新的一轮", async () => {
    const s = createSchedule({ title: "修验收", cron: "0 10 * * *", executor: "project", project: "demo", prompt: "去修" });
    const t = mergedAnchor(s.id, "sr-1");
    const r = await fireSchedule(getSchedule(s.id)!, "due");
    expect(r.ok).toBe(true);
    expect(calls.some((a) => a[4] === "new-session")).toBe(false);
    expect(getTermSession(t.id)!.status).toBe("closed");
    expect(getJob("sr-1")!.status).not.toBe("running");
    expect(runByJob("sr-1")!.outcome).toBe("reopened");
    const call = vi.mocked(startAutonomousJob).mock.calls[0]!;
    expect(call[0]).toMatchObject({ id: t.id, status: "processing" });
    expect(call[4]).toBe("schedule");
    expect(getTask(t.id)!.status).toBe("processing");
  });

  it("有人值守：照旧在原 worktree 里接回会话", async () => {
    const s = createSchedule({ title: "修验收", cron: "0 10 * * *", executor: "project", project: "demo", prompt: "去修", attended: true });
    const t = mergedAnchor(s.id, "sr-2");
    await fireSchedule(getSchedule(s.id)!, "due");
    expect(calls.some((a) => a[4] === "new-session")).toBe(true);
    expect(getTermSession(t.id)!.status).toBe("running");
  });
});

describe("无人值守的定时卡一轮没写交付报告", () => {
  it("跟别的自主任务一样进审核、写「未生成交付报告」，不标已完成", async () => {
    const { onJobExit } = await import("./pipeline.js");
    const t = createTask({ title: "[定时] 修验收", kind: "code", status: "processing", project: "demo", understanding: "去修", source: { scheduleId: "s-x", jobId: "sn-1", autonomous: true, repoDir: "/nope" } });
    createJob({ id: "sn-1", project: "demo", dir: "/nope", logPath: "/tmp/x.log", taskId: t.id });
    createRun({ id: "sn-1", jobId: "sn-1", taskId: t.id, project: "demo", kind: "autonomous", trigger: "schedule" });
    const out = onJobExit("sn-1", 0)!;
    expect(out.status).toBe("review");
    expect(out.progress).toMatch(/未生成交付报告/);
  });
});
