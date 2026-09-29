import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createTask, getTask } from "../memory/tasks.js";
import { finishJob, getJob, runningJobs, setJobSession } from "../memory/jobs.js";
import { listAudit } from "../memory/audit.js";
import { runByJob } from "../memory/runs.js";
import { getTermSession, updateTermSession } from "../memory/termSessions.js";
import { updateSettings } from "../settings.js";
import { config } from "../config.js";
import { setTmuxRunner } from "./tmux.js";
import { setClaudeFinder } from "./runner.js";
import { openSession, resumeInSession, setLauncher, worktreeReady } from "./sessions.js";
import { startAutonomousJob } from "./pipeline.js";
import { AUTOSTART_SETTLE_MS, autostartTick } from "./autostart.js";

const repo = (name: string) => {
  const dir = join(mkdtempSync(join(tmpdir(), "friday-rs-")), name);
  mkdirSync(dir);
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  return dir;
};

let calls: string[][] = [];
let alive = new Set<string>();
let launched: string[] = [];
beforeEach(() => {
  calls = [];
  launched = [];
  setClaudeFinder(async () => "/bin/claude");
  setTmuxRunner(async (args) => {
    calls.push(args);
    if (args[0] === "-V") return "tmux 3.5a";
    const sub = args[4];
    const target = (args[args.indexOf("-t") + 1] ?? "").replace(/^=/, "").replace(/:.*$/, "");
    if (sub === "has-session" && !alive.has(target)) throw new Error("can't find session");
    if (sub === "list-windows") return "0|claude|1\n";
    if (sub === "rename-session") { alive.delete(target); alive.add(args.at(-1)!); }
    if (sub === "kill-session") alive.delete(target);
    return "";
  });
  setLauncher(async (_req, name) => { launched.push(name); alive.add(name); });
});

const typed = () => calls.filter((c) => c[4] === "send-keys" && c.includes("-l")).map((c) => c.at(-1)!);
const scriptOf = (cmd: string) => readFileSync(cmd.replace(/^\/bin\/zsh '/, "").replace(/'$/, ""), "utf8");
const settingsOf = (script: string) => JSON.parse(readFileSync(/--settings '\\''([^']+)'\\''/.exec(script)![1]!, "utf8")) as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>> };

async function exitedSession(kind: "autonomous" | "query" | "interactive", dir: string, wt?: string) {
  const t = createTask({ title: `${kind} 退出后`, kind: "verbal", source: kind === "autonomous" ? { autonomous: true } : kind === "query" ? { headless: true } : {}, status: "processing", project: "app" });
  const jobId = await openSession(t, t, { kind, project: "app", repoDir: dir, task: "x" });
  if (wt) await worktreeReady(jobId, wt);
  updateTermSession(t.id, { status: "exited" });
  return { t, jobId };
}

describe("接回不丢守卫", () => {
  it("后台查询接回：还是只读 hook（改文件的工具被拒）", async () => {
    const { t } = await exitedSession("query", repo("app"));
    expect(await resumeInSession(t.id)).toBe(true);
    const script = scriptOf(typed().at(-1)!);
    const pre = settingsOf(script).hooks.PreToolUse!.map((h) => h.matcher);
    expect(pre).toContain("Edit|Write|MultiEdit|NotebookEdit");
  });

  it("自主任务接回聊天：Bash 守卫和拒答都在", async () => {
    const dir = repo("app");
    const { t } = await exitedSession("autonomous", dir, repo("app-fix-a"));
    expect(await resumeInSession(t.id)).toBe(true);
    const pre = settingsOf(scriptOf(typed().at(-1)!)).hooks.PreToolUse!;
    expect(pre.some((h) => h.matcher === "Bash" && h.hooks[0]!.command.includes(".guard.sh"))).toBe(true);
    expect(pre.find((h) => h.matcher === "AskUserQuestion|ExitPlanMode")!.hooks[0]!.command).toContain("deny");
  });

  it("交互式接回：不挂守卫", async () => {
    const { t } = await exitedSession("interactive", repo("app"), repo("app-feat-b"));
    expect(await resumeInSession(t.id)).toBe(true);
    const pre = settingsOf(scriptOf(typed().at(-1)!)).hooks.PreToolUse!;
    expect(pre.some((h) => h.matcher === "Bash")).toBe(false);
  });
});

