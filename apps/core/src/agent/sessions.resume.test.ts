import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTask, getTask, updateTask } from "../memory/tasks.js";
import { finishJob, getJob, runningJobs, setJobSession } from "../memory/jobs.js";
import { listAudit } from "../memory/audit.js";
import { openRunForTask, runByJob, runsForTask } from "../memory/runs.js";
import { getTermSession, updateTermSession } from "../memory/termSessions.js";
import { updateSettings } from "../settings.js";
import { config } from "../config.js";
import { db } from "../memory/db.js";
import { app } from "../api/index.js";
import { setPsRunner, setTmuxRunner } from "./tmux.js";
import { setClaudeFinder, transcriptPath } from "./runner.js";
import { closeRunForTask, fillRunCost } from "./runLog.js";
import { createRun } from "../memory/runs.js";
import { openSession, resumeInSession, setLauncher, worktreeReady } from "./sessions.js";
import { handToStorySession, rejectTask, reopenTask, startAutonomousJob } from "./pipeline.js";
import { syncMeegleOnce } from "./meegle.js";
import { state } from "../scheduler/index.js";
import { handToFriday, startTask } from "./taskStart.js";
import { AUTOSTART_SETTLE_MS, autostartTick, testingStoryBug } from "./autostart.js";
import { addTestWorktree, mainRepo } from "./testRepos.js";

const repo = (name: string) => mainRepo(name);

