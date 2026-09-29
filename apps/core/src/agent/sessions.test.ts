import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTask, getTask, updateTask } from "../memory/tasks.js";
import { getJob, listJobs } from "../memory/jobs.js";
import { getTermSession, updateTermSession } from "../memory/termSessions.js";
import { setTmuxRunner } from "./tmux.js";
import { flushQueued, joinRootSession, openSession, prepareFailed, resolveRoot, resumeInSession, sayToSession, setLauncher, worktreeReady } from "./sessions.js";
import { startInteractiveJob } from "./pipeline.js";
import { addTestWorktree, mainRepo } from "./testRepos.js";
import { listAudit } from "../memory/audit.js";

vi.mock("./runner.js", async (orig) => ({
  ...(await orig<typeof import("./runner.js")>()),
  writeResumeScript: async (req: { id: string }) => `/runs/${req.id}.resume.sh`,
}));

const repo = (name: string, branch = name) => {
  const dir = join(mkdtempSync(join(tmpdir(), "friday-wt-")), name);
  mkdirSync(dir);
  execFileSync("git", ["init", "-q", "-b", branch, dir]);
  return dir;
};

const R = mainRepo("app");
const W = mainRepo("web");

let calls: string[][] = [];
let tmuxInstalled = true;
let alive = new Set<string>();
let windowsOut: string | Error = "1|claude|0\n2|zsh|1\n";
beforeEach(() => {
  calls = [];
  windowsOut = "1|claude|0\n2|zsh|1\n";
  tmuxInstalled = true;
  setTmuxRunner(async (args) => {
    calls.push(args);
    if (args[0] === "-V") {
      if (!tmuxInstalled) throw Object.assign(new Error("spawn tmux ENOENT"), { code: "ENOENT" });
      return "tmux 3.5a";
    }
    const sub = args[4];
    const target = (args[args.indexOf("-t") + 1] ?? "").replace(/^=/, "").replace(/:.*$/, "");
    if (sub === "has-session" && !alive.has(target)) throw new Error("can't find session");
    if (sub === "list-windows") {
      if (windowsOut instanceof Error) throw windowsOut;
      return windowsOut;
    }
    if (sub === "rename-session") { alive.delete(target); alive.add(args.at(-1)!); }
    if (sub === "kill-session") alive.delete(target);
    return "";
  });
  setLauncher(async (_req, name) => {
    if (alive.has(name)) throw new Error(`duplicate session: ${name}`);
    alive.add(name);
  });
});
const sent = () => calls.filter((c) => c[4] === "send-keys" && c.includes("-l")).map((c) => c.at(-1));

