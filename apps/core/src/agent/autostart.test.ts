import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initMemory } from "../memory/db.js";
import { createTask, getTask, listTasks, updateTask } from "../memory/tasks.js";
import { listAudit } from "../memory/audit.js";
import { updateSettings } from "../settings.js";
import { setTmuxRunner } from "./tmux.js";
import { AUTOSTART_CONFIDENCE, type Brief, type Task, type TermSession } from "@friday/shared";

const AUTOSTART_MIN_CONFIDENCE = AUTOSTART_CONFIDENCE.default;
import { AUTOSTART_SETTLE_MS, autostartPlan, autostartTick, eligible, pickAutostart, pickStoryBugs, runningAutonomous, storyEligible, storyPlan, testingStoryBug, type AutostartEnv, type StoryEnv } from "./autostart.js";
import { createJob, finishJob } from "../memory/jobs.js";
import { createTermSession } from "../memory/termSessions.js";
import { startAutonomousJob } from "./pipeline.js";
import { briefBasis } from "./brief.js";

vi.mock("./pipeline.js", async (orig) => {
  const m = await orig<typeof import("./pipeline.js")>();
  return { ...m, startAutonomousJob: vi.fn(m.startAutonomousJob) };
});

const NOW = Date.parse("2026-09-28T10:00:00Z");
const env: AutostartEnv = { now: NOW, running: 0, max: 1, minConfidence: AUTOSTART_MIN_CONFIDENCE };
const settled = new Date(NOW - AUTOSTART_SETTLE_MS - 1000).toISOString();

const defect = (over: Partial<Task> = {}, source: Task["source"] = {}): Task =>
  ({
    id: "t1",
    title: "【新WBO·股票数据】上市日提交不落库",
    kind: "meegle",
    status: "understood",
    priority: "normal",
    project: "whale-console",
    createdAt: settled,
    updatedAt: settled,
    ...over,
    source: {
      meegleType: "issue",
      intake: { kind: "start", confidence: 90, project: "whale-console", detail: "把 listing_date 按 YYYY-MM-DD HH:mm:ss 传", why: "根因和修法都写了", at: settled },
      ...source,
    },
  }) as Task;

describe("eligible：只放够具体、归属确定、没人碰过的缺陷", () => {
  it("标准缺陷放行", () => {
    expect(eligible(defect(), env)).toBeUndefined();
  });

  it("需求一律不接——要先对方案", () => {
    expect(eligible(defect({}, { meegleType: "story" }), env)).toBe("不是缺陷");
  });

  it("把握不够的不接", () => {
    expect(eligible(defect({}, { intake: { kind: "start", confidence: AUTOSTART_MIN_CONFIDENCE - 1, project: "whale-console", detail: "x", why: "", at: settled } }), env)).toMatch(/门槛/);
  });

  it("门槛按传进来的值判：75 放行 78，80 挡住 78", () => {
    const t = defect({}, { intake: { kind: "start", confidence: 78, project: "whale-console", detail: "x", why: "", at: settled } });
    expect(eligible(t, { ...env, minConfidence: 75 })).toBeUndefined();
    expect(eligible(t, { ...env, minConfidence: 80 })).toBe("把握 78，门槛 80");
  });

  it("intake 判成 ask / queue 的不接", () => {
    expect(eligible(defect({}, { intake: { kind: "queue", why: "描述太模糊", at: settled } }), env)).toBe("判成 queue：描述太模糊");
  });

  it("卡上项目和 intake 判的不一致 → 不接；但项目是你定的就信你的", () => {
    expect(eligible(defect({ project: "fe-wealth-admin" }), env)).toMatch(/intake 判的是 whale-console/);
    expect(eligible(defect({ project: "fe-wealth-admin" }, { projectBy: "user" }), env)).toBeUndefined();
  });

  it("卡上没项目：intake 判的在注册表里就用它，不在就不接", () => {
    expect(eligible(defect({ project: undefined }), { ...env, knownProject: () => true })).toBeUndefined();
    expect(eligible(defect({ project: undefined }), { ...env, knownProject: () => false })).toBe("intake 判的 whale-console 不在项目注册表里");
    expect(eligible(defect({ project: undefined }, { intake: { kind: "start", confidence: 90, detail: "x", why: "", at: settled } }), env)).toBe("没有项目归属");
  });

  it("你说了先别做就不接", () => {
    expect(eligible(defect({}, { autostartOff: true }), env)).toBe("你说了先别做");
  });

  it("已经有终端、或卡上挂着问题的不接", () => {
    expect(eligible(defect({}, { jobId: "j" }), env)).toBe("已经有终端");
    expect(eligible(defect({ attention: "intake" }), env)).toMatch(/问题/);
  });

  it("已经不在「未开始」的不接：测试中说明改过了在等测试，进行中说明有人在改", () => {
    expect(eligible(defect({ stage: "testing" }), env)).toBe("已经在测试中");
    expect(eligible(defect({ stage: "dev" }), env)).toBe("已经在进行中");
    expect(eligible(defect({ stage: "todo" }), env)).toBeUndefined();
  });

  it("刚进来的等一个同步周期——缺陷描述刚建时常被反复改", () => {
    expect(eligible(defect({ createdAt: new Date(NOW - 60_000).toISOString() }), env)).toMatch(/等描述稳定/);
  });

  it("不在排队里的（processing / done）不看", () => {
    expect(eligible(defect({ status: "processing" }), env)).toBe("不在排队里");
    expect(pickAutostart([defect({ status: "processing" })], env)).toEqual([]);
  });
});

