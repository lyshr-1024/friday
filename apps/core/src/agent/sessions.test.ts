import { beforeEach, describe, expect, it } from "vitest";
import { createTask, getTask } from "../memory/tasks.js";
import { getJob, listJobs } from "../memory/jobs.js";
import { getTermSession } from "../memory/termSessions.js";
import { setTmuxRunner } from "./tmux.js";
import { flushQueued, joinRootSession, openSession, prepareFailed, resolveRoot, sayToSession, setLauncher, worktreeReady } from "./sessions.js";
import { startInteractiveJob } from "./pipeline.js";

let calls: string[][] = [];
let tmuxInstalled = true;
let alive = new Set<string>();
beforeEach(() => {
  calls = [];
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
    if (sub === "rename-session") { alive.delete(target); alive.add(args.at(-1)!); }
    return "";
  });
  setLauncher(async (_req, name) => { alive.add(name); });
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
    await expect(startInteractiveJob(t, "app", "/r/app", "做一下")).rejects.toThrow("brew install tmux");
    expect(getTask(t.id)!.status).toBe("understood");
    expect(listJobs(1000).length).toBe(before);
  });

  it("开会话：会话键是根任务 id，job 归 owner，状态 preparing", async () => {
    const root = createTask({ title: "导出中心", kind: "verbal", source: {}, status: "understood", project: "app" });
    const jobId = await openSession(root, root, { kind: "interactive", project: "app", repoDir: "/r/app", task: "做导出" });
    const s = getTermSession(root.id)!;
    expect(s).toMatchObject({ status: "preparing", jobId, tmuxName: `app-${root.id.slice(0, 8)}` });
    expect(getJob(jobId)).toMatchObject({ taskId: root.id, sessionId: root.id });
  });

  it("准备段还没跑完时说的话先排队，SessionStart 到了再送", async () => {
    const root = createTask({ title: "排队", kind: "verbal", source: {}, status: "understood", project: "app" });
    await openSession(root, root, { kind: "interactive", project: "app", repoDir: "/r/app", task: "x" });
    expect(await sayToSession(root.id, "先等等")).toBe("queued");
    expect(sent()).toEqual([]);
    await flushQueued(root.id);
    expect(sent()).toEqual(["先等等"]);
  });

  it("需求的会话在跑：缺陷的活转达进去，不开新会话", async () => {
    const root = createTask({ title: "计费", kind: "meegle", source: { meegleId: "S2" }, status: "processing", project: "app" });
    const jobId = await openSession(root, root, { kind: "interactive", project: "app", repoDir: "/r/app", task: "x" });
    await worktreeReady(jobId, "/r/app-feat-billing");
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
    const jobId = await openSession(root, root, { kind: "interactive", project: "app", repoDir: "/r/app", task: "x" });
    const s = await worktreeReady(jobId, "/r/app-feat-rename");
    expect(s).toMatchObject({ status: "running", worktree: "/r/app-feat-rename", tmuxName: "app-feat-rename" });
    expect(getTask(root.id)!.source.worktree).toBe("/r/app-feat-rename");
    expect(getJob(jobId)!.dir).toBe("/r/app-feat-rename");
  });

  it("准备段失败：任务 blocked，会话 exited 但 tmux 会话留着", async () => {
    const root = createTask({ title: "失败", kind: "verbal", source: {}, status: "understood", project: "app" });
    const jobId = await openSession(root, root, { kind: "interactive", project: "app", repoDir: "/r/app", task: "x" });
    const t = prepareFailed(jobId)!;
    expect(t.status).toBe("blocked");
    expect(getTermSession(root.id)!.status).toBe("exited");
    expect(calls.some((c) => c[4] === "kill-session")).toBe(false);
  });
});
