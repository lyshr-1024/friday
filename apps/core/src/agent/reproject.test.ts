import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTask, getTask, updateTask } from "../memory/tasks.js";
import { listAudit } from "../memory/audit.js";
import { runByJob, setRunOutcome } from "../memory/runs.js";
import { config } from "../config.js";
import { setTmuxRunner } from "./tmux.js";
import { setClaudeFinder } from "./runner.js";
import { setLauncher, worktreeReady } from "./sessions.js";
import { executePending, startAutonomousJob } from "./pipeline.js";
import { requestProjectChange } from "./reproject.js";
import { briefBasis } from "./brief.js";
import { syncMeegleOnce } from "./meegle.js";
import * as meegleRules from "../connectors/meegle/rules.js";
import { createTermSession, updateTermSession } from "../memory/termSessions.js";
import { addTestWorktree, mainRepo } from "./testRepos.js";

vi.mock("./pipeline.js", async (orig) => {
  const m = await orig<typeof import("./pipeline.js")>();
  return { ...m, startAutonomousJob: vi.fn(m.startAutonomousJob) };
});

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
    if (sub === "list-windows") return "0|claude|1\n";
    if (sub === "rename-session") { alive.delete(target); alive.add(args.at(-1)!); }
    if (sub === "kill-session") alive.delete(target);
    return "";
  });
  setLauncher(async (_req, name) => { alive.add(name); });
});

const branches = (dir: string) => execFileSync("git", ["-C", dir, "branch", "--format=%(refname:short)"], { encoding: "utf8" }).split("\n").filter(Boolean);
const noSlack = { slackPost: async () => ({ ts: "" }) };

/** Friday 按自己判的项目在 wrongapp 上开了工，worktree 里改了一个文件没提交 */
async function fridayOnWrongProject() {
  const wrong = mainRepo("wrongapp");
  const right = mainRepo("rightapp");
  writeFileSync(join(config.dataDir, "projects.md"), `# 项目\n\n## wrongapp\n- 目录：${wrong}\n\n## rightapp\n- 目录：${right}\n`);
  const t = createTask({
    title: "表格单元格被截断",
    kind: "meegle",
    status: "understood",
    project: "wrongapp",
    source: { meegleType: "issue", projectBy: "friday", intake: { kind: "start", confidence: 72, project: "wrongapp", detail: "单元格加 Tooltip", why: "描述具体", at: new Date().toISOString() } },
  });
  const started = await startAutonomousJob(t, "wrongapp", wrong, "单元格加 Tooltip", "autostart");
  const jobId = started.source.jobId!;
  const wt = addTestWorktree(wrong, "wrongapp-fix-ellipsis", "fix/ellipsis");
  await worktreeReady(jobId, wt);
  writeFileSync(join(wt, "Table.tsx"), "export {}\n");
  return { t: getTask(t.id)!, jobId, wrong, right, wt };
}