describe("pickAutostart：并发和每日上限", () => {
  it("同时只跑 1 条，优先级高的先", () => {
    const a = defect({ id: "a", priority: "low" });
    const b = defect({ id: "b", priority: "high" });
    expect(pickAutostart([a, b], env).map((t) => t.id)).toEqual(["b"]);
  });

  it("已有一条在跑就不开", () => {
    expect(pickAutostart([defect()], { ...env, running: 1, max: 1 })).toEqual([]);
  });

  it("不设每天上限：前一条跑完就接下一条，只受「同时 1 条」约束", () => {
    const q = [defect({ id: "a" }), defect({ id: "b" })];
    expect(pickAutostart(q, env).map((t) => t.id)).toEqual(["a"]);
    expect(pickAutostart(q.slice(1), env).map((t) => t.id)).toEqual(["b"]);
  });
});

describe("autostartPlan：卡片上「Friday 会自己开工 · HH:mm」", () => {
  const plan = { ...env, enabled: true };
  it("刚进来的：预计在稳定期结束时开", () => {
    const created = new Date(NOW - 60_000).toISOString();
    expect(autostartPlan(defect({ createdAt: created }), plan)).toEqual({ kind: "gate", at: new Date(Date.parse(created) + AUTOSTART_SETTLE_MS).toISOString(), behind: 0 });
  });
  it("已过稳定期：现在就开，前面有一条在跑就写出来", () => {
    expect(autostartPlan(defect(), { ...plan, running: 1 })).toEqual({ kind: "gate", at: new Date(NOW).toISOString(), behind: 1 });
  });
  it("开关关着、或门禁不过的没有预告", () => {
    expect(autostartPlan(defect(), { ...plan, enabled: false })).toBeUndefined();
    expect(autostartPlan(defect({}, { meegleType: "story" }), plan)).toBeUndefined();
  });
});

describe("autostartTick：卡上没项目", () => {
  it("用 intake 判的项目开工，写到卡上并标成 Friday 判的", async () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const dir = mkdtempSync(join(tmpdir(), "friday-as-"));
    execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
    writeFileSync(join(process.env.FRIDAY_DATA_DIR!, "projects.md"), `# 项目\n\n## guessapp\n- 目录：${dir}\n`);
    updateSettings({ autonomous: true });
    setTmuxRunner(async () => {
      throw Object.assign(new Error("spawn tmux ENOENT"), { code: "ENOENT" });
    });
    const t = createTask({
      title: "没定项目的缺陷",
      kind: "meegle",
      status: "understood",
      source: { meegleType: "issue", meegleId: "G1", intake: { kind: "start", confidence: 95, project: "guessapp", detail: "改一下", why: "具体", at: new Date().toISOString() } },
    });
    await autostartTick(Date.now() + AUTOSTART_SETTLE_MS + 60_000);
    expect(getTask(t.id)).toMatchObject({ project: "guessapp", source: { projectBy: "friday" } });
    expect(listAudit({ taskId: t.id }).some((e) => e.action === "project_guessed")).toBe(true);
  });
});