describe("根任务与会话", () => {
  it("缺陷按 linkedStoryId 找到需求当根，并把 rootId 写回", () => {
    const story = createTask({ title: "养牛计划", kind: "meegle", source: { meegleId: "S1" }, status: "understood" });
    const bug = createTask({ title: "积分错位", kind: "meegle", source: { meegleId: "B1", linkedStoryId: "S1" }, status: "understood" });
    expect(resolveRoot(bug).id).toBe(story.id);
    expect(getTask(bug.id)!.source.rootId).toBe(story.id);
    const loose = createTask({ title: "散任务", kind: "verbal", source: {}, status: "understood" });
    expect(resolveRoot(loose).id).toBe(loose.id);
  });

  it("tmux 没装：开始做直接报错，任务状态不变、不留 job", async () => {
    tmuxInstalled = false;
    const t = createTask({ title: "没 tmux", kind: "verbal", source: {}, status: "understood", project: "app" });
    const before = listJobs(1000).length;
    await expect(startInteractiveJob(t, "app", R, "做一下")).rejects.toThrow("brew install tmux");
    expect(getTask(t.id)!.status).toBe("understood");
    expect(listJobs(1000).length).toBe(before);
  });

  it("开会话：会话键是根任务 id，job 归 owner，状态 preparing", async () => {
    const root = createTask({ title: "导出中心", kind: "verbal", source: {}, status: "understood", project: "app" });
    const jobId = await openSession(root, root, { kind: "interactive", project: "app", repoDir: R, task: "做导出" });
    const s = getTermSession(root.id)!;
    expect(s).toMatchObject({ status: "preparing", jobId, tmuxName: `app-${root.id.slice(0, 8)}` });
    expect(getJob(jobId)).toMatchObject({ taskId: root.id, sessionId: root.id });
  });

  it("开会话：根任务的标题和理解（截 200 字）交给启动器", async () => {
    const root = createTask({ title: "导出中心", kind: "verbal", source: {}, status: "understood", project: "app", understanding: "长".repeat(300) });
    let got: { title?: string; description?: string } = {};
    setLauncher(async (req, name) => { got = req; alive.add(name); });
    await openSession(root, root, { kind: "interactive", project: "app", repoDir: R, task: "x" });
    expect(got.title).toBe("导出中心");
    expect(got.description).toHaveLength(200);
  });

  it("准备段还没跑完时说的话先排队，SessionStart 到了再送", async () => {
    const root = createTask({ title: "排队", kind: "verbal", source: {}, status: "understood", project: "app" });
    await openSession(root, root, { kind: "interactive", project: "app", repoDir: R, task: "x" });
    expect(await sayToSession(root.id, "先等等")).toBe("queued");
    expect(sent()).toEqual([]);
    await flushQueued(root.id);
    expect(sent()).toEqual(["先等等"]);
  });

  it("需求的会话在跑：缺陷的活转达进去，不开新会话", async () => {
    const root = createTask({ title: "计费", kind: "meegle", source: { meegleId: "S2" }, status: "processing", project: "app" });
    const jobId = await openSession(root, root, { kind: "interactive", project: "app", repoDir: R, task: "x" });
    await worktreeReady(jobId, addTestWorktree(R, "app-feat-billing"));
    const bug = createTask({ title: "合计没刷新", kind: "meegle", source: { meegleId: "B2", linkedStoryId: "S2" }, status: "understood" });
    const jobs = listJobs(1000).length;
    expect(await joinRootSession(bug, resolveRoot(bug), "账单页合计没刷新")).toBe("joined");
    expect(sent().at(-1)).toContain("顺带再改一条同需求下的缺陷");
    expect(getTask(bug.id)).toMatchObject({ status: "processing", source: { rootId: root.id } });
    expect(listJobs(1000).length).toBe(jobs);
  });

  it("需求还没有会话：缺陷不转达", async () => {
    const root = createTask({ title: "没开工的需求", kind: "meegle", source: { meegleId: "S3" }, status: "understood", project: "app" });
    const bug = createTask({ title: "缺陷", kind: "meegle", source: { meegleId: "B3", linkedStoryId: "S3" }, status: "understood" });
    expect(await joinRootSession(bug, root, "x")).toBe("no-session");
  });

  it("准备段回报：会话改名成 worktree 目录名，任务和 job 目录跟着换", async () => {
    const root = createTask({ title: "改名", kind: "verbal", source: {}, status: "understood", project: "app" });
    const jobId = await openSession(root, root, { kind: "interactive", project: "app", repoDir: R, task: "x" });
    const dir = addTestWorktree(R, "app-feat-rename");
    const s = await worktreeReady(jobId, dir);
    expect(s).toMatchObject({ status: "running", worktree: dir, tmuxName: "app-feat-rename" });
    expect(getTask(root.id)!.source.worktree).toBe(dir);
    expect(getJob(jobId)!.dir).toBe(dir);
  });

  it("转达固定进 claude 所在的首个窗口，不跟着活动窗口走", async () => {
    const root = createTask({ title: "转达", kind: "verbal", source: {}, status: "understood", project: "app" });
    const jobId = await openSession(root, root, { kind: "interactive", project: "app", repoDir: R, task: "x" });
    const s = (await worktreeReady(jobId, addTestWorktree(R, "app-feat-say")))!;
    expect(await sayToSession(root.id, "继续")).toBe("sent");
    const keys = calls.filter((c) => c[4] === "send-keys");
    expect(keys.length).toBe(2);
    for (const k of keys) expect(k[k.indexOf("-t") + 1]).toBe(`=${s.tmuxName}:1`);
  });

  it("claude 窗口被关了（只剩 zsh）：转达不送进 shell", async () => {
    const root = createTask({ title: "关了", kind: "verbal", source: {}, status: "understood", project: "app" });
    const jobId = await openSession(root, root, { kind: "interactive", project: "app", repoDir: R, task: "x" });
    await worktreeReady(jobId, addTestWorktree(R, "app-feat-closed"));
    windowsOut = "1|zsh|1\n";
    calls = [];
    expect(await sayToSession(root.id, "继续")).toBe("no-terminal");
    expect(calls.some((c) => c[4] === "send-keys")).toBe(false);
  });

  it("查窗口失败：转达不发、也不退回活动窗口", async () => {
    const root = createTask({ title: "查失败", kind: "verbal", source: {}, status: "understood", project: "app" });
    const jobId = await openSession(root, root, { kind: "interactive", project: "app", repoDir: R, task: "x" });
    await worktreeReady(jobId, addTestWorktree(R, "app-feat-lookup"));
    windowsOut = new Error("boom");
    calls = [];
    expect(await sayToSession(root.id, "继续")).toBe("no-terminal");
    expect(calls.some((c) => c[4] === "send-keys")).toBe(false);
  });

  it("接回：会话没有 worktree（准备段失败过）不在主仓起 claude；claude 窗口没了也不接", async () => {
    const root = createTask({ title: "无树", kind: "verbal", source: {}, status: "understood", project: "app" });
    const jobId = await openSession(root, root, { kind: "interactive", project: "app", repoDir: R, task: "x" });
    updateTermSession(root.id, { status: "exited" });
    calls = [];
    expect(await resumeInSession(root.id)).toBe(false);
    expect(calls.some((c) => c[4] === "send-keys")).toBe(false);
    prepareFailed(jobId);
    const other = createTask({ title: "窗口没了", kind: "verbal", source: {}, status: "understood", project: "app" });
    const j2 = await openSession(other, other, { kind: "interactive", project: "app", repoDir: R, task: "x" });
    await worktreeReady(j2, addTestWorktree(R, "app-feat-nowin"));
    windowsOut = "1|zsh|1\n";
    calls = [];
    expect(await resumeInSession(other.id)).toBe(false);
    expect(calls.some((c) => c[4] === "send-keys")).toBe(false);
  });

  it("准备段失败：任务 blocked，会话 exited 但 tmux 会话留着", async () => {
    const root = createTask({ title: "失败", kind: "verbal", source: {}, status: "understood", project: "app" });
    const jobId = await openSession(root, root, { kind: "interactive", project: "app", repoDir: R, task: "x" });
    const t = prepareFailed(jobId)!;
    expect(t.status).toBe("blocked");
    expect(getTermSession(root.id)!.status).toBe("exited");
    expect(calls.some((c) => c[4] === "kill-session")).toBe(false);
  });
});

