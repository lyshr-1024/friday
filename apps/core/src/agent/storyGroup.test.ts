import { beforeEach, describe, expect, it } from "vitest";
import { alreadyAsking, containerDone, myRoles } from "./meegle.js";
import { updateTaskFromChat } from "./taskUpdate.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { joinRootSession, openSession, resolveRoot, setLauncher, worktreeReady } from "./sessions.js";
import { setTmuxRunner } from "./tmux.js";
import { listJobs } from "../memory/jobs.js";
import { updateTermSession } from "../memory/termSessions.js";
import { createTask, getTask, updateTask } from "../memory/tasks.js";
import { initMemory } from "../memory/db.js";

let sentTexts: string[] = [];
let alive = new Set<string>();
beforeEach(() => {
  sentTexts = [];
  setTmuxRunner(async (args) => {
    if (args[0] === "-V") return "tmux 3.5a";
    const sub = args[4];
    const target = (args[args.indexOf("-t") + 1] ?? "").replace(/^=/, "").replace(/:.*$/, "");
    if (sub === "has-session" && !alive.has(target)) throw new Error("can't find session");
    if (sub === "rename-session") { alive.delete(target); alive.add(args.at(-1)!); }
    if (sub === "send-keys" && args.includes("-l")) sentTexts.push(args.at(-1)!);
    return "";
  });
  setLauncher(async (_req, name) => { alive.add(name); });
});

describe("需求里我担哪些角色", () => {
  const roles = [
    { role: "QA", memberKeys: ["k-qa"] },
    { role: "Admin Frontend", memberKeys: ["k-me"] },
    { role: "Server developer", memberKeys: ["k-be", "k-me"] },
  ];

  it("按 user_key 精确匹配，不靠名字", async () => {
    expect(myRoles(roles, "k-me")).toEqual(["Admin Frontend", "Server developer"]);
    expect(myRoles(roles, "k-qa")).toEqual(["QA"]);
    expect(myRoles(roles, "k-nobody")).toEqual([]);
    expect(myRoles([], "k-me")).toEqual([]);
  });
});

describe("同需求共用一个会话", () => {
  it("需求有活着的会话时，缺陷转达给它而不是另起一个", async () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const story = createTask({ title: "猜涨跌兜底开奖", kind: "meegle", source: { meegleId: "S1", meegleType: "story" }, status: "processing", project: "p" });
    const jobId = await openSession(story, story, { kind: "interactive", project: "p", repoDir: "/d", task: "x" });
    await worktreeReady(jobId, "/d-feat-guess");
    const jobsBefore = listJobs(1000).length;

    const bug = createTask({ title: "开关没有二次确认", kind: "meegle", source: { meegleId: "B1", linkedStoryId: "S1" }, status: "understood" });
    expect(await joinRootSession(bug, resolveRoot(bug), "把开关加上二次确认")).toBe("joined");
    const after = getTask(bug.id)!;
    expect(after.source.rootId).toBe(story.id);
    expect(after.status).toBe("processing");
    expect(after.progress).toContain("会话里改");
    expect(sentTexts.at(-1)).toContain("把开关加上二次确认");
    expect(listJobs(1000).length).toBe(jobsBefore);
  });

  it("会话已经关闭就不转达，让它自己开", async () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const story = createTask({ title: "需求", kind: "meegle", source: { meegleId: "S2", meegleType: "story" }, status: "review", project: "p" });
    await openSession(story, story, { kind: "interactive", project: "p", repoDir: "/d", task: "x" });
    updateTermSession(story.id, { status: "closed" });
    const bug = createTask({ title: "缺陷", kind: "meegle", source: { meegleId: "B2", linkedStoryId: "S2" }, status: "understood" });
    expect(await joinRootSession(bug, resolveRoot(bug), "改点东西")).toBe("no-session");
  });

  it("没有关联需求、或需求还没开会话，都不转达", async () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const lone = createTask({ title: "独立缺陷", kind: "meegle", source: { meegleId: "B3" }, status: "understood" });
    expect(await joinRootSession(lone, resolveRoot(lone), "x")).toBe("no-session");
    createTask({ title: "还没开工的需求", kind: "meegle", source: { meegleId: "S4", meegleType: "story" }, status: "understood" });
    const bug = createTask({ title: "缺陷", kind: "meegle", source: { meegleId: "B4", linkedStoryId: "S4" }, status: "understood" });
    expect(await joinRootSession(bug, resolveRoot(bug), "x")).toBe("no-session");
  });
});

describe("需求容器的收尾判据", () => {
  const t = (status: string) => ({ status }) as never;

  it("名下还有没完的就不收", async () => {
    expect(containerDone([t("understood"), t("done")])).toBe(false);
    expect(containerDone([t("processing")])).toBe(false);
  });

  it("全部 done 或 ignored 才收", async () => {
    expect(containerDone([t("done"), t("ignored")])).toBe(true);
    expect(containerDone([t("done")])).toBe(true);
  });

  it("一条缺陷都没有时不收——刚建出来还没挂上就被收掉了", async () => {
    expect(containerDone([])).toBe(false);
  });
});

describe("同需求只问一次归属", () => {
  it("已经有一条在问，同需求的其他条不再重复问", async () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const a = createTask({ title: "缺陷 A", kind: "meegle", status: "understood", source: { meegleId: "QA1", linkedStoryId: "ST1" } });
    updateTask(a.id, { attention: "intake", progress: "这条是哪个项目的？" });
    const b = createTask({ title: "缺陷 B", kind: "meegle", status: "understood", source: { meegleId: "QA2", linkedStoryId: "ST1" } });
    expect(alreadyAsking(b)?.id).toBe(a.id);
  });

  it("没挂在需求下的各问各的", async () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const a = createTask({ title: "独立 A", kind: "meegle", status: "understood", source: { meegleId: "QB1" } });
    updateTask(a.id, { attention: "intake", progress: "问一句" });
    const b = createTask({ title: "独立 B", kind: "meegle", status: "understood", source: { meegleId: "QB2" } });
    expect(alreadyAsking(b)).toBeUndefined();
  });

  it("答一条归属，同需求其他条一起归、提问一起清", async () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    writeFileSync(join(process.env.FRIDAY_DATA_DIR!, "projects.md"), "# 项目\n\n## fe-wealth-admin\n- 目录：~/f\n");
    const a = createTask({ title: "【邀请达标不发奖】缺陷 A", kind: "meegle", status: "understood", source: { meegleId: "QC1", linkedStoryId: "ST2" } });
    const b = createTask({ title: "【邀请达标不发奖】缺陷 B", kind: "meegle", status: "understood", source: { meegleId: "QC2", linkedStoryId: "ST2" } });
    const c = createTask({ title: "【邀请达标不发奖】缺陷 C", kind: "meegle", status: "understood", source: { meegleId: "QC3", linkedStoryId: "ST2" } });
    for (const t of [a, b, c]) updateTask(t.id, { attention: "intake", progress: "哪个项目？" });

    const r = updateTaskFromChat(a.id, { project: "fe-wealth-admin" })!;
    expect(r.changed.some((x) => x.includes("同需求另外 2 条"))).toBe(true);
    for (const t of [b, c]) {
      const after = getTask(t.id)!;
      expect(after.project).toBe("fe-wealth-admin");
      expect(after.attention).toBeUndefined();
    }
  });
});