describe("autostartTick：tmux 没装", () => {
  it("不记 autostart 账、任务状态不变，本轮不抛", async () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const dir = mkdtempSync(join(tmpdir(), "friday-as-"));
    execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
    writeFileSync(join(process.env.FRIDAY_DATA_DIR!, "projects.md"), `# 项目\n\n## asproj\n- 目录：${dir}\n`);
    updateSettings({ autonomous: true });
    setTmuxRunner(async () => {
      throw Object.assign(new Error("spawn tmux ENOENT"), { code: "ENOENT" });
    });
    const t = createTask({
      title: "缺陷",
      kind: "meegle",
      status: "understood",
      project: "asproj",
      source: { meegleType: "issue", meegleId: "AS1", intake: { kind: "start", confidence: 95, project: "asproj", detail: "改一下", why: "具体", at: new Date().toISOString() } },
    });
    expect(await autostartTick(Date.now() + AUTOSTART_SETTLE_MS + 60_000)).toBe(0);
    expect(getTask(t.id)!.status).toBe("understood");
    expect(listAudit({ taskId: t.id }).some((e) => e.action === "autostart")).toBe(false);
  });
});

describe("runningAutonomous", () => {
  it("交付了 / 卡住的任务不占名额，哪怕 Claude 进程还活着", () => {
    const before = runningAutonomous();
    for (const [id, status] of [["ra-p", "processing"], ["ra-r", "review"], ["ra-b", "blocked"]] as const) {
      createJob({ id, project: "demo", dir: "/tmp", logPath: "/tmp/x.log" });
      createTask({ title: id, kind: "code", status, source: { jobId: id, autonomous: true } });
    }
    expect(runningAutonomous()).toBe(before + 1);
    for (const id of ["ra-p", "ra-r", "ra-b"]) finishJob(id, 0);
  });

  it("按 env.max 放", () => {
    const many = [1, 2, 3, 4, 5].map((i) => defect({ id: `m${i}` }));
    expect(pickAutostart(many, { ...env, running: 1, max: 3 })).toHaveLength(2);
  });

  it("定时任务的自主运行不占 autostart 的并发", () => {
    const before = runningAutonomous();
    createJob({ id: "ra-sched", project: "demo", dir: "/tmp", logPath: "/tmp/x.log" });
    createTask({ title: "[定时] x", kind: "code", status: "processing", source: { scheduleId: "s-1", jobId: "ra-sched", autonomous: true } });
    expect(runningAutonomous()).toBe(before);
    createJob({ id: "ra-norm", project: "demo", dir: "/tmp", logPath: "/tmp/x.log" });
    createTask({ title: "缺陷", kind: "meegle", status: "processing", source: { jobId: "ra-norm", autonomous: true } });
    expect(runningAutonomous()).toBe(before + 1);
  });
});

const story = (over: Partial<Task> = {}): Task => ({ id: "root-1", title: "养牛1.2", kind: "meegle", status: "processing", stage: "testing", priority: "normal", createdAt: settled, updatedAt: settled, source: { meegleType: "story", meegleId: "24642659" }, ...over }) as Task;
const sess = (over: Partial<TermSession> = {}): TermSession => ({ id: "root-1", project: "x", repoDir: "/r", tmuxName: "x", kind: "interactive", status: "running", worktree: "/r-wt", createdAt: settled, updatedAt: settled, ...over }) as TermSession;
const senv = (root?: Task, s?: TermSession, occupied = false): StoryEnv => ({ root: () => root, session: () => s, occupied: () => occupied });
const fresh = defect({ createdAt: new Date(NOW).toISOString() }, { intake: { kind: "queue", why: "模糊", at: settled }, linkedStoryId: "24642659" });