describe("worktree / 分支不许被两个会话共用", () => {
  const open = async (title: string) => {
    const root = createTask({ title, kind: "verbal", source: {}, status: "understood", project: "app" });
    const jobId = await openSession(root, root, { kind: "interactive", project: "app", repoDir: R, task: "x" });
    return { root, jobId };
  };

  it("同一路径被第二个根占用：第二个被拒并 blocked，第一个不受影响", async () => {
    const a = await open("甲");
    const b = await open("乙");
    const dir = addTestWorktree(R, "app-feat-shared");
    expect(await worktreeReady(a.jobId, dir)).toBeTruthy();
    expect(await worktreeReady(b.jobId, dir)).toBeUndefined();
    expect(getTermSession(a.root.id)).toMatchObject({ status: "running", worktree: dir });
    expect(getTermSession(b.root.id)).toMatchObject({ status: "exited" });
    expect(getTermSession(b.root.id)!.worktree).toBeUndefined();
    expect(getTask(b.root.id)).toMatchObject({ status: "blocked" });
    expect(getTask(b.root.id)!.progress).toContain("复用了别的任务");
    expect(calls.some((c) => c[4] === "kill-session")).toBe(false);
  });

  it("同一分支不同路径同样被拒", async () => {
    const a = await open("丙");
    const b = await open("丁");
    expect(await worktreeReady(a.jobId, addTestWorktree(R, "app-one", "chore/task"))).toBeTruthy();
    expect(await worktreeReady(b.jobId, addTestWorktree(R, "app-two", "chore/task"))).toBeUndefined();
    expect(getTask(b.root.id)!.status).toBe("blocked");
  });

  it("两个仓库里各有一个根用同名分支：都接受", async () => {
    const a = await open("庚");
    const root = createTask({ title: "辛", kind: "verbal", source: {}, status: "understood", project: "web" });
    const bJob = await openSession(root, root, { kind: "interactive", project: "web", repoDir: W, task: "x" });
    expect(await worktreeReady(a.jobId, addTestWorktree(R, "app-deps", "chore/deps"))).toBeTruthy();
    expect(await worktreeReady(bJob, addTestWorktree(W, "web-deps", "chore/deps"))).toMatchObject({ status: "running" });
    expect(getTask(root.id)!.status).not.toBe("blocked");
  });

  it("第一个会话 closed 之后，别的根可以用同一路径", async () => {
    const a = await open("戊");
    const b = await open("己");
    const dir = addTestWorktree(R, "app-feat-reuse");
    await worktreeReady(a.jobId, dir);
    updateTermSession(a.root.id, { status: "closed" });
    expect(await worktreeReady(b.jobId, dir)).toMatchObject({ status: "running", worktree: dir });
  });
});

