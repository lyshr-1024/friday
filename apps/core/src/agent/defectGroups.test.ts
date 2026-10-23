import { beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { setClaudeFinder } from "./runner.js";
import { setTmuxRunner } from "./tmux.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Task, TermSession } from "@friday/shared";
import { briefRefusal } from "@friday/shared";
import { createTask, getTask, listTasks, updateTask } from "../memory/tasks.js";
import { getCursor, setCursor } from "../memory/inbox.js";
import { updateSettings } from "../settings.js";
import { autostartPlan, codeEligible, defectBatchTick, defectRoute, ensureFixCards, pickBatchGroups, pickDefectGroups, tidyStoryDefects, type StoryEnv } from "./autostart.js";
import { createFixCard, fixCardDetail } from "./pipeline.js";


const at = "2026-10-20T00:00:00.000Z";
const story = (over: Partial<Task> = {}): Task => ({ id: "s1", title: "清结算需求", kind: "meegle", status: "review", priority: "normal", createdAt: at, updatedAt: at, source: { meegleType: "story", meegleId: "100", storyContainer: true }, ...over }) as Task;
const bug = (id: string, over: Partial<Task> = {}, source: Task["source"] = {}): Task =>
  ({ id, title: `缺陷 ${id}`, kind: "meegle", status: "understood", priority: "normal", project: "whale-console", createdAt: at, updatedAt: at, ...over, source: { meegleType: "issue", linkedStoryId: "100", ...source } }) as Task;
const sess = (over: Partial<TermSession> = {}): TermSession => ({ id: "s1", project: "x", repoDir: "/r", tmuxName: "x", kind: "autonomous", status: "running", worktree: "/r-wt", createdAt: at, updatedAt: at, ...over }) as TermSession;
const env = (o: Partial<StoryEnv> = {}): StoryEnv => ({ story: () => story(), fixCard: () => undefined, session: () => undefined, occupied: () => false, batchAt: "10:00", ...o });

describe("挂在需求下的缺陷不单独建卡、不单独开工", () => {
  it("建卡拒绝：挂了需求的缺陷、修复卡；没挂需求的缺陷照旧能建", () => {
    expect(briefRefusal(bug("b1"))).toBe("缺陷跟所属需求一起修，不单独建理解卡");
    expect(briefRefusal(bug("b2", {}, { linkedStoryId: undefined, rootId: "s1" }))).toBe("缺陷跟所属需求一起修，不单独建理解卡");
    expect(briefRefusal({ ...bug("c"), kind: "code", source: { fixFor: "s1" } } as Task)).toBe("修复卡不建理解卡，到点整组修");
    expect(briefRefusal(bug("b3", {}, { linkedStoryId: undefined }))).toBeUndefined();
  });

  it("通用门禁拒绝：跟所属需求一起修", () => {
    expect(codeEligible(bug("b1"), () => story())).toBe("跟所属需求一起修，不单独开工");
  });
});

describe("defectRoute：往哪个会话交、还是等定点", () => {
  it("需求有会话：交进需求；前一组没修完：等", () => {
    expect(defectRoute(bug("b1"), env({ session: (id) => (id === "s1" ? sess() : undefined) }))).toMatchObject({ kind: "hand", unit: { id: "s1" } });
    expect(defectRoute(bug("b1"), env({ session: () => sess(), occupied: () => true }))).toMatchObject({ kind: "wait", why: "等前一组修完", batch: false });
  });

  it("需求不在任何阶段都交：不再只认测试中", () => {
    expect(defectRoute(bug("b1"), env({ story: () => story({ stage: "dev" }), session: () => sess() }))).toMatchObject({ kind: "hand" });
  });

  it("需求收工了 / 没会话：等每天定点开修复卡；已有修复卡且有会话就交进修复卡", () => {
    expect(defectRoute(bug("b1"), env({ story: () => story({ status: "done" }), session: () => sess() }))).toMatchObject({ kind: "wait", batch: true, why: "每天 10:00 跟同需求的缺陷一起修" });
    const card = { ...story(), id: "card", title: "清结算需求 · 修复", kind: "code", source: { fixFor: "s1" } } as Task;
    expect(defectRoute(bug("b1"), env({ story: () => story({ status: "done" }), fixCard: () => card, session: (id) => (id === "card" ? sess({ id: "card" }) : undefined) }))).toMatchObject({ kind: "hand", unit: { id: "card" } });
    expect(defectRoute(bug("b1"), env({ fixCard: () => card }))).toMatchObject({ kind: "wait", batch: true, unit: { id: "card" } });
  });

  it("已经在测试中 / 开过工 / 先别做的不排", () => {
    expect(defectRoute(bug("b1", { stage: "testing" }), env())).toBe("已经在测试中");
    expect(defectRoute(bug("b1", {}, { handedAt: at }), env())).toBe("已经开过工");
    expect(defectRoute(bug("b1", {}, { autostartOff: true }), env())).toBe("你说了先别做");
  });

  it("分组：同一个会话的一组交，同一个需求的一组等定点", () => {
    const hand = pickDefectGroups([bug("a"), bug("b")], env({ session: () => sess() }));
    expect(hand.map((g) => [g.unit.id, g.defects.map((d) => d.id)])).toEqual([["s1", ["a", "b"]]]);
    const batch = pickBatchGroups([bug("a"), bug("b")], env());
    expect(batch.map((g) => [g.story.id, g.card?.id, g.defects.map((d) => d.id)])).toEqual([["s1", undefined, ["a", "b"]]]);
  });

  it("卡片预告：交进会话的写跟着谁修，等定点的写几点", () => {
    const e = { now: Date.parse(at), running: 0, max: 3, enabled: true, root: () => story() };
    expect(autostartPlan(bug("b1"), e, env())).toMatchObject({ kind: "story", root: { id: "s1" }, waiting: "每天 10:00 跟同需求的缺陷一起修" });
  });
});

describe("修复卡", () => {
  it("建卡：标题「需求 · 修复」、项目跟缺陷、优先级取组里最高", () => {
    const s = createTask({ title: "BO 集成测试任务", kind: "meegle", status: "done", source: { meegleType: "story", meegleId: "127" } });
    const card = createFixCard(s, [bug("x", { priority: "low" }), bug("y", { priority: "high" })]);
    expect(card.title).toBe("BO 集成测试任务 · 修复");
    expect(card.project).toBe("whale-console");
    expect(card.priority).toBe("high");
    expect(card.source.fixFor).toBe(s.id);
  });

  it("交代说明：一条分支一起修、每条带 taskId 交付、最后交总报告", () => {
    const s = createTask({ title: "养牛活动", kind: "meegle", status: "done", source: { meegleType: "story" } });
    const card = createFixCard(s, [bug("aaaaaaaa-1")]);
    const d = fixCardDetail(card, [bug("aaaaaaaa-1"), bug("bbbbbbbb-2")]);
    expect(d).toContain("在同一条分支上一起修");
    expect(d).toContain("taskId aaaaaaaa");
    expect(d).toContain(`taskId 填 ${card.id.slice(0, 8)}`);
  });
});

describe("修复卡先建好攒着", () => {
  it("需求没有会话的缺陷一进来就挂到修复卡上，不开工；同一需求后来的缺陷挂同一张", () => {
    const s = createTask({ title: "先建卡需求", kind: "meegle", status: "done", source: { meegleType: "story", meegleId: "5501" } });
    const a = createTask({ title: "先建卡缺陷 A", kind: "meegle", status: "understood", project: "whale-console", source: { meegleType: "issue", linkedStoryId: "5501" } });
    ensureFixCards();
    const card = listTasks(["understood"]).find((x) => x.source.fixFor === s.id)!;
    expect(card.title).toBe("先建卡需求 · 修复");
    expect(getTask(a.id)!.source.rootId).toBe(card.id);
    expect(getTask(a.id)!.status).toBe("understood");
    expect(getTask(a.id)!.source.handedAt).toBeUndefined();
    const b = createTask({ title: "先建卡缺陷 B", kind: "meegle", status: "understood", project: "whale-console", source: { meegleType: "issue", linkedStoryId: "5501" } });
    ensureFixCards();
    expect(listTasks([...["understood", "processing"] as const]).filter((x) => x.source.fixFor === s.id)).toHaveLength(1);
    expect(getTask(b.id)!.source.rootId).toBe(card.id);
  });
});

describe("每天定点", () => {
  beforeEach(() => {
    updateSettings({ autonomous: true, defectBatchAt: "10:00" });
    setCursor("defects:batch:day", "");
  });

  it("没到点不跑；到点跑一次，同一天不再跑", async () => {
    const before = Date.parse("2026-10-23T01:59:00Z"); // 上海 09:59
    expect(await defectBatchTick(before)).toBe(0);
    expect(getCursor("defects:batch:day")).toBe("");
    await defectBatchTick(Date.parse("2026-10-23T02:01:00Z"));
    expect(getCursor("defects:batch:day")).toBe("2026-10-23");
  });

  it("到点：需求收工了的缺陷开一张修复卡、记成交给修复卡", async () => {
    const repo = mkdtempSync(join(tmpdir(), "friday-fix-"));
    execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
    writeFileSync(join(process.env.FRIDAY_DATA_DIR!, "projects.md"), `# 项目\n\n## whale-console\n- 目录：${repo}\n`);
    setClaudeFinder(async () => "/bin/claude");
    setTmuxRunner(async (args) => (args[0] === "-V" ? "tmux 3.5a" : args.includes("has-session") ? Promise.reject(new Error("no")) : ""));
    const s = createTask({ title: "批量需求", kind: "meegle", status: "done", source: { meegleType: "story", meegleId: "9901" } });
    const a = createTask({ title: "批量缺陷 A", kind: "meegle", status: "understood", project: "whale-console", source: { meegleType: "issue", linkedStoryId: "9901" } });
    const b = createTask({ title: "批量缺陷 B", kind: "meegle", status: "understood", project: "whale-console", source: { meegleType: "issue", linkedStoryId: "9901" } });
    await defectBatchTick(Date.parse("2026-10-24T02:30:00Z"));
    const card = listTasks(["processing", "understood"]).find((x) => x.source.fixFor === s.id)!;
    expect(card.status).toBe("processing");
    expect(card.source.jobId).toBeTruthy();
    for (const d of [a, b]) {
      const t = getTask(d.id)!;
      expect(t.status).toBe("processing");
      expect(t.source.rootId).toBe(card.id);
      expect(t.source.handedAt).toBeTruthy();
    }
  });
});

describe("启动时清掉老版本挂在缺陷上的动作", () => {
  it("挂了需求的缺陷：撤掉合并和方案审批，别的待审动作留着；没挂需求的不动", () => {
    const s = createTask({ title: "清理需求", kind: "meegle", status: "review", source: { meegleType: "story", meegleId: "7788" } });
    const pend = (type: string) => ({ id: type, at, type, label: type, detail: "", payload: {} }) as unknown as NonNullable<Task["pending"]>[number];
    const a = createTask({ title: "挂了需求", kind: "meegle", status: "review", source: { meegleType: "issue", rootId: s.id } });
    const b = createTask({ title: "没挂需求", kind: "meegle", status: "review", source: { meegleType: "issue" } });
    for (const t of [a, b]) updateTask(t.id, { pending: [pend("git_merge"), pend("brief_approve"), pend("slack_reply")] });
    tidyStoryDefects();
    expect(getTask(a.id)!.pending!.map((p) => p.type)).toEqual(["slack_reply"]);
    expect(getTask(b.id)!.pending!.map((p) => p.type)).toEqual(["git_merge", "brief_approve", "slack_reply"]);
  });
});