describe("testingStoryBug", () => {
  it("需求在测试中、会话在：不看 intake、不等稳定期", () => expect(testingStoryBug(fresh, senv(story(), sess()))).toEqual({ root: story() }));
  it("需求不在测试中 / 没会话 / 会话关了 / 没 worktree / 前一条没修完，各给原因", () => {
    expect(testingStoryBug(fresh, senv(story({ stage: "dev" }), sess()))).toBe("需求「养牛1.2」不在测试中");
    expect(testingStoryBug(fresh, senv(story(), undefined))).toBe("需求没有会话，Friday 不知道分支在哪");
    expect(testingStoryBug(fresh, senv(story(), sess({ status: "closed" })))).toBe("需求会话已关");
    expect(testingStoryBug(fresh, senv(story(), sess({ worktree: undefined })))).toBe("需求会话没有 worktree");
    expect(testingStoryBug(fresh, senv(story(), sess(), true))).toBe("等前一条修完");
  });
  it("不挂在需求下的缺陷不走这条路", () => expect(testingStoryBug(defect(), senv(undefined))).toBe("不挂在需求下"));
  it("旧门禁对需求在测试中的缺陷让路", () => expect(eligible(defect(), { ...env, root: () => story() })).toBe("需求在测试中，走需求会话那条路"));
  it("pickStoryBugs 每个需求只挑一条，高优先级先", () => {
    const a = defect({ id: "a", priority: "low" }, { linkedStoryId: "24642659" });
    const b = defect({ id: "b", priority: "high" }, { linkedStoryId: "24642659" });
    expect(pickStoryBugs([a, b], senv(story(), sess())).map((x) => x.task.id)).toEqual(["b"]);
  });
  it("storyPlan：通过给 kind story；等前一条给 waiting；旧路不受影响", () => {
    expect(storyPlan(fresh, { ...senv(story(), sess()), enabled: true }, NOW)).toEqual({ kind: "story", at: new Date(NOW).toISOString(), root: { id: "root-1", title: "养牛1.2" } });
    expect(storyPlan(fresh, { ...senv(story(), sess(), true), enabled: true })).toMatchObject({ kind: "story", waiting: "等前一条修完" });
    expect(storyPlan(fresh, { ...senv(story({ stage: "dev" }), sess()), enabled: true })).toBeUndefined();
    expect(storyPlan(fresh, { ...senv(story(), sess()), enabled: false })).toBeUndefined();
  });
  it("storyPlan：需求在测试中但会话不在 / 已关 / 没 worktree，也给 story 并写原因；需求只找一次", () => {
    for (const s of [undefined, sess({ status: "closed" }), sess({ worktree: undefined })]) {
      const root = vi.fn(() => story());
      expect(storyPlan(fresh, { root, session: () => s, occupied: () => false, enabled: true })).toMatchObject({ kind: "story", root: { id: "root-1" }, waiting: "需求会话不在，先给需求开终端" });
      expect(root).toHaveBeenCalledTimes(1);
    }
    expect(storyPlan(fresh, { ...senv(undefined), enabled: true })).toBeUndefined();
  });
  it("runningAutonomous 不数 handed 的缺陷", () => {
    const before = runningAutonomous();
    createJob({ id: "ra-handed", project: "demo", dir: "/tmp", logPath: "/tmp/x.log" });
    createTask({ title: "转交的缺陷", kind: "meegle", status: "processing", source: { jobId: "ra-handed", autonomous: true, handedAt: new Date().toISOString() } });
    expect(runningAutonomous()).toBe(before);
  });
});

const brief = (over: Partial<Brief> = {}): Brief => ({
  todo: "做导出", deps: [], acceptance: { source: "own", cases: ["导出 CSV"] }, release: "走 canary", plan: "改 export.ts", size: "small", sizeWhy: "一个文件",
  review: "approved", basis: "prd", at: settled, features: [], ...over,
});
const req = (over: Partial<Task> = {}, b: Partial<Brief> = {}, source: Task["source"] = {}): Task => {
  const t = { id: "r1", title: "导出中心", kind: "meegle", status: "understood", priority: "normal", project: "whale-console", createdAt: new Date(NOW).toISOString(), updatedAt: settled, ...over, source: { meegleType: "story", brief: brief(b), ...source } } as Task;
  if (t.source.brief && b.basis === undefined) t.source.brief.basis = briefBasis(t);
  return t;
};
const register = (name: string, ...extra: string[]) =>
  writeFileSync(join(process.env.FRIDAY_DATA_DIR!, "projects.md"), `# 项目\n\n## ${name}\n- 目录：/tmp\n${extra.map((l) => `- ${l}\n`).join("")}`);