describe("改项目：Friday 自主干过活的先挂回退清单", () => {
  it("不直接改，清单写明要删的 worktree、分支和没提交的文件数，任务状态不动", async () => {
    const { t, wt } = await fridayOnWrongProject();
    const r = requestProjectChange(t.id, "rightapp")!;
    expect(r.kind).toBe("pending");
    const task = getTask(t.id)!;
    expect(task.project).toBe("wrongapp");
    expect(task.status).toBe(t.status);
    const p = task.pending!.find((x) => x.type === "reproject")!;
    expect(p.payload).toEqual({ from: "wrongapp", to: "rightapp" });
    expect(p.detail).toContain(wt);
    expect(p.detail).toContain("fix/ellipsis");
    expect(p.detail).toContain("1 个没提交的文件");
    expect(existsSync(wt)).toBe(true);
  });

  it("改回原来的项目 = 反悔，清单撤掉，什么都不删", async () => {
    const { t, wt } = await fridayOnWrongProject();
    requestProjectChange(t.id, "rightapp");
    expect(requestProjectChange(t.id, "wrongapp")!.kind).toBe("cancelled");
    expect((getTask(t.id)!.pending ?? []).some((x) => x.type === "reproject")).toBe(false);
    expect(existsSync(wt)).toBe(true);
  });

  it("说「撤掉」：删 worktree 和分支、关会话、运行记成打回，然后在对的项目上重开", async () => {
    const { t, jobId, wrong, right, wt } = await fridayOnWrongProject();
    requestProjectChange(t.id, "rightapp");
    const action = getTask(t.id)!.pending!.find((x) => x.type === "reproject")!;
    const after = await executePending(t.id, action.id, noSlack);

    expect(existsSync(wt)).toBe(false);
    expect(branches(wrong)).not.toContain("fix/ellipsis");
    expect(calls.some((c) => c[4] === "kill-session")).toBe(true);
    expect(runByJob(jobId)).toMatchObject({ outcome: "rejected", outcomeWhy: "项目判错：wrongapp → rightapp" });

    expect(after.project).toBe("rightapp");
    expect(after.source.projectBy).toBe("user");
    expect(after.source.autonomous).toBe(true);
    expect(after.source.jobId).not.toBe(jobId);
    expect(after.source.repoDir).toBe(right);
    expect(after.source.worktree).toBeUndefined();
    expect(after.report).toBeUndefined();
    expect((after.pending ?? []).some((x) => x.type === "reproject" || x.type === "git_merge")).toBe(false);
    expect(listAudit({ taskId: t.id }).some((e) => e.action === "reproject_rollback" && e.risk === "irreversible")).toBe(true);
  });

  it("撤掉重开时，带审过的理解卡（项目是新项目）就用理解卡正文交代", async () => {
    const { t } = await fridayOnWrongProject();
    const card = { todo: "单元格超长时加 Tooltip 显示全文", deps: [], acceptance: { source: "own" as const, cases: ["超长单元格悬停出全文"] }, release: "走 canary", plan: "改 Table.tsx", size: "small" as const, sizeWhy: "一个文件", review: "approved" as const, basis: briefBasis(t), project: "rightapp", at: new Date().toISOString(), features: [] };
    updateTask(t.id, { source: { brief: card } });
    requestProjectChange(t.id, "rightapp");
    const action = getTask(t.id)!.pending!.find((x) => x.type === "reproject")!;
    await executePending(t.id, action.id, noSlack);
    expect(String(vi.mocked(startAutonomousJob).mock.lastCall![3])).toContain("单元格超长时加 Tooltip 显示全文");
  });

  it("已经合进主干的不回退，告诉你要自己 revert", async () => {
    const { t, jobId } = await fridayOnWrongProject();
    setRunOutcome(runByJob(jobId)!.id, "merged_as_is");
    const r = requestProjectChange(t.id, "rightapp")!;
    expect(r.kind).toBe("refused");
    expect(r.kind === "refused" && r.why).toMatch(/revert/);
    expect((getTask(t.id)!.pending ?? []).some((x) => x.type === "reproject")).toBe(false);
  });
});

describe("改项目：不是 Friday 自主干的活", () => {
  it("还没开工的直接改，记成你定的", () => {
    const t = createTask({ title: "排队中", kind: "meegle", status: "understood", project: "wrongapp", source: { meegleType: "issue", projectBy: "friday" } });
    const r = requestProjectChange(t.id, "rightapp")!;
    expect(r.kind).toBe("set");
    expect(getTask(t.id)).toMatchObject({ project: "rightapp", source: { projectBy: "user" } });
  });

  it("卡片上选了项目也要把 Friday 的提问收掉，不然会话还以为它没得到答复", () => {
    const t = createTask({ title: "蚂蚁抽奖活动 AC 与 Appid 不匹配", kind: "meegle", status: "understood", source: { meegleId: "24660264" } });
    updateTask(t.id, { attention: "intake", progress: "这条工单是哪个项目的（whale-console 还是 fe-wealth-admin）？" });
    expect(requestProjectChange(t.id, "fe-wealth-admin")!.kind).toBe("set");
    expect(getTask(t.id)).toMatchObject({ project: "fe-wealth-admin", progress: "项目定为 fe-wealth-admin" });
    expect(getTask(t.id)!.attention).toBeUndefined();
  });

  it("你自己的交互式任务直接改，不挂回退清单", () => {
    const t = createTask({ title: "我在做", kind: "code", status: "processing", project: "wrongapp", source: { jobId: "j-mine" } });
    expect(requestProjectChange(t.id, "rightapp")!.kind).toBe("set");
    expect(getTask(t.id)!.pending ?? []).toEqual([]);
  });
});