describe("一个根任务只有一个会话", () => {
  it("同一个根连点两次开始做：只有一个 job 和一个会话，第二次把话送进去", async () => {
    const t = createTask({ title: "重复开工", kind: "verbal", source: {}, status: "understood", project: "app" });
    const first = await startInteractiveJob(t, "app", R, "第一次");
    await worktreeReady(first.source.jobId!, addTestWorktree(R, "app-feat-dup"));
    const jobs = listJobs(1000).length;
    await startInteractiveJob(getTask(t.id)!, "app", R, "第二次的话");
    expect(listJobs(1000).length).toBe(jobs);
    expect(getTermSession(t.id)!.jobId).toBe(first.source.jobId);
    expect(sent().at(-1)).toBe("第二次的话");
    expect(getTask(t.id)!.status).toBe("processing");
  });

  it("会话已 exited：再开始做是接回（zsh 跑 resume 脚本），不新开会话", async () => {
    const t = createTask({ title: "退出后再来", kind: "verbal", source: {}, status: "understood", project: "app" });
    const first = await startInteractiveJob(t, "app", R, "第一次");
    const jobId = first.source.jobId!;
    await worktreeReady(jobId, addTestWorktree(R, "app-feat-resume"));
    updateTermSession(t.id, { status: "exited" });
    const jobs = listJobs(1000).length;
    await startInteractiveJob(getTask(t.id)!, "app", R, "接着做");
    expect(listJobs(1000).length).toBe(jobs);
    expect(sent().some((x) => x!.includes("/bin/zsh") && x!.includes(`/runs/${jobId}.resume.sh`))).toBe(true);
    expect(getTermSession(t.id)!.status).toBe("running");
  });
});

describe("准备段失败 / 被拒收之后还能再开工", () => {
  it("prepareFailed 之后再开始做：同名的旧 tmux 会话先 kill，再开出新会话", async () => {
    const t = createTask({ title: "失败后重来", kind: "verbal", source: {}, status: "understood", project: "app" });
    const first = await startInteractiveJob(t, "app", R, "第一次");
    const name = getTermSession(t.id)!.tmuxName;
    prepareFailed(first.source.jobId!);
    calls = [];
    const again = await startInteractiveJob(getTask(t.id)!, "app", R, "再来");
    expect(calls.some((c) => c[4] === "kill-session" && c.includes(`=${name}`))).toBe(true);
    expect(again.source.jobId).not.toBe(first.source.jobId);
    expect(getTermSession(t.id)).toMatchObject({ status: "preparing", tmuxName: name, jobId: again.source.jobId });
    expect(alive.has(name)).toBe(true);
  });

  it("同名 tmux 会话属于别的根：不杀，名字加 4 位后缀", async () => {
    const a = createTask({ title: "甲根", kind: "verbal", source: {}, status: "understood", project: "app" });
    const b = createTask({ title: "乙根", kind: "verbal", source: {}, status: "understood", project: "app" });
    const taken = `app-${a.id.slice(0, 8)}`;
    await openSession(b, b, { kind: "interactive", project: "app", repoDir: R, task: "x" });
    alive.delete(getTermSession(b.id)!.tmuxName);
    updateTermSession(b.id, { tmuxName: taken });
    alive.add(taken);
    calls = [];
    await openSession(a, a, { kind: "interactive", project: "app", repoDir: R, task: "x" });
    expect(calls.some((c) => c[4] === "kill-session")).toBe(false);
    expect(getTermSession(a.id)!.tmuxName).toMatch(new RegExp(`^${taken}-[0-9a-f]{4}$`));
    expect(getTermSession(b.id)!.tmuxName).toBe(taken);
  });
});