describe("storyEligible：需求要有理解卡、没变、依赖齐才自己开", () => {
  it("没理解卡 / 待审 / 打回 / 过期 / 依赖没齐，各自拒绝并写明", () => {
    expect(storyEligible(req({}, {}, { brief: undefined }))).toMatch(/还没有理解卡/);
    expect(storyEligible(req({}, { review: "pending" }))).toMatch(/理解卡等你审/);
    expect(storyEligible(req({}, { review: "rejected" }))).toMatch(/方案被打回了/);
    expect(storyEligible(req({}, { stale: true }))).toMatch(/需求变了/);
    expect(storyEligible(req({}, { deps: [{ what: "接口文档", from: "后端小王", status: "ready" }, { what: "设计稿", from: "设计", status: "pending" }, { what: "字段", status: "pending" }] }))).toBe("等 设计 给 设计稿");
    expect(storyEligible(req({}, { deps: [{ what: "字段", status: "pending" }] }))).toBe("等 别人 给 字段");
  });
  it("没项目 / 已开工 / 挂着问题 / 你说先别做，各自拒绝", () => {
    expect(storyEligible(req({ project: undefined }))).toMatch(/项目/);
    expect(storyEligible(req({}, {}, { jobId: "j" }))).toMatch(/开过工/);
    expect(storyEligible(req({ attention: "question" }))).toMatch(/问题/);
    expect(storyEligible(req({}, {}, { autostartOff: true }))).toBe("你说了先别做");
  });
  it("审过或不用审、依赖齐、未开始 → 放行，不看 intake、不等 15 分钟", () => {
    register("whale-console", "方案送审：不用");
    expect(storyEligible(req())).toBeUndefined();
    expect(storyEligible(req({ status: "collected" }, { review: "none" }, {}))).toBeUndefined();
  });
});

describe("storyEligible：终审修正", () => {
  it("不用审的卡，项目后来改成要审：不开", () => {
    register("whale-console");
    expect(storyEligible(req({}, { review: "none" }))).toBe("项目改成要审了");
    register("whale-console", "方案送审：大的");
    expect(storyEligible(req({}, { review: "none", size: "large" }))).toBe("项目改成要审了");
    expect(storyEligible(req({}, { review: "none", size: "small" }))).toBeUndefined();
    expect(storyEligible(req({}, { review: "approved", size: "large" }))).toBeUndefined();
  });
  it("重建失败、需求变了（不等 briefTick 标过期）：不开", () => {
    register("whale-console", "方案送审：不用");
    expect(storyEligible(req({}, {}, { briefFailed: { at: settled, why: "会话异常退出" } }))).toBe("理解卡重建失败");
    expect(storyEligible(req({}, { basis: "changed" }))).toBe("需求变了，理解卡要重看");
  });
});

describe("需求门禁与缺陷门禁并存", () => {
  it("缺陷门禁不变：需求卡仍被 eligible 当成「不是缺陷」", () => {
    expect(eligible(req(), env)).toBe("不是缺陷");
    expect(eligible(defect(), env)).toBeUndefined();
  });
  it("autostartPlan 对能开的需求给 brief 计划，前面在跑的记在 behind", () => {
    expect(autostartPlan(req(), { ...env, enabled: true, running: 1 })).toEqual({ kind: "brief", at: new Date(NOW).toISOString(), behind: 1 });
    expect(autostartPlan(req({}, { stale: true }), { ...env, enabled: true })).toBeUndefined();
  });
  it("pickAutostart 需求和缺陷一起按优先级排、共用并发 1", () => {
    const r = req({ id: "r", priority: "high" });
    const d = defect({ id: "d" });
    expect(pickAutostart([d, r], env).map((t) => t.id)).toEqual(["r"]);
    expect(pickAutostart([d, r], { ...env, running: 1 })).toEqual([]);
  });
});