describe("需求定项目，缺陷跟着走", () => {
  const story = (meegleId: string, project?: string) =>
    createTask({ title: `需求 ${meegleId}`, kind: "meegle", status: "understood", ...(project ? { project } : {}), source: { meegleId, storyContainer: true } });
  const defect = (storyId: string, extra: Partial<Parameters<typeof createTask>[0]> = {}) =>
    createTask({ title: `缺陷 of ${storyId}`, kind: "meegle", status: "understood", ...extra, source: { meegleId: `d-${Math.random()}`, linkedStoryId: storyId, ...(extra.source ?? {}) } });

  it("没项目的缺陷、跟着旧项目走的缺陷都改；你单独指定过的不动", () => {
    const s = story("st-1", "old-app");
    const empty = defect("st-1");
    const followed = defect("st-1", { project: "old-app" });
    const mine = defect("st-1", { project: "other-app", source: { projectBy: "user" } });
    const elsewhere = defect("st-x");
    requestProjectChange(s.id, "fe-wealth-admin");
    expect(getTask(empty.id)!.project).toBe("fe-wealth-admin");
    expect(getTask(followed.id)!.project).toBe("fe-wealth-admin");
    expect(getTask(mine.id)!.project).toBe("other-app");
    expect(getTask(elsewhere.id)!.project).toBeUndefined();
    expect(listAudit({ taskId: empty.id }).some((e) => e.action === "project_inherited")).toBe(true);
  });

  it("需求第一次定项目（原来没有），缺陷补上", () => {
    const s = story("st-2");
    const d = defect("st-2");
    requestProjectChange(s.id, "fe-wealth-admin");
    expect(getTask(d.id)!.project).toBe("fe-wealth-admin");
  });
});

