import { mkdtempSync, rmSync } from "node:fs";
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

import { startAutonomousJob, startInteractiveJob } from "./pipeline.js";
import { listAudit } from "../memory/audit.js";
import { fireSchedule } from "./schedule.js";
import { setClaudeFinder } from "./runner.js";
import { setTmuxRunner } from "./tmux.js";
import { createSchedule, getSchedule, updateSchedule } from "../memory/schedules.js";
import { createTask, getTask, updateTask } from "../memory/tasks.js";
import { createJob, finishJob, getJob, setJobSession } from "../memory/jobs.js";
import { createRun, runByJob, setRunOutcome } from "../memory/runs.js";
import { createTermSession, getTermSession, updateTermSession } from "../memory/termSessions.js";
import { leftoverWorktrees } from "../api/worktrees.js";

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
function mergedAnchor(scheduleId: string, jobId: string, sessionStatus: "closed" | "exited" = "closed") {
  const wt = mkdtempSync(join(tmpdir(), "friday-sched-reopen-"));
  const t = createTask({ title: "[定时] 修验收", kind: "code", status: "done", project: "demo", source: { scheduleId, jobId, autonomous: true, repoDir: "/repo", worktree: wt, branch: "fix/round-1" } });
  createJob({ id: jobId, project: "demo", dir: wt, logPath: "/tmp/x.log", taskId: t.id, sessionId: t.id });
  setJobSession(jobId, "claude-sess-1");
  finishJob(jobId, 0);
  createTermSession({ id: t.id, project: "demo", repoDir: "/repo", tmuxName: `demo-${jobId}`, kind: "autonomous", jobId });
  updateTermSession(t.id, { status: sessionStatus, worktree: wt });
  createRun({ id: jobId, jobId, taskId: t.id, project: "demo", kind: "autonomous", trigger: "schedule" });
  setRunOutcome(jobId, "merged_as_is");
  updateSchedule(scheduleId, { anchorTaskId: t.id });
  return t;
}

describe("continue 的长期卡已收工、worktree 还在", () => {
  it("无人值守：重开回待办、不动上一轮的结局、账写明是定时任务重开，不接回旧会话也不沿用旧分支", async () => {
    const s = createSchedule({ title: "修验收", cron: "0 10 * * *", executor: "project", project: "demo", prompt: "去修" });
    const t = mergedAnchor(s.id, "sr-1");
    const r = await fireSchedule(getSchedule(s.id)!, "due");
    expect(r.ok).toBe(true);
    expect(calls.some((a) => a[4] === "new-session")).toBe(false);
    expect(getTermSession(t.id)!.status).toBe("closed");
    expect(getJob("sr-1")!.status).not.toBe("running");
    expect(runByJob("sr-1")!.outcome).toBe("merged_as_is");
    const audit = listAudit({ taskId: t.id }).find((e) => e.action === "task_reopened")!;
    expect(audit.why).toBe("定时任务「修验收」到点，重开长期卡");
    const call = vi.mocked(startAutonomousJob).mock.calls[0]!;
    expect(call[0]).toMatchObject({ id: t.id, status: "understood" });
    expect(call[0].source.branch).toBeUndefined();
    expect(call[0].source.worktree).toBeUndefined();
    expect(call[4]).toBe("schedule");
    expect(getTask(t.id)!.source.branch).toBeUndefined();
  });

  it("有人值守：同样不接回旧 worktree 里的会话，交给 startInteractiveJob 从主干新开", async () => {
    const s = createSchedule({ title: "修验收", cron: "0 10 * * *", executor: "project", project: "demo", prompt: "去修", attended: true });
    const t = mergedAnchor(s.id, "sr-2");
    await fireSchedule(getSchedule(s.id)!, "manual");
    expect(calls.some((a) => a[4] === "new-session")).toBe(false);
    expect(getTermSession(t.id)!.status).toBe("closed");
    expect(runByJob("sr-2")!.outcome).toBe("merged_as_is");
    expect(listAudit({ taskId: t.id }).find((e) => e.action === "task_reopened")!.why).toMatch(/现在跑一次/);
    const call = vi.mocked(startInteractiveJob).mock.calls[0]!;
    expect(call[0]).toMatchObject({ id: t.id, status: "understood" });
    expect(call[0].source.branch).toBeUndefined();
  });
});

describe("重开长期卡时上一轮的 worktree 和终端", () => {
  it("上一轮的 worktree 记进 priorWorktrees，进遗留列表能在设置页删", async () => {
    const s = createSchedule({ title: "修验收", cron: "0 10 * * *", executor: "project", project: "demo", prompt: "去修" });
    const t = mergedAnchor(s.id, "sr-3");
    const wt = t.source.worktree!;
    await fireSchedule(getSchedule(s.id)!, "due");
    expect(getTask(t.id)!.source.priorWorktrees).toEqual([{ path: wt, repoDir: "/repo" }]);
    expect(leftoverWorktrees().find((w) => w.path === wt)).toMatchObject({ repoDir: "/repo", taskId: t.id });
  });

  it("长期卡收工了但会话没关（阶段拖到已上线）：先关掉旧会话再重开，不接进旧 worktree", async () => {
    const s = createSchedule({ title: "修验收", cron: "0 10 * * *", executor: "project", project: "demo", prompt: "去修" });
    const t = mergedAnchor(s.id, "sr-4", "exited");
    await fireSchedule(getSchedule(s.id)!, "due");
    expect(calls.some((a) => a[4] === "kill-session")).toBe(true);
    expect(getTermSession(t.id)!.status).toBe("closed");
    expect(listAudit({ taskId: t.id }).find((e) => e.action === "terminal_closed")?.why).toBe("定时任务新一轮从主干开始");
    expect(calls.some((a) => a[4] === "send-keys")).toBe(false);
  });
});

describe("重开长期卡的收尾边界", () => {
  it("会话没关、job 行对不上：按会话名直接杀掉并标 closed", async () => {
    const s = createSchedule({ title: "修验收", cron: "0 10 * * *", executor: "project", project: "demo", prompt: "去修" });
    const t = mergedAnchor(s.id, "sr-5", "exited");
    updateTermSession(t.id, { jobId: "ghost-job" });
    await fireSchedule(getSchedule(s.id)!, "due");
    expect(calls.some((a) => a[4] === "kill-session")).toBe(true);
    expect(getTermSession(t.id)!.status).toBe("closed");
    expect(calls.some((a) => a[4] === "send-keys")).toBe(false);
  });

  it("priorWorktrees 追加时丢掉磁盘上已不在的目录", async () => {
    const s = createSchedule({ title: "修验收", cron: "0 10 * * *", executor: "project", project: "demo", prompt: "去修" });
    const t = mergedAnchor(s.id, "sr-6");
    const gone = mkdtempSync(join(tmpdir(), "friday-sched-gone-"));
    rmSync(gone, { recursive: true });
    updateTask(t.id, { source: { priorWorktrees: [{ path: gone, repoDir: "/repo" }] } });
    await fireSchedule(getSchedule(s.id)!, "due");
    expect(getTask(t.id)!.source.priorWorktrees).toEqual([{ path: t.source.worktree, repoDir: "/repo" }]);
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
