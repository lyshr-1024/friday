import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createTask, getTask } from "../memory/tasks.js";
import { listAudit } from "../memory/audit.js";
import { runByJob, setRunOutcome } from "../memory/runs.js";
import { config } from "../config.js";
import { setTmuxRunner } from "./tmux.js";
import { setClaudeFinder } from "./runner.js";
import { setLauncher, worktreeReady } from "./sessions.js";
import { executePending, startAutonomousJob } from "./pipeline.js";
import { requestProjectChange } from "./reproject.js";
import { addTestWorktree, mainRepo } from "./testRepos.js";

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
