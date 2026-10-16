import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTask, getTask, updateTask } from "../memory/tasks.js";
import { finishJob, getJob, runningJobs, setJobSession } from "../memory/jobs.js";
import { listAudit } from "../memory/audit.js";
import { openRunForTask, runByJob, runsForTask } from "../memory/runs.js";
import { getTermSession, updateTermSession } from "../memory/termSessions.js";
import { updateSettings } from "../settings.js";
import { config } from "../config.js";
import { setTmuxRunner } from "./tmux.js";
import { setClaudeFinder } from "./runner.js";
import { openSession, resumeInSession, setLauncher, worktreeReady } from "./sessions.js";
import { handToStorySession, rejectTask, startAutonomousJob } from "./pipeline.js";
import { handToFriday } from "./taskStart.js";
import { AUTOSTART_SETTLE_MS, autostartTick, testingStoryBug } from "./autostart.js";
import { addTestWorktree, mainRepo } from "./testRepos.js";

const repo = (name: string) => mainRepo(name);

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
// 敲命令前先清空 shell 输入行：残留的按键会拼到命令前面
const clearedBeforeTyping = () => {
  const keys = calls.filter((c) => c[4] === "send-keys").map((c) => (c.includes("-l") ? "-l" : c.at(-1)));
  return keys[keys.lastIndexOf("-l") - 1] === "C-u";
};
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
    const { t } = await exitedSession("autonomous", dir, addTestWorktree(dir, "app-fix-a"));
    expect(await resumeInSession(t.id)).toBe(true);
    const pre = settingsOf(scriptOf(typed().at(-1)!)).hooks.PreToolUse!;
    expect(pre.some((h) => h.matcher === "Bash" && h.hooks[0]!.command.includes(".guard.sh"))).toBe(true);
    expect(pre.find((h) => h.matcher === "AskUserQuestion|ExitPlanMode")!.hooks[0]!.command).toContain("deny");
  });

  it("交互式接回：不挂守卫", async () => {
    const dir = repo("app");
    const { t } = await exitedSession("interactive", dir, addTestWorktree(dir, "app-feat-b"));
    expect(await resumeInSession(t.id)).toBe(true);
    const pre = settingsOf(scriptOf(typed().at(-1)!)).hooks.PreToolUse!;
    expect(pre.some((h) => h.matcher === "Bash")).toBe(false);
    expect(clearedBeforeTyping()).toBe(true);
  });
});