describe("根任务已收工：缺陷不跟进去", () => {
  it("rootId 指向的需求已完成：缺陷自己当根，rootId 留着不改", () => {
    const story = createTask({ title: "收工的需求", kind: "meegle", source: { meegleId: "S9" }, status: "understood" });
    const bug = createTask({ title: "后来的缺陷", kind: "meegle", source: { meegleId: "B9", linkedStoryId: "S9", rootId: story.id }, status: "understood" });
    updateTask(story.id, { status: "done" });
    expect(resolveRoot(getTask(bug.id)!).id).toBe(bug.id);
    expect(getTask(bug.id)!.source.rootId).toBe(story.id);
  });

  it("按 linkedStoryId 找到的需求已忽略：不写 rootId", () => {
    const story = createTask({ title: "忽略的需求", kind: "meegle", source: { meegleId: "S10" }, status: "understood" });
    updateTask(story.id, { status: "ignored" });
    const bug = createTask({ title: "缺陷", kind: "meegle", source: { meegleId: "B10", linkedStoryId: "S10" }, status: "understood" });
    expect(resolveRoot(bug).id).toBe(bug.id);
    expect(getTask(bug.id)!.source.rootId).toBeUndefined();
  });
});

describe("旧任务已有分支：准备段为它建 worktree，不新建分支", () => {
  it("根任务 source.branch 不是主干：启动器拿到 existingBranch；主干或没有时不带", async () => {
    let got: { existingBranch?: string } = {};
    setLauncher(async (req, name) => { got = req; alive.add(name); });
    const old = createTask({ title: "进行中的旧任务", kind: "verbal", source: { branch: "feat/export" }, status: "processing", project: "app" });
    await openSession(old, old, { kind: "interactive", project: "app", repoDir: R, task: "x" });
    expect(got.existingBranch).toBe("feat/export");
    const onMain = createTask({ title: "主干上的", kind: "verbal", source: { branch: "main" }, status: "processing", project: "app" });
    await openSession(onMain, onMain, { kind: "interactive", project: "app", repoDir: R, task: "x" });
    expect(got.existingBranch).toBeUndefined();
  });
});

describe("准备段回报的路径必须是这个仓库的另一个 worktree，不能是主仓", () => {
  const open = async (title: string, repoDir: string) => {
    const root = createTask({ title, kind: "verbal", source: {}, status: "understood", project: "app" });
    const jobId = await openSession(root, root, { kind: "interactive", project: "app", repoDir, task: "x" });
    return { root, jobId };
  };
  const refused = (id: string) => {
    expect(getTermSession(id)).toMatchObject({ status: "exited" });
    expect(getTermSession(id)!.worktree).toBeUndefined();
    expect(getTask(id)!.status).toBe("blocked");
    expect(listAudit({ taskId: id }).some((e) => e.action === "claude_code_blocked")).toBe(true);
  };

  it("主仓路径（原样 / 带尾斜杠 / realpath 的 /private 前缀 / 主仓里的子目录）一律拒收", async () => {
    const main = mainRepo("mainchk");
    mkdirSync(join(main, "pkg"));
    const variants = [main, `${main}/`, realpathSync(main), join(main, "pkg")];
    expect(variants[2]).not.toBe(main);
    for (const v of variants) {
      const { root, jobId } = await open(`主仓 ${v}`, main);
      expect(await worktreeReady(jobId, v)).toBeUndefined();
      refused(root.id);
      expect(getTask(root.id)!.progress).toContain("准备段把主仓当成了 worktree，没开工");
    }
  });

  it("会话的 repoDir 是 realpath、回报的是 /var 形式的主仓：同样拒收", async () => {
    const main = mainRepo("mainchk2");
    const { root, jobId } = await open("反过来", realpathSync(main));
    expect(await worktreeReady(jobId, main)).toBeUndefined();
    refused(root.id);
  });

  it("不是这个仓库的 worktree（独立仓库 / 不存在的路径）：拒收", async () => {
    const main = mainRepo("mainchk3");
    for (const p of [repo("other-repo"), join(main, "..", "nope")]) {
      const { root, jobId } = await open(`不是 worktree ${p}`, main);
      expect(await worktreeReady(jobId, p)).toBeUndefined();
      refused(root.id);
      expect(getTask(root.id)!.progress).toContain("不是这个仓库的 git worktree");
    }
  });

  it("真实的 worktree：接受", async () => {
    const main = mainRepo("mainchk4");
    const wt = addTestWorktree(main, "mainchk4-feat-ok", "feat/ok");
    const { root, jobId } = await open("正常", main);
    expect(await worktreeReady(jobId, wt)).toMatchObject({ status: "running", worktree: wt, branch: "feat/ok" });
    expect(getTask(root.id)!.status).not.toBe("blocked");
  });
});
