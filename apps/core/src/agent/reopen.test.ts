import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../api/index.js";
import { listAudit } from "../memory/audit.js";
import { createJob, finishJob, getJob, setJobSession } from "../memory/jobs.js";
import { createRun, runByJob, setRunOutcome } from "../memory/runs.js";
import { createTask, getTask } from "../memory/tasks.js";
import { createTermSession, getTermSession, updateTermSession } from "../memory/termSessions.js";
import { runsDir, setClaudeFinder } from "./runner.js";
import { setTmuxRunner } from "./tmux.js";

let calls: string[][] = [];
let alive = new Set<string>();
beforeEach(() => {
  calls = [];
  alive = new Set();
  setClaudeFinder(async () => "/bin/claude");
  setTmuxRunner(async (args) => {
    calls.push(args);
    if (args[0] === "-V") return "tmux 3.5a";
    const sub = args[4];
    const target = (args[args.indexOf("-t") + 1] ?? "").replace(/^=/, "").replace(/:.*$/, "");
    if (sub === "has-session" && !alive.has(target)) throw new Error("can't find session");
    if (sub === "new-session") alive.add(args[args.indexOf("-s") + 1]!);
    return "";
  });
});

const reopen = (id: string) => app.request(`/tasks/${id}/reopen`, { method: "POST" });

/** 自主任务交付后被合并收工：会话关了（tmux 里没了），worktree 还在 */
function closedTask(jobId: string, worktree: string) {
  const t = createTask({ title: `自主 ${jobId}`, kind: "code", status: "done", project: "demo", source: { jobId, autonomous: true, repoDir: "/repo", worktree } });
  createJob({ id: jobId, project: "demo", dir: worktree, logPath: "/tmp/x.log", taskId: t.id, sessionId: t.id });
  setJobSession(jobId, "claude-sess-1");
  finishJob(jobId, 0);
  createTermSession({ id: t.id, project: "demo", repoDir: "/repo", tmuxName: `demo-${jobId}`, kind: "autonomous", jobId });
  updateTermSession(t.id, { status: "closed", worktree });
  createRun({ id: jobId, jobId, taskId: t.id, project: "demo", kind: "autonomous", trigger: "retry" });
  setRunOutcome(jobId, "merged_as_is");
  return t;
}

describe("重新打开收工了的任务", () => {
  it("回到进行中，在原 worktree 里重建会话、--resume 接回原来的对话，合并记账改成 reopened", async () => {
    const wt = mkdtempSync(join(tmpdir(), "friday-reopen-"));
    const t = closedTask("ro-1", wt);
    const res = await reopen(t.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ terminal: true });
    expect(getTask(t.id)!.status).toBe("processing");
    const ns = calls.find((a) => a[4] === "new-session")!;
    expect(ns).toContain("demo-ro-1");
    expect(ns[ns.indexOf("-c") + 1]).toBe(wt);
    const script = readFileSync(join(runsDir(), "ro-1.resume.sh"), "utf8");
    expect(script).toMatch(/--resume \S*claude-sess-1/);
    expect(script.trimEnd().endsWith("exec /bin/zsh -il")).toBe(true);
    expect(getTermSession(t.id)!.status).toBe("running");
    expect(getJob("ro-1")!.status).toBe("running");
    expect(runByJob("ro-1")!.outcome).toBe("reopened");
    expect(listAudit({ taskId: t.id }).map((e) => e.action)).toEqual(expect.arrayContaining(["task_reopened", "terminal_revived"]));
  });

  it("worktree 已经删了：任务照样重开，不建会话", async () => {
    const t = closedTask("ro-2", join(tmpdir(), "friday-reopen-gone-xyz"));
    expect(await (await reopen(t.id)).json()).toMatchObject({ terminal: false });
    expect(getTask(t.id)!.status).toBe("processing");
    expect(calls.some((a) => a[4] === "new-session")).toBe(false);
  });

  it("没开过工的回待办；没收工的不动", async () => {
    const idle = createTask({ title: "口头", kind: "verbal", status: "ignored", source: {} });
    await reopen(idle.id);
    expect(getTask(idle.id)!.status).toBe("understood");
    const open = createTask({ title: "在做", kind: "verbal", status: "review", source: {} });
    await reopen(open.id);
    expect(getTask(open.id)!.status).toBe("review");
  });
});