describe("Meegle 里缺陷关了，手上的改动等你定撤不撤", () => {
  const sh = (dir: string, ...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" }, stdio: "ignore" });
  const closedConn = (live: Array<Record<string, unknown>> = []) =>
    ({ ...meegleRules, listMine: async () => live.map((x) => ({ ...x, kind: meegleRules.kindOf(String(x.typeKey)), state: meegleRules.stateOf(String(x.statusKey ?? ""), String(x.status)) })), get: async () => ({ name: "缺陷", stateKey: "CLOSED", stateLabel: "Closed", state: "done" }), released: async () => false }) as never;
  let n = 0;
  /** 缺陷自己当根、在自己的 worktree 里干过活 */
  function defectWithWork(o: { commit?: boolean; dirty?: boolean; status?: "blocked" | "processing" } = {}) {
    const id = `cd-${n++}`;
    const repo = mainRepo(`app-${id}`);
    const wt = addTestWorktree(repo, `app-${id}-fix`, `fix/${id}`);
    if (o.commit) sh(wt, "commit", "-q", "--allow-empty", "-m", "fix");
    if (o.dirty) writeFileSync(join(wt, "a.ts"), "x");
    const t = createTask({
      title: `缺陷 ${id}`,
      kind: "meegle",
      status: o.status ?? "processing",
      source: { meegleId: id, meegleProject: "p1", meegleType: "issue", jobId: `job-${id}`, repoDir: repo, worktree: wt, branch: `fix/${id}` },
    });
    createTermSession({ id: t.id, project: "app", repoDir: repo, tmuxName: `app-${id}`, kind: "interactive", jobId: `job-${id}` });
    updateTermSession(t.id, { status: "exited", worktree: wt, branch: `fix/${id}` });
    return { t, repo, wt, branch: `fix/${id}` };
  }

  it("卡住的缺陷被关了也收工（原来只看待办和待审，blocked 的一直挂着）", async () => {
    const t = createTask({ title: "缺陷 blk", kind: "meegle", status: "blocked", source: { meegleId: "cd-blk", meegleProject: "p1", meegleType: "issue" } });
    await syncMeegleOnce(closedConn());
    expect(getTask(t.id)!.status).toBe("done");
  });

  it("有没进主干的提交：不删，挂「撤掉改动」；下一轮同步不重复挂", async () => {
    const { t, wt } = defectWithWork({ commit: true });
    await syncMeegleOnce(closedConn());
    let cur = getTask(t.id)!;
    expect(cur.status).toBe("review");
    expect(cur.pending?.map((p) => p.type)).toEqual(["discard_changes"]);
    expect(cur.pending?.[0]?.detail).toContain("比主干多 1 个提交");
    expect(existsSync(wt)).toBe(true);
    await syncMeegleOnce(closedConn());
    cur = getTask(t.id)!;
    expect(cur.pending).toHaveLength(1);
  });

  it("说撤掉：删 worktree 和分支，收工", async () => {
    const { t, repo, wt, branch } = defectWithWork({ dirty: true });
    await syncMeegleOnce(closedConn());
    const action = getTask(t.id)!.pending![0]!;
    expect(action.detail).toContain("1 个没提交的文件");
    await executePending(t.id, action.id, noSlack);
    expect(existsSync(wt)).toBe(false);
    expect(branches(repo)).not.toContain(branch);
    expect(getTask(t.id)!.status).toBe("done");
    expect(listAudit({ taskId: t.id }).some((e) => e.action === "closed_defect_discarded")).toBe(true);
  });

  it("worktree 里没有改动：直接收工，不打扰你", async () => {
    const { t, wt } = defectWithWork({ status: "blocked" });
    await syncMeegleOnce(closedConn());
    expect(getTask(t.id)!.status).toBe("done");
    expect(getTask(t.id)!.pending ?? []).toEqual([]);
    expect(existsSync(wt)).toBe(true);
  });

  it("挂着等你定的时候又被 Reopen 分派回来：撤回「撤掉改动」，接着改", async () => {
    const { t } = defectWithWork({ commit: true });
    await syncMeegleOnce(closedConn());
    const back = [{ id: t.source.meegleId, name: t.title, typeName: "Defect", typeKey: "issue", links: [], status: "Reopened", projectName: "demo", url: "https://x/r", createdAt: "2026-09-01T00:00:00Z" }];
    expect((await syncMeegleOnce(closedConn(back))).reopened).toBe(1);
    const cur = getTask(t.id)!;
    expect(cur.pending ?? []).toEqual([]);
    expect(cur.source.meegleClosed).toBeUndefined();
    expect(cur.status).toBe("processing");
  });

  it("交代进需求会话的缺陷：source 里记的是需求的 worktree，需求收工了也不能提议删它", async () => {
    const id = `cd-${n++}`;
    const repo = mainRepo(`app-${id}`);
    const wt = addTestWorktree(repo, `app-${id}-story`, `feat/${id}`);
    sh(wt, "commit", "-q", "--allow-empty", "-m", "story work");
    const story = createTask({ title: "需求已收工", kind: "meegle", status: "done", source: { meegleId: `${id}-s`, meegleType: "story", worktree: wt, repoDir: repo, branch: `feat/${id}` } });
    createTermSession({ id: story.id, project: "app", repoDir: repo, tmuxName: `app-${id}-s`, kind: "interactive", jobId: `job-${id}-s` });
    updateTermSession(story.id, { worktree: wt, branch: `feat/${id}` });
    const t = createTask({ title: "交代进去的缺陷", kind: "meegle", status: "processing", source: { meegleId: id, meegleProject: "p1", meegleType: "issue", rootId: story.id, handedAt: "2026-10-20T00:00:00Z", jobId: `job-${id}`, repoDir: repo, worktree: wt, branch: `feat/${id}` } });
    await syncMeegleOnce(closedConn());
    expect(getTask(t.id)!.status).toBe("done");
    expect(getTask(t.id)!.pending ?? []).toEqual([]);
    expect(getTask(t.id)!.progress).toContain("自己 revert");
    expect(existsSync(wt)).toBe(true);
  });

  it("在需求会话里改的：改动拆不出来，收工时写明要你自己 revert", async () => {
    const root = createTask({ title: "养牛1.2", kind: "meegle", status: "processing", source: { meegleId: "cd-story", meegleType: "story" } });
    const t = createTask({ title: "缺陷 in story", kind: "meegle", status: "blocked", source: { meegleId: "cd-in-story", meegleProject: "p1", meegleType: "issue", jobId: "job-in-story", rootId: root.id, linkedStoryId: "cd-story" } });
    await syncMeegleOnce(closedConn());
    const cur = getTask(t.id)!;
    expect(cur.status).toBe("done");
    expect(cur.progress).toContain("自己 revert");
  });
});