describe("autostartTick：需求", () => {
  const setup = (name: string, ...extra: string[]) => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    finishJob("ra-norm", 0);
    for (const x of listTasks("understood")) updateTask(x.id, { status: "ignored" });
    const dir = mkdtempSync(join(tmpdir(), "friday-as-"));
    execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
    writeFileSync(join(process.env.FRIDAY_DATA_DIR!, "projects.md"), `# 项目\n\n## ${name}\n- 目录：${dir}\n${extra.map((l) => `- ${l}\n`).join("")}`);
    updateSettings({ autonomous: true });
    return dir;
  };
  const mk = (name: string, review: Brief["review"]) => {
    const t = createTask({ title: `需求-${name}`, kind: "meegle", status: "understood", project: name, source: { meegleType: "story", meegleId: name, brief: brief({ review }) } });
    return updateTask(t.id, { source: { brief: brief({ review, basis: briefBasis(t) }) } })!;
  };

  it("用 briefDetail 开工、trigger autostart、记账写「理解卡你审过」", async () => {
    const dir = setup("storyapp");
    const t = mk("storyapp", "approved");
    const start = vi.mocked(startAutonomousJob);
    start.mockClear();
    start.mockResolvedValueOnce(undefined as never);
    expect(await autostartTick(NOW)).toBe(1);
    expect(start).toHaveBeenCalledTimes(1);
    const [task, name, d, detail, trigger] = start.mock.calls[0]!;
    expect([task.id, name, d, trigger]).toEqual([t.id, "storyapp", dir, "autostart"]);
    expect(detail).toContain("导出 CSV");
    const e = listAudit({ taskId: t.id }).find((x) => x.action === "autostart")!;
    expect(e.why).toBe("理解卡你审过、依赖齐了");
  });
  it("不用审的写「按项目规则不用审」", async () => {
    setup("storyapp2", "方案送审：不用");
    const t = mk("storyapp2", "none");
    vi.mocked(startAutonomousJob).mockResolvedValueOnce(undefined as never);
    await autostartTick(NOW);
    expect(listAudit({ taskId: t.id }).find((x) => x.action === "autostart")!.why).toBe("理解卡按项目规则不用审、依赖齐了");
  });
  it("交互式会话开着不开工", async () => {
    const dir = setup("storyapp3");
    const t = mk("storyapp3", "approved");
    createTermSession({ id: t.id, project: "storyapp3", repoDir: dir, tmuxName: "storyapp3", kind: "interactive", jobId: "jx" });
    const start = vi.mocked(startAutonomousJob);
    start.mockClear();
    start.mockResolvedValueOnce(undefined as never);
    expect(await autostartTick(NOW)).toBe(0);
    expect(start).not.toHaveBeenCalled();
  });
  it("理解卡在重写（锚点 job 在跑）：旧卡虽审过也不开", async () => {
    setup("storyapp4");
    const t = mk("storyapp4", "approved");
    createJob({ id: "bb-job", project: "storyapp4", dir: "/tmp", logPath: "/tmp/x.log" });
    createTask({ title: "理解卡：x", kind: "project", status: "processing", source: { briefFor: t.id, jobId: "bb-job", headless: true } });
    expect(storyEligible(getTask(t.id)!)).toBe("理解卡在重写");
    const start = vi.mocked(startAutonomousJob);
    start.mockClear();
    start.mockResolvedValueOnce(undefined as never);
    expect(await autostartTick(NOW)).toBe(0);
    expect(start).not.toHaveBeenCalled();
    finishJob("bb-job", 0);
  });
  it("并发设成 1：两条需求都能开，一轮只开一条", async () => {
    setup("storyapp5");
    updateSettings({ autonomousConcurrency: 1 });
    mk("storyapp5", "approved");
    mk("storyapp5", "approved");
    const start = vi.mocked(startAutonomousJob);
    start.mockClear();
    start.mockResolvedValue(undefined as never);
    expect(await autostartTick(NOW)).toBe(1);
    expect(start).toHaveBeenCalledTimes(1);
    start.mockReset();
    updateSettings({ autonomousConcurrency: 3 });
  });
  it("并发设成 1、需求和缺陷同优先级：先进来的先开", async () => {
    setup("storyapp6");
    updateSettings({ autonomousConcurrency: 1 });
    const early = new Date(NOW - 3 * AUTOSTART_SETTLE_MS).toISOString();
    const late = new Date(NOW - 2 * AUTOSTART_SETTLE_MS).toISOString();
    const d = createTask({ title: "缺陷", kind: "meegle", status: "understood", project: "storyapp6", source: { meegleType: "issue", meegleId: "D6", intake: { kind: "start", confidence: 95, project: "storyapp6", detail: "改", why: "具体", at: settled } } });
    const r0 = createTask({ title: "需求", kind: "meegle", status: "understood", project: "storyapp6", source: { meegleType: "story", meegleId: "S6", brief: brief() } });
    const r = updateTask(r0.id, { source: { brief: brief({ basis: briefBasis(r0) }) } })!;
    const db = (await import("../memory/db.js")).db();
    db.prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run(late, r.id);
    db.prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run(early, d.id);
    const start = vi.mocked(startAutonomousJob);
    start.mockClear();
    start.mockResolvedValueOnce(undefined as never);
    expect(await autostartTick(NOW)).toBe(1);
    expect(start.mock.calls[0]![0].id).toBe(d.id);
    start.mockReset();
    updateSettings({ autonomousConcurrency: 3 });
  });
});