describe("自主入口遇到已退出的根会话：在原会话里起一次新的自主运行", () => {
  it("retry：不新建 tmux 会话，脚本是 -p --model + 守卫 settings，新 job 与 runs 记账", async () => {
    const dir = repo("app");
    const { t, jobId: old } = await exitedSession("autonomous", dir, repo("app-fix-c"));
    launched = [];
    const after = await startAutonomousJob(getTask(t.id)!, "app", dir, "再修一次", "retry");
    expect(launched).toEqual([]);
    const script = scriptOf(typed().at(-1)!);
    expect(script).toMatch(/-p --model ['\\].*opus/);
    expect(script).not.toContain("--resume");
    expect(settingsOf(script).hooks.PreToolUse!.some((h) => h.matcher === "Bash")).toBe(true);
    const jobId = after.source.jobId!;
    expect(jobId).not.toBe(old);
    expect(getJob(jobId)).toMatchObject({ status: "running", sessionId: t.id, taskId: t.id });
    expect(getTermSession(t.id)).toMatchObject({ status: "running", jobId, kind: "autonomous" });
    expect(runByJob(jobId)).toMatchObject({ kind: "autonomous", trigger: "retry" });
    expect(after).toMatchObject({ status: "processing", source: { autonomous: true } });
  });
});

describe("autostart 不碰你自己的交互式会话", () => {
  it("缺陷的需求有交互式会话开着：跳过，不敲字、不记 autostart", async () => {
    for (const j of runningJobs()) finishJob(j.id, 0);
    const dir = repo("asapp");
    writeFileSync(join(config.dataDir, "projects.md"), `# 项目\n\n## asapp\n- 目录：${dir}\n`);
    updateSettings({ autonomous: true });
    const story = createTask({ title: "需求", kind: "meegle", source: { meegleId: "AS-S1", meegleType: "story" }, status: "processing", project: "asapp" });
    const jobId = await openSession(story, story, { kind: "interactive", project: "asapp", repoDir: dir, task: "x" });
    await worktreeReady(jobId, repo("asapp-feat-s"));
    const bug = createTask({
      title: "缺陷",
      kind: "meegle",
      status: "understood",
      project: "asapp",
      source: { meegleType: "issue", meegleId: "AS-B1", linkedStoryId: "AS-S1", intake: { kind: "start", confidence: 95, project: "asapp", detail: "改一下", why: "具体", at: new Date().toISOString() } },
    });
    calls = [];
    launched = [];
    expect(await autostartTick(Date.now() + AUTOSTART_SETTLE_MS + 60_000)).toBe(0);
    expect(calls.some((c) => c[4] === "send-keys")).toBe(false);
    expect(launched).toEqual([]);
    expect(listAudit({ taskId: bug.id }).some((e) => e.action === "autostart")).toBe(false);
    expect(getTask(bug.id)!.status).toBe("understood");
  });
});

describe("缺陷在需求的会话里跑一次自主运行：会话仍归需求", () => {
  it("kind / jobId 不被改写；autostart 仍跳过同需求的缺陷；需求接着聊接回自己的对话、交互式 hook；缺陷接着聊接回缺陷自己的", async () => {
    for (const j of runningJobs()) finishJob(j.id, 0);
    const dir = repo("r1app");
    writeFileSync(join(config.dataDir, "projects.md"), `# 项目\n\n## r1app\n- 目录：${dir}\n`);
    const story = createTask({ title: "需求", kind: "meegle", source: { meegleId: "R1-S1", meegleType: "story" }, status: "processing", project: "r1app" });
    const storyJob = await openSession(story, story, { kind: "interactive", project: "r1app", repoDir: dir, task: "x" });
    await worktreeReady(storyJob, repo("r1app-feat-s"));
    setJobSession(storyJob, "sess-story");
    finishJob(storyJob, 0);
    updateTermSession(story.id, { status: "exited" });
    const intake = { kind: "start" as const, confidence: 95, project: "r1app", detail: "改一下", why: "具体", at: new Date().toISOString() };
    const bugA = createTask({ title: "缺陷甲", kind: "meegle", status: "understood", project: "r1app", source: { meegleType: "issue", meegleId: "R1-B1", linkedStoryId: "R1-S1", intake } });

    const after = await startAutonomousJob(getTask(bugA.id)!, "r1app", dir, "修甲", "retry");
    const bugJob = after.source.jobId!;
    expect(bugJob).not.toBe(storyJob);
    expect(getJob(bugJob)).toMatchObject({ sessionId: story.id, taskId: bugA.id, status: "running" });
    expect(getTermSession(story.id)).toMatchObject({ kind: "interactive", jobId: storyJob });
    expect(runByJob(bugJob)).toMatchObject({ taskId: bugA.id });
    setJobSession(bugJob, "sess-bug");
    finishJob(bugJob, 0);
    updateTermSession(story.id, { status: "exited" });

    updateSettings({ autonomous: true });
    const bugB = createTask({ title: "缺陷乙", kind: "meegle", status: "understood", project: "r1app", source: { meegleType: "issue", meegleId: "R1-B2", linkedStoryId: "R1-S1", intake } });
    calls = [];
    launched = [];
    expect(await autostartTick(Date.now() + AUTOSTART_SETTLE_MS + 60_000)).toBe(0);
    expect(calls.some((c) => c[4] === "send-keys")).toBe(false);
    expect(launched).toEqual([]);
    expect(listAudit({ taskId: bugB.id }).some((e) => e.action === "autostart")).toBe(false);
    updateSettings({ autonomous: false });

    expect(await resumeInSession(story.id)).toBe(true);
    const storyScript = scriptOf(typed().at(-1)!);
    expect(storyScript).toContain("--resume '\\''sess-story'\\''");
    expect(settingsOf(storyScript).hooks.PreToolUse!.some((h) => h.matcher === "Bash")).toBe(false);
    expect(getJob(storyJob)!.status).toBe("running");

    finishJob(storyJob, 0);
    updateTermSession(story.id, { status: "exited" });
    expect(await resumeInSession(story.id, undefined, bugJob)).toBe(true);
    const bugScript = scriptOf(typed().at(-1)!);
    expect(bugScript).toContain("--resume '\\''sess-bug'\\''");
    expect(settingsOf(bugScript).hooks.PreToolUse!.some((h) => h.matcher === "Bash" && h.hooks[0]!.command.includes(".guard.sh"))).toBe(true);
    expect(getTermSession(story.id)).toMatchObject({ kind: "interactive", jobId: storyJob });
  });
});