let calls: string[][] = [];
let alive = new Set<string>();
let launched: string[] = [];
let panes = "";
let failKeysFor = "";
beforeEach(() => {
  calls = [];
  launched = [];
  panes = "";
  failKeysFor = "";
  setClaudeFinder(async () => "/bin/claude");
  setTmuxRunner(async (args) => {
    calls.push(args);
    if (args[0] === "-V") return "tmux 3.5a";
    const sub = args[4];
    const target = (args[args.indexOf("-t") + 1] ?? "").replace(/^=/, "").replace(/:.*$/, "");
    if (sub === "has-session" && !alive.has(target)) throw new Error("can't find session");
    if (sub === "list-windows") return "0|claude|1\n";
    if (sub === "list-panes") return panes;
    if (sub === "send-keys" && failKeysFor && target === failKeysFor) throw new Error("tmux 炸了");
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

describe("接回不丢模型", () => {
  it("自主任务接回：带 --model、不带 -p；用户自己的交互式接回不带 --model", async () => {
    const dir = repo("app");
    const { t } = await exitedSession("autonomous", dir, addTestWorktree(dir, "app-resume-model-a"));
    expect(await resumeInSession(t.id)).toBe(true);
    const mine = scriptOf(typed().at(-1)!);
    expect(mine).toContain("--model");
    expect(mine).not.toMatch(/ -p /);
    const { t: u } = await exitedSession("interactive", dir, addTestWorktree(dir, "app-resume-model-b"));
    expect(await resumeInSession(u.id)).toBe(true);
    expect(scriptOf(typed().at(-1)!)).not.toContain("--model");
  });
});

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
  it("retry：不新建 tmux 会话，脚本是交互式 --model opus + 守卫 settings，新 job 与 runs 记账", async () => {
    const dir = repo("app");
    const { t, jobId: old } = await exitedSession("autonomous", dir, addTestWorktree(dir, "app-fix-c"));
    launched = [];
    const after = await startAutonomousJob(getTask(t.id)!, "app", dir, "再修一次", "retry");
    expect(launched).toEqual([]);
    expect(clearedBeforeTyping()).toBe(true);
    const script = scriptOf(typed().at(-1)!);
    expect(script).toMatch(/--model ['\\].*opus/);
    expect(script).not.toMatch(/ -p /);
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
    expect(storyScript).not.toContain("--fork-session");
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
    expect(script).toMatch(/--model ['\\].*opus/);
    expect(script).not.toMatch(/ -p /);
    expect(script).toContain("--resume '\\''sess-root'\\'' --fork-session");
    const guard = readFileSync(guardPathOf(script), "utf8");
    expect(guard).not.toContain("合并由 Friday");
    expect(guard).toContain("保护分支");
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

  it("需求终端在问你（attention question）：asking，不往弹窗里敲回车", async () => {
    const { root, bug: mk } = await testingStory("sbasking");
    const bug = mk();
    const asking = updateTask(root.id, { attention: "question" })!;
    calls = [];
    expect(await handToStorySession(bug, asking)).toBe("asking");
    expect(calls.some((c) => c[4] === "send-keys")).toBe(false);
    expect(getTask(bug.id)!.status).toBe("understood");
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
    expect(script).toMatch(/--model/);
    expect(script).not.toMatch(/ -p /);
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

  it("交代过的缺陷还在处理中：开始做、再交给 Friday 改都 409；交付后点开始做 = 你接手，清掉交接标记", async () => {
    const dir = repo("sbguard");
    writeFileSync(join(config.dataDir, "projects.md"), `# 项目\n\n## sbguard\n- 目录：${dir}\n`);
    const { root, bug: mk } = await testingStory("sbguard");
    const bug = mk();
    expect(await handToStorySession(bug, root)).toBe("handed");
    calls = [];
    launched = [];
    expect(await handToFriday(getTask(bug.id)!)).toMatchObject({ status: 409, error: "这条已经交代进需求会话了" });
    expect(await startTask(getTask(bug.id)!)).toMatchObject({ status: 409, error: "这条缺陷在需求会话里由 Friday 修，要接手就在需求终端里说" });
    expect(typed()).toEqual([]);
    expect(launched).toEqual([]);
    updateTask(bug.id, { status: "review" });
    const r = await startTask(getTask(bug.id)!);
    expect("task" in r).toBe(true);
    const after = getTask(bug.id)!;
    expect(after.source.handedAt).toBeUndefined();
    expect(after.source.autonomous).toBeUndefined();
    expect(after.status).toBe("processing");
    updateTask(bug.id, { status: "ignored" });
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

describe("交给需求会话修过的缺陷被重开", () => {
  const reopened = (id: string) =>
    ({ fetchWorkItems: async () => [{ id, name: `缺陷 ${id}`, typeName: "Defect", typeKey: "issue", links: [], status: "Reopened", projectName: "demo", url: `https://x/${id}`, createdAt: "2026-09-01T00:00:00Z" }] }) as never;

  it("Meegle Reopen、需求还在测试中：清交接标记回未开始，门禁重新接；「没过」写进下一次交代，交代后清掉", async () => {
    const { root, bug: mk } = await testingStory("sbreopen");
    const bug = mk();
    expect(await handToStorySession(bug, root)).toBe("handed");
    updateTask(bug.id, { status: "done", stage: "testing", source: { jobId: "old-job" } });
    await syncMeegleOnce(reopened(bug.source.meegleId!));
    const after = getTask(bug.id)!;
    expect(after).toMatchObject({ status: "understood", stage: "todo" });
    expect(after.source.handedAt).toBeUndefined();
    expect(after.source.jobId).toBeUndefined();
    expect(after.source.autonomous).toBeUndefined();
    expect(after.source.handBackNote).toBe("测试在 Meegle 里把它 Reopen 了（Reopened），上一轮的修法没过");
    expect(testingStoryBug(after)).toMatchObject({ root: { id: root.id } });
    calls = [];
    expect(await handToStorySession(after, getTask(root.id)!)).toBe("handed");
    expect(typed().at(-1)).toContain("上一轮被打回：测试在 Meegle 里把它 Reopen 了（Reopened），上一轮的修法没过");
    expect(getTask(bug.id)!.source.handBackNote).toBeUndefined();
    expect(getTask(bug.id)!.source.handedAt).toBeTruthy();
    updateTask(bug.id, { status: "ignored" });
  });

  it("Meegle Reopen、需求已不在测试中：照旧回进行中，只清交接标记", async () => {
    const { root, bug: mk } = await testingStory("sbreopen2");
    const bug = mk();
    expect(await handToStorySession(bug, root)).toBe("handed");
    updateTask(bug.id, { status: "done" });
    updateTask(root.id, { stage: "released" });
    await syncMeegleOnce(reopened(bug.source.meegleId!));
    const after = getTask(bug.id)!;
    expect(after).toMatchObject({ status: "understood", stage: "dev" });
    expect(after.source.handedAt).toBeUndefined();
    expect(after.source.handBackNote).toBeUndefined();
    updateTask(bug.id, { status: "ignored" });
  });

  it("Friday 里重新打开、需求还在测试中：回待办未开始、不接回会话，门禁重新接", async () => {
    const { root, rootJobId, bug: mk } = await testingStory("sbreopen3");
    const bug = mk();
    setJobSession(rootJobId, "sess-root");
    updateTermSession(root.id, { status: "exited" });
    expect(await handToStorySession(bug, root)).toBe("handed");
    finishJob(getTask(bug.id)!.source.jobId!, 0);
    updateTask(bug.id, { status: "done", stage: "testing" });
    calls = [];
    launched = [];
    const r = (await reopenTask(bug.id))!;
    expect(r.terminal).toBe(false);
    expect(typed()).toEqual([]);
    expect(launched).toEqual([]);
    const after = getTask(bug.id)!;
    expect(after).toMatchObject({ status: "understood", stage: "todo" });
    expect(after.source.handedAt).toBeUndefined();
    expect(after.source.jobId).toBeUndefined();
    expect(after.source.handBackNote).toBe("你在 Friday 里重新打开了它");
    expect(testingStoryBug(after)).toMatchObject({ root: { id: root.id } });
    updateTask(bug.id, { status: "ignored" });
  });

  it("Friday 里重新打开、需求不在测试中：回待办，只清交接标记", async () => {
    const { root, bug: mk } = await testingStory("sbreopen4");
    const bug = mk();
    expect(await handToStorySession(bug, root)).toBe("handed");
    updateTask(bug.id, { status: "done", stage: "testing" });
    updateTask(root.id, { stage: "released" });
    await reopenTask(bug.id);
    const after = getTask(bug.id)!;
    expect(after).toMatchObject({ status: "understood", stage: "testing" });
    expect(after.source.handedAt).toBeUndefined();
    expect(after.source.handBackNote).toBeUndefined();
    updateTask(bug.id, { status: "ignored" });
  });
});

describe("测试阶段缺陷交代：收尾补齐", () => {
  it("手动交给 Friday 改不推「Friday 接手了一条缺陷」", async () => {
    const { root, bug: mk } = await testingStory("sbnotice");
    const bug = mk();
    const before = state.notices.length;
    expect(await handToStorySession(bug, root, { trigger: "retry" })).toBe("handed");
    expect(state.notices.length).toBe(before);
    updateTask(bug.id, { status: "ignored" });
  });

  it("需求终端在问你：交给 Friday 改回 409 写明在等回答；打回重交不了也写明", async () => {
    const dir = repo("sbaskfr");
    writeFileSync(join(config.dataDir, "projects.md"), `# 项目\n\n## sbaskfr\n- 目录：${dir}\n`);
    const { root, bug: mk } = await testingStory("sbaskfr");
    const a = mk(1);
    expect(await handToStorySession(a, root)).toBe("handed");
    updateTask(root.id, { attention: "question" });
    const b = mk(2);
    expect(await handToFriday(getTask(b.id)!)).toMatchObject({ status: 409, error: "需求终端在等你回答它的问题，答完再交" });
    rejectTask(a.id, "没修好");
    await vi.waitFor(() => expect(getTask(a.id)!.status).toBe("blocked"));
    expect(getTask(a.id)!.progress).toBe("打回了，但需求终端在等你回答，没能重交，答完点「交给 Friday 改」");
    for (const t of [a, b]) updateTask(t.id, { status: "ignored" });
  });

  it("从待审重交：上一轮记打回并收尾，新一轮开着", async () => {
    const dir = repo("sbrehand");
    writeFileSync(join(config.dataDir, "projects.md"), `# 项目\n\n## sbrehand\n- 目录：${dir}\n`);
    const { root, bug: mk } = await testingStory("sbrehand");
    const bug = mk();
    expect(await handToStorySession(bug, root)).toBe("handed");
    const first = openRunForTask(bug.id)!;
    updateTask(bug.id, { status: "review" });
    const r = await handToFriday(getTask(bug.id)!);
    expect("task" in r).toBe(true);
    const old = runsForTask(bug.id).find((x) => x.id === first.id)!;
    expect(old.outcome).toBe("rejected");
    expect(old.endedAt).toBeTruthy();
    const open = openRunForTask(bug.id)!;
    expect(open.id).not.toBe(first.id);
    expect(open.outcome).toBe("pending");
    updateTask(bug.id, { status: "ignored" });
  });

  it("会话记着 running、Claude 其实已退出：走后台 -p --resume --fork-session", async () => {
    const { root, rootJobId, bug: mk } = await testingStory("sbgoneclaude");
    const bug = mk();
    setJobSession(rootJobId, "sess-root");
    db().prepare("UPDATE term_sessions SET last_input_at = ? WHERE id = ?").run(new Date(Date.now() - 60_000).toISOString(), root.id);
    panes = "999\n";
    setPsRunner(async () => "  123 1 /bin/zsh\n 1000 999 -zsh\n");
    calls = [];
    launched = [];
    expect(await handToStorySession(bug, getTask(root.id)!)).toBe("handed");
    expect(launched).toEqual([]);
    const script = scriptOf(typed().at(-1)!);
    expect(script).toMatch(/--model/);
    expect(script).not.toMatch(/ -p /);
    expect(script).toContain("--resume '\\''sess-root'\\'' --fork-session");
    expect(getTask(bug.id)!.source.jobId).toBeTruthy();
    updateTask(bug.id, { status: "ignored" });
  });

  it("autostartTick：一条交代出错，另一个需求下那条照样交代", async () => {
    for (const j of runningJobs()) finishJob(j.id, 0);
    updateSettings({ autonomous: true });
    const one = await testingStory("sbtickx");
    const two = await testingStory("sbticky");
    const a = updateTask(one.bug().id, { priority: "high" })!;
    const b = updateTask(two.bug().id, { priority: "low" })!;
    failKeysFor = getTermSession(one.root.id)!.tmuxName;
    expect(await autostartTick()).toBe(1);
    expect(getTask(a.id)!.source.handedAt).toBeUndefined();
    expect(getTask(b.id)!.source.handedAt).toBeTruthy();
    updateSettings({ autonomous: false });
    for (const t of [a, b]) updateTask(t.id, { status: "ignored" });
  });
});

describe("重开 / 重交时上一轮的记账（fix round 1）", () => {
  const reopened = (id: string) =>
    ({ fetchWorkItems: async () => [{ id, name: `缺陷 ${id}`, typeName: "Defect", typeKey: "issue", links: [], status: "Reopened", projectName: "demo", url: `https://x/${id}`, createdAt: "2026-09-01T00:00:00Z" }] }) as never;
  const headless = async (name: string) => {
    const { root, rootJobId, bug: mk } = await testingStory(name);
    setJobSession(rootJobId, "sess-root");
    updateTermSession(root.id, { status: "exited" });
    const bug = mk();
    expect(await handToStorySession(bug, root)).toBe("handed");
    const jobId = getTask(bug.id)!.source.jobId!;
    expect(getJob(jobId)!.status).toBe("running");
    return { root, bug, jobId };
  };

  it("上一轮的 -p 还在跑：重新打开回 409，卡片和交接标记都不动；它退出后能重开", async () => {
    const { bug, jobId } = await headless("sbreopenrun");
    updateTask(bug.id, { status: "done" });
    const res = await app.request(`/tasks/${bug.id}/reopen`, { method: "POST" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("上一轮还在需求会话里跑，等它退出再重开");
    expect(getTask(bug.id)).toMatchObject({ status: "done", source: { jobId } });
    expect(getTask(bug.id)!.source.handedAt).toBeTruthy();
    finishJob(jobId, 0);
    expect((await app.request(`/tasks/${bug.id}/reopen`, { method: "POST" })).status).toBe(200);
    expect(getTask(bug.id)!.source.handedAt).toBeUndefined();
    updateTask(bug.id, { status: "ignored" });
  });

  it("上一轮的 -p 还在跑：Meegle Reopen 这一轮跳过，退出后下一轮再处理", async () => {
    const { bug, jobId } = await headless("sbmreopenrun");
    updateTask(bug.id, { status: "done", stage: "testing" });
    expect((await syncMeegleOnce(reopened(bug.source.meegleId!))).reopened).toBe(0);
    expect(getTask(bug.id)).toMatchObject({ status: "done", stage: "testing", source: { jobId } });
    expect(getTask(bug.id)!.source.handBackNote).toBeUndefined();
    finishJob(jobId, 0);
    expect((await syncMeegleOnce(reopened(bug.source.meegleId!))).reopened).toBe(1);
    expect(getTask(bug.id)).toMatchObject({ status: "understood", stage: "todo" });
    expect(getTask(bug.id)!.source.jobId).toBeUndefined();
    updateTask(bug.id, { status: "ignored" });
  });

  it("从待审重交但需求会话在忙：上一轮仍是待定、没收尾", async () => {
    const dir = repo("sbrehbusy");
    writeFileSync(join(config.dataDir, "projects.md"), `# 项目\n\n## sbrehbusy\n- 目录：${dir}\n`);
    const { root, bug: mk } = await testingStory("sbrehbusy");
    const bug = mk();
    expect(await handToStorySession(bug, root)).toBe("handed");
    const first = openRunForTask(bug.id)!;
    updateTask(bug.id, { status: "review" });
    updateTermSession(root.id, { kind: "autonomous" });
    expect(await handToFriday(getTask(bug.id)!)).toMatchObject({ status: 409 });
    const old = runsForTask(bug.id).find((x) => x.id === first.id)!;
    expect(old.outcome).toBe("pending");
    expect(old.endedAt).toBeFalsy();
    updateTask(bug.id, { status: "ignored" });
  });

  it("卡住的重交：上一轮只收尾，不记打回", async () => {
    const dir = repo("sbrehblk");
    writeFileSync(join(config.dataDir, "projects.md"), `# 项目\n\n## sbrehblk\n- 目录：${dir}\n`);
    const { root, bug: mk } = await testingStory("sbrehblk");
    const bug = mk();
    expect(await handToStorySession(bug, root)).toBe("handed");
    const first = openRunForTask(bug.id)!;
    updateTask(bug.id, { status: "blocked" });
    expect("task" in (await handToFriday(getTask(bug.id)!))).toBe(true);
    const old = runsForTask(bug.id).find((x) => x.id === first.id)!;
    expect(old.outcome).toBe("pending");
    expect(old.endedAt).toBeTruthy();
    expect(openRunForTask(bug.id)!.id).not.toBe(first.id);
    updateTask(bug.id, { status: "ignored" });
  });
});

describe("headless 交接的成本只记本轮增量", () => {
  const costLine = (usd: number, model = "claude-opus-5") => JSON.stringify({ type: "cost-state", totalCostUSD: usd, modelUsage: { [model]: { costUSD: usd } } });
  const transcript = (dir: string, sid: string, lines: string[]) => {
    const p = transcriptPath(dir, sid);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, lines.join("\n") + "\n");
  };

  it("fork 出来的 transcript 带着需求会话的累计成本：缺陷那行只记差额；没有基线的照旧记全额", async () => {
    const realHome = process.env.HOME;
    process.env.HOME = mkdtempSync(join(tmpdir(), "friday-home-"));
    try {
      const { root, rootJobId, bug: mk, wt } = await testingStory("sbcost");
      setJobSession(rootJobId, "sess-story");
      updateTermSession(root.id, { status: "exited" });
      const story = costLine(2, "claude-haiku-4-5");
      transcript(wt, "sess-story", [story]);
      const bug = mk();
      expect(await handToStorySession(bug, root)).toBe("handed");
      const jobId = getTask(bug.id)!.source.jobId!;
      expect(runByJob(jobId)!.costBase).toBe(2);
      setJobSession(jobId, "sess-fork");
      transcript(wt, "sess-fork", [story, costLine(2.75)]);
      closeRunForTask(bug.id, "report", wt, "sess-fork");
      expect(runByJob(jobId)!.costUsd).toBeCloseTo(0.75);

      const plain = createTask({ title: "普通", kind: "verbal", source: {}, status: "processing" });
      createRun({ id: "plain-cost", jobId: "plain-cost", taskId: plain.id, project: "sbcost", kind: "autonomous", trigger: "retry" });
      closeRunForTask(plain.id, "report", wt, "sess-fork");
      expect(runByJob("plain-cost")!.costUsd).toBeCloseTo(2.75);
      updateTask(bug.id, { status: "ignored" });
    } finally {
      process.env.HOME = realHome;
    }
  });

  it("交付时成本还没落盘：退出后补的那次也减掉基线", async () => {
    const realHome = process.env.HOME;
    process.env.HOME = mkdtempSync(join(tmpdir(), "friday-home-"));
    try {
      const { root, rootJobId, bug: mk, wt } = await testingStory("sbcost2");
      setJobSession(rootJobId, "sess-story2");
      updateTermSession(root.id, { status: "exited" });
      const story = costLine(1.5);
      transcript(wt, "sess-story2", [story]);
      const bug = mk();
      expect(await handToStorySession(bug, root)).toBe("handed");
      const jobId = getTask(bug.id)!.source.jobId!;
      setJobSession(jobId, "sess-fork2");
      closeRunForTask(bug.id, "report", wt, "sess-fork2");
      expect(runByJob(jobId)!.costUsd).toBeUndefined();
      transcript(getJob(jobId)!.dir, "sess-fork2", [story, costLine(1.9)]);
      fillRunCost(jobId);
      expect(runByJob(jobId)!.costUsd).toBeCloseTo(0.4);
      updateTask(bug.id, { status: "ignored" });
    } finally {
      process.env.HOME = realHome;
    }
  });
});