describe("自主入口遇到已退出的根会话：在原会话里起一次新的自主运行", () => {
  it("retry：不新建 tmux 会话，脚本是 -p --model + 守卫 settings，新 job 与 runs 记账", async () => {
    const dir = repo("app");
    const { t, jobId: old } = await exitedSession("autonomous", dir, addTestWorktree(dir, "app-fix-c"));
    launched = [];
    const after = await startAutonomousJob(getTask(t.id)!, "app", dir, "再修一次", "retry");
    expect(launched).toEqual([]);
    expect(clearedBeforeTyping()).toBe(true);
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
    await worktreeReady(jobId, addTestWorktree(dir, "asapp-feat-s"));
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
    await worktreeReady(storyJob, addTestWorktree(dir, "r1app-feat-s"));
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

const guardPathOf = (script: string) => settingsOf(script).hooks.PreToolUse!.find((h) => h.matcher === "Bash")!.hooks[0]!.command.replace(/^'|'$/g, "");

async function testingStory(name: string, kind: "interactive" | "autonomous" = "interactive") {
  const dir = repo(name);
  const root = createTask({ title: `需求 ${name}`, kind: "meegle", source: { meegleId: `${name}-S`, meegleType: "story" }, status: "processing", project: name, stage: "testing" });
  const rootJobId = await openSession(root, root, { kind, project: name, repoDir: dir, task: "x" });
  const wt = addTestWorktree(dir, `${name}-feat-s`);
  await worktreeReady(rootJobId, wt);
  const bug = (n = 1) =>
    createTask({ title: `缺陷 ${name} ${n}`, kind: "meegle", status: "understood", stage: "todo", project: name, source: { meegleType: "issue", meegleId: `${name}-B${n}`, linkedStoryId: `${name}-S` } });
  return { root: getTask(root.id)!, rootJobId, bug, wt };
}

describe("测试阶段缺陷交代进需求会话", () => {
  it("interactive 根活着：send-keys 敲进去，缺陷卡 processing + handedAt，不写 jobId，runs 一行 story_bug", async () => {
    const { root, rootJobId, bug: mk, wt } = await testingStory("sbalive");
    const bug = updateTask(mk().id, { source: { jobId: "stale-job" } })!;
    calls = [];
    expect(await handToStorySession(bug, root)).toBe("handed");
    expect(typed().at(-1)).toContain(bug.id.slice(0, 8));
    expect(typed().at(-1)).not.toMatch(/^\/bin\/zsh/);
    const after = getTask(bug.id)!;
    expect(after).toMatchObject({ status: "processing", source: { rootId: root.id, autonomous: true, worktree: wt } });
    expect(after.source.handedAt).toBeTruthy();
    expect(after.source.jobId).toBeUndefined();
    expect(openRunForTask(bug.id)).toMatchObject({ kind: "story_bug", trigger: "autostart", jobId: `${rootJobId}#${bug.id.slice(0, 8)}` });
    expect(runByJob(rootJobId)).toBeUndefined();
    expect(listAudit({ taskId: bug.id }).some((e) => e.action === "autostart")).toBe(true);
  });

  it("根已退出：同一会话里起 -p --model opus --resume，守卫在且不含 merge，缺陷卡有新 jobId", async () => {
    const { root, rootJobId, bug: mk } = await testingStory("sbexit");
    const bug = mk();
    setJobSession(rootJobId, "sess-root");
    updateTermSession(root.id, { status: "exited" });
    calls = [];
    launched = [];
    expect(await handToStorySession(bug, root)).toBe("handed");
    expect(launched).toEqual([]);
    const script = scriptOf(typed().at(-1)!);
    expect(script).toMatch(/-p --model ['\\].*opus/);
    expect(script).toContain("--resume '\\''sess-root'\\''");
    const guard = readFileSync(guardPathOf(script), "utf8");
    expect(guard).not.toContain("合并由 Friday");
    expect(guard).toContain("变基会改写历史");
    const jobId = getTask(bug.id)!.source.jobId!;
    expect(jobId).toBeTruthy();
    expect(getJob(jobId)).toMatchObject({ sessionId: root.id, taskId: bug.id, status: "running" });
    expect(getTermSession(root.id)!.jobId).toBe(rootJobId);
    expect(runByJob(jobId)).toMatchObject({ id: jobId, kind: "story_bug", taskId: bug.id });
  });

  it("autonomous 根活着：busy，不敲字", async () => {
    const { root, bug: mk } = await testingStory("sbbusy", "autonomous");
    const bug = mk();
    calls = [];
    expect(await handToStorySession(bug, root)).toBe("busy");
    expect(typed()).toEqual([]);
    expect(getTask(bug.id)!.status).toBe("understood");
    expect(openRunForTask(bug.id)).toBeUndefined();
    updateTask(bug.id, { status: "ignored" });
  });

  it("会话 closed：no-session，记 story_session_gone，缺陷卡不动", async () => {
    const { root, bug: mk } = await testingStory("sbgone");
    const bug = mk();
    updateTermSession(root.id, { status: "closed" });
    calls = [];
    expect(await handToStorySession(bug, root)).toBe("no-session");
    expect(typed()).toEqual([]);
    expect(listAudit({ taskId: bug.id }).some((e) => e.action === "story_session_gone")).toBe(true);
    expect(getTask(bug.id)).toMatchObject({ status: "understood" });
    expect(getTask(bug.id)!.source.handedAt).toBeUndefined();
  });

  it("打回后带原因重交；根退出时走 headless 路", async () => {
    const { root, bug: mk } = await testingStory("sbreject");
    const bug = mk();
    expect(await handToStorySession(bug, root)).toBe("handed");
    const first = openRunForTask(bug.id)!;
    updateTermSession(root.id, { status: "exited" });
    calls = [];
    rejectTask(bug.id, "改错页面了");
    expect(runsForTask(bug.id).find((r) => r.id === first.id)!.endedAt).toBeTruthy();
    await vi.waitFor(() => expect(getTask(bug.id)!.source.jobId).toBeTruthy());
    const script = scriptOf(typed().at(-1)!);
    expect(script).toContain("上一轮被打回：改错页面了");
    expect(script).toMatch(/-p --model/);
    const runs = runsForTask(bug.id);
    expect(runs.find((r) => r.id === first.id)).toMatchObject({ outcome: "rejected" });
    expect(runs.find((r) => r.id === getTask(bug.id)!.source.jobId)).toMatchObject({ kind: "story_bug", outcome: "pending", trigger: "retry" });
    expect(openRunForTask(bug.id)!.id).toBe(getTask(bug.id)!.source.jobId);
    expect(listAudit({ taskId: bug.id }).some((e) => e.action === "retry" && e.why === "打回后重交")).toBe(true);
    expect(runs.find((r) => r.id === getTask(bug.id)!.source.jobId)!.endedAt).toBeFalsy();
  });

  it("打回时根会话在忙：重交不了，缺陷卡标 blocked 说明原因", async () => {
    const { root, bug: mk } = await testingStory("sbrejbusy", "autonomous");
    const bug = updateTask(mk().id, { status: "processing", source: { rootId: root.id, handedAt: new Date().toISOString(), autonomous: true } })!;
    calls = [];
    rejectTask(bug.id, "没修好");
    await vi.waitFor(() => expect(getTask(bug.id)!.status).toBe("blocked"));
    expect(getTask(bug.id)!.progress).toContain("需求会话里的 Claude 还在跑");
    expect(typed()).toEqual([]);
  });

  it("打回重交时 tmux 出错：缺陷卡标 blocked 写明错误，不占着需求的串行名额", async () => {
    const { root, bug: mk } = await testingStory("sbrejthrow");
    const bug = mk();
    expect(await handToStorySession(bug, root)).toBe("handed");
    updateTermSession(root.id, { status: "exited" });
    setTmuxRunner(async (args) => {
      if (args[4] === "send-keys") throw new Error("tmux 炸了");
      if (args[4] === "list-windows") return "0|claude|1\n";
      return "";
    });
    rejectTask(bug.id, "没修好");
    await vi.waitFor(() => expect(getTask(bug.id)!.status).toBe("blocked"));
    expect(getTask(bug.id)!.progress).toBe("打回了，但重交时出错：tmux 炸了");
  });

  it("交给 Friday 改：需求在测试中就交代进需求会话，不另开 worktree", async () => {
    const dir = repo("sbretry");
    writeFileSync(join(config.dataDir, "projects.md"), `# 项目\n\n## sbretry\n- 目录：${dir}\n`);
    const { root, bug: mk } = await testingStory("sbretry");
    const bug = mk();
    calls = [];
    launched = [];
    const r = await handToFriday(getTask(bug.id)!);
    expect("task" in r && r.task.source.handedAt).toBeTruthy();
    expect(launched).toEqual([]);
    expect(getTask(bug.id)!.source.rootId).toBe(root.id);
    expect(openRunForTask(bug.id)).toMatchObject({ trigger: "retry" });
    updateTermSession(root.id, { status: "closed" });
    const bug2 = mk(2);
    expect(await handToFriday(getTask(bug2.id)!)).toMatchObject({ status: 409, error: "需求会话已不在，先给需求开终端" });
  });

  it("autostartTick：需求在测试中就接，不看 intake；同一需求第二条等前一条", async () => {
    for (const j of runningJobs()) finishJob(j.id, 0);
    updateSettings({ autonomous: true });
    const { root, bug: mk } = await testingStory("sbtick");
    const intake = { kind: "queue" as const, confidence: 30, project: "sbtick", detail: "排着", why: "不具体", at: new Date().toISOString() };
    const a = updateTask(mk(1).id, { source: { intake } })!;
    const b = updateTask(mk(2).id, { source: { intake } })!;
    calls = [];
    expect(await autostartTick()).toBe(1);
    const handed = [a, b].filter((t) => getTask(t.id)!.source.handedAt);
    expect(handed).toHaveLength(1);
    const other = [a, b].find((t) => !getTask(t.id)!.source.handedAt)!;
    expect(testingStoryBug(getTask(other.id)!)).toBe("等前一条修完");
    expect(getTask(handed[0]!.id)!.source.rootId).toBe(root.id);
    updateSettings({ autonomous: false });
  });
});
