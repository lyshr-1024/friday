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
import { type Brief, type ExternalRef, type Task, type TermSession } from "@friday/shared";
import { kindOf } from "../connectors/meegle/rules.js";

import { autostartPlan, autostartTick, codeEligible, pickAutostart, runningAutonomous, type AutostartEnv } from "./autostart.js";
import { AUTOSTART_SETTLE_MS } from "./brief.js";
import { createJob, finishJob } from "../memory/jobs.js";
import { createTermSession } from "../memory/termSessions.js";
import { startAutonomousJob } from "./pipeline.js";
import { briefBasis } from "./brief.js";

vi.mock("./pipeline.js", async (orig) => {
  const m = await orig<typeof import("./pipeline.js")>();
  return { ...m, startAutonomousJob: vi.fn(m.startAutonomousJob) };
});

const NOW = Date.parse("2026-09-28T10:00:00Z");
const env: AutostartEnv = { now: NOW, running: 0, max: 1 };
const settled = new Date(NOW - AUTOSTART_SETTLE_MS - 1000).toISOString();

/** 卡上的工单引用；parent 是所属需求 */
const wi = (kind: ExternalRef["kind"], o: Partial<ExternalRef> = {}): ExternalRef => ({ tool: "meegle", type: "work_item", id: "w-1", kind, ...o });

const defect = (over: Partial<Task> = {}, source: Task["source"] = {}): Task =>
  ({
    id: "t1",
    title: "【新WBO·股票数据】上市日提交不落库",
    kind: "work_item",
    status: "understood",
    priority: "normal",
    project: "whale-console",
    createdAt: settled,
    updatedAt: settled,
    ...over,
    source: {
      external: wi("defect"),
      intake: { kind: "start", confidence: 90, project: "whale-console", detail: "把 listing_date 按 YYYY-MM-DD HH:mm:ss 传", why: "根因和修法都写了", at: settled },
      ...source,
    },
  }) as Task;

const brief = (over: Partial<Brief> = {}): Brief => ({
  todo: "做导出", deps: [], acceptance: { source: "own", cases: ["导出 CSV"] }, release: "走 canary", plan: "改 export.ts", size: "small", sizeWhy: "一个文件",
  review: "approved", basis: "prd", at: settled, features: [], ...over,
});
const req = (over: Partial<Task> = {}, b: Partial<Brief> = {}, source: Task["source"] = {}): Task => {
  const t = { id: "r1", title: "导出中心", kind: "work_item", status: "understood", priority: "normal", project: "whale-console", createdAt: new Date(NOW).toISOString(), updatedAt: settled, ...over, source: { external: wi("story"), brief: brief(b), ...source } } as Task;
  if (t.source.brief && b.basis === undefined) t.source.brief.basis = briefBasis(t);
  return t;
};
const bug = (over: Partial<Task> = {}, b: Partial<Brief> = {}, source: Task["source"] = {}): Task => req({ id: "b1", title: "上市日提交不落库", ...over }, b, { external: wi("defect"), ...source });
const register = (name: string, ...extra: string[]) =>
  writeFileSync(join(process.env.FRIDAY_DATA_DIR!, "projects.md"), `# 项目\n\n## ${name}\n- 目录：/tmp\n${extra.map((l) => `- ${l}\n`).join("")}`);

describe("codeEligible：缺陷和需求同一条门禁，看理解卡", () => {
  it("缺陷有 review: none 的理解卡、依赖齐 → 放行，intake 为空也放行", () => {
    register("whale-console", "方案送审：不用");
    const t = bug({}, { review: "none" });
    expect(t.source.intake).toBeUndefined();
    expect(codeEligible(t)).toBeUndefined();
    expect(pickAutostart([t], env).map((x) => x.id)).toEqual(["b1"]);
  });
  it("intake 把握 95 但没理解卡 → 不挑", () => {
    const t = bug({}, {}, { brief: undefined, intake: { kind: "start", confidence: 95, project: "whale-console", detail: "x", why: "具体", at: settled } });
    expect(codeEligible(t)).toBe("还没有理解卡");
    expect(pickAutostart([t], env)).toEqual([]);
  });
  it("已有 jobId、或 processing / review 的缺陷不挑", () => {
    expect(codeEligible(bug({}, {}, { jobId: "j" }))).toMatch(/开过工/);
    expect(codeEligible(bug({ status: "processing" }))).toBeTruthy();
    expect(codeEligible(bug({ status: "review" }))).toBeTruthy();
    expect(pickAutostart([bug({ status: "processing" }), bug({ id: "b2", status: "review" })], env)).toEqual([]);
  });
  it("挂在需求下的缺陷不管需求在哪个阶段都不单独开工；没挂需求的照常", () => {
    register("whale-console");
    expect(codeEligible(bug(), () => story())).toBe("跟所属需求一起修，不单独开工");
    expect(codeEligible(bug(), () => story({ stage: "dev" }))).toBe("跟所属需求一起修，不单独开工");
    expect(codeEligible(bug(), () => undefined)).toBeUndefined();
  });
  it("理解卡待审 / 打回 / 过期 / 依赖没齐 / 先别做，各自拒绝", () => {
    expect(codeEligible(bug({}, { review: "pending" }))).toBe("理解卡等你审");
    expect(codeEligible(bug({}, { review: "rejected" }))).toBe("方案被打回了");
    expect(codeEligible(bug({}, { stale: true }))).toMatch(/需求变了/);
    expect(codeEligible(bug({}, { deps: [{ what: "字段", status: "pending" }] }))).toBe("等 别人 给 字段");
    expect(codeEligible(bug({}, {}, { autostartOff: true }))).toBe("你说了先别做");
  });
});

describe("pickAutostart：并发", () => {
  it("同时只跑 1 条，优先级高的先", () => {
    const a = bug({ id: "a", priority: "low" });
    const b = bug({ id: "b", priority: "high" });
    expect(pickAutostart([a, b], env).map((t) => t.id)).toEqual(["b"]);
  });

  it("已有一条在跑就不开", () => {
    expect(pickAutostart([bug()], { ...env, running: 1, max: 1 })).toEqual([]);
  });

  it("不设每天上限：前一条跑完就接下一条，只受「同时 1 条」约束", () => {
    const q = [bug({ id: "a" }), bug({ id: "b" })];
    expect(pickAutostart(q, env).map((t) => t.id)).toEqual(["a"]);
    expect(pickAutostart(q.slice(1), env).map((t) => t.id)).toEqual(["b"]);
  });
});

describe("autostartPlan：卡片上「Friday 会自己开工」", () => {
  const plan = { ...env, enabled: true };
  it("满足门禁的缺陷给 brief 计划，前面在跑的记在 behind", () => {
    expect(autostartPlan(bug(), plan)).toEqual({ kind: "brief", at: new Date(NOW).toISOString(), behind: 0 });
    expect(autostartPlan(bug(), { ...plan, running: 1 })).toEqual({ kind: "brief", at: new Date(NOW).toISOString(), behind: 1 });
  });
  it("开关关着、或门禁不过、或只有 intake 没有理解卡的没有预告", () => {
    expect(autostartPlan(bug(), { ...plan, enabled: false })).toBeUndefined();
    expect(autostartPlan(bug({}, { review: "pending" }), plan)).toBeUndefined();
    expect(autostartPlan(bug({}, {}, { brief: undefined, intake: { kind: "start", confidence: 95, detail: "x", why: "", at: settled } }), plan)).toBeUndefined();
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
    const t0 = createTask({ title: "缺陷", kind: "work_item", status: "understood", project: "asproj", source: { external: wi("defect", { id: "AS1" }), brief: brief({ review: "approved" }) } });
    const t = updateTask(t0.id, { source: { brief: brief({ review: "approved", basis: briefBasis(t0) }) } })!;
    expect(await autostartTick(NOW)).toBe(0);
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
    register("whale-console");
    const many = [1, 2, 3, 4, 5].map((i) => bug({ id: `m${i}` }));
    expect(pickAutostart(many, { ...env, running: 1, max: 3 })).toHaveLength(2);
  });

  it("定时任务的自主运行不占 autostart 的并发", () => {
    const before = runningAutonomous();
    createJob({ id: "ra-sched", project: "demo", dir: "/tmp", logPath: "/tmp/x.log" });
    createTask({ title: "[定时] x", kind: "code", status: "processing", source: { scheduleId: "s-1", jobId: "ra-sched", autonomous: true } });
    expect(runningAutonomous()).toBe(before);
    createJob({ id: "ra-norm", project: "demo", dir: "/tmp", logPath: "/tmp/x.log" });
    createTask({ title: "缺陷", kind: "work_item", status: "processing", source: { jobId: "ra-norm", autonomous: true } });
    expect(runningAutonomous()).toBe(before + 1);
  });
});

const story = (over: Partial<Task> = {}): Task => ({ id: "root-1", title: "养牛1.2", kind: "work_item", status: "processing", stage: "testing", priority: "normal", createdAt: settled, updatedAt: settled, source: { external: wi("story", { id: "24642659" }) }, ...over }) as Task;
const sess = (over: Partial<TermSession> = {}): TermSession => ({ id: "root-1", project: "x", repoDir: "/r", tmuxName: "x", kind: "interactive", status: "running", worktree: "/r-wt", createdAt: settled, updatedAt: settled, ...over }) as TermSession;

describe("交代过的缺陷", () => {
  it("runningAutonomous 不数 handed 的缺陷", () => {
    const before = runningAutonomous();
    createJob({ id: "ra-handed", project: "demo", dir: "/tmp", logPath: "/tmp/x.log" });
    createTask({ title: "转交的缺陷", kind: "work_item", status: "processing", source: { jobId: "ra-handed", autonomous: true, handedAt: new Date().toISOString() } });
    expect(runningAutonomous()).toBe(before);
  });
});

describe("codeEligible：需求要有理解卡、没变、依赖齐才自己开", () => {
  it("没理解卡 / 待审 / 打回 / 过期 / 依赖没齐，各自拒绝并写明", () => {
    expect(codeEligible(req({}, {}, { brief: undefined }))).toMatch(/还没有理解卡/);
    expect(codeEligible(req({}, { review: "pending" }))).toMatch(/理解卡等你审/);
    expect(codeEligible(req({}, { review: "rejected" }))).toMatch(/方案被打回了/);
    expect(codeEligible(req({}, { stale: true }))).toMatch(/需求变了/);
    expect(codeEligible(req({}, { deps: [{ what: "接口文档", from: "后端小王", status: "ready" }, { what: "设计稿", from: "设计", status: "pending" }, { what: "字段", status: "pending" }] }))).toBe("等 设计 给 设计稿");
    expect(codeEligible(req({}, { deps: [{ what: "字段", status: "pending" }] }))).toBe("等 别人 给 字段");
  });
  it("没项目 / 已开工 / 挂着问题 / 你说先别做，各自拒绝", () => {
    expect(codeEligible(req({ project: undefined }))).toMatch(/项目/);
    expect(codeEligible(req({}, {}, { jobId: "j" }))).toMatch(/开过工/);
    expect(codeEligible(req({ attention: "question" }))).toMatch(/问题/);
    expect(codeEligible(req({}, {}, { autostartOff: true }))).toBe("你说了先别做");
  });
  it("审过或不用审、依赖齐、未开始 → 放行，不看 intake、不等 15 分钟", () => {
    register("whale-console", "方案送审：不用");
    expect(codeEligible(req())).toBeUndefined();
    expect(codeEligible(req({ status: "collected" }, { review: "none" }, {}))).toBeUndefined();
  });
});

describe("codeEligible：终审修正", () => {
  it("friday 项目的不用审旧卡：拒绝文案说方案一律要审", () => {
    register("friday");
    expect(codeEligible(req({ project: "friday" }, { review: "none" }))).toBe("friday 项目的方案一律要你审");
  });
  it("不用审的卡，项目后来改成要审：不开", () => {
    register("whale-console");
    expect(codeEligible(req({}, { review: "none" }))).toBe("项目改成要审了");
    register("whale-console", "方案送审：大的");
    expect(codeEligible(req({}, { review: "none", size: "large" }))).toBe("项目改成要审了");
    expect(codeEligible(req({}, { review: "none", size: "small" }))).toBeUndefined();
    expect(codeEligible(req({}, { review: "approved", size: "large" }))).toBeUndefined();
  });
  it("none 卡按项目 A 写的、项目改成 B（不等 checkBasis）：不开；老卡没有 project 当一致", () => {
    writeFileSync(join(process.env.FRIDAY_DATA_DIR!, "projects.md"), "# 项目\n\n## whale-console\n- 目录：/tmp\n- 方案送审：不用\n\n## other\n- 目录：/tmp\n- 方案送审：不用\n");
    expect(codeEligible(req({ project: "other" }, { review: "none", project: "whale-console" }))).toBe("项目改了，理解卡要重建");
    expect(codeEligible(req({ project: "whale-console" }, { review: "none", project: "whale-console" }))).toBeUndefined();
    expect(codeEligible(req({ project: "other" }, { review: "none" }))).toBeUndefined();
  });
  it("重建失败、需求变了（不等 briefTick 标过期）：不开", () => {
    register("whale-console", "方案送审：不用");
    expect(codeEligible(req({}, {}, { briefFailed: { at: settled, why: "会话异常退出" } }))).toBe("理解卡重建失败");
    expect(codeEligible(req({}, { basis: "changed" }))).toBe("需求变了，理解卡要重看");
  });
});

describe("需求和缺陷共用一条门禁", () => {
  it("autostartPlan 对能开的需求给 brief 计划，前面在跑的记在 behind", () => {
    expect(autostartPlan(req(), { ...env, enabled: true, running: 1 })).toEqual({ kind: "brief", at: new Date(NOW).toISOString(), behind: 1 });
    expect(autostartPlan(req({}, { stale: true }), { ...env, enabled: true })).toBeUndefined();
  });
  it("pickAutostart 需求和缺陷一起按优先级排、共用并发 1", () => {
    const r = req({ id: "r", priority: "high" });
    const d = bug({ id: "d" });
    expect(pickAutostart([d, r], env).map((t) => t.id)).toEqual(["r"]);
    expect(pickAutostart([d, r], { ...env, running: 1 })).toEqual([]);
  });
});

describe("交互式会话开着：codeEligible 就拒，不占名额", () => {
  const interactive = (): AutostartEnv => ({ ...env, session: () => sess({ kind: "interactive", status: "running" }) });
  it("codeEligible 回「开着你的交互式会话」；关了的不挡", () => {
    register("whale-console");
    expect(codeEligible(req(), undefined, () => sess())).toBe("开着你的交互式会话，不往里敲字");
    expect(codeEligible(req(), undefined, () => sess({ status: "closed" }))).toBeUndefined();
    expect(codeEligible(req(), undefined, () => sess({ kind: "autonomous" }))).toBeUndefined();
  });
  it("队首开着交互式会话、并发 1：挑中后面那条合格的", () => {
    register("whale-console");
    const head = req({ id: "head", priority: "high" });
    const next = req({ id: "next" });
    const e: AutostartEnv = { ...env, session: (t) => (t.id === "head" ? sess() : undefined) };
    expect(pickAutostart([head, next], e).map((t) => t.id)).toEqual(["next"]);
  });
  it("autostartPlan 对开着交互式会话的不给计划", () => {
    register("whale-console");
    expect(autostartPlan(req(), { ...interactive(), enabled: true })).toBeUndefined();
  });
  it("项目不在注册表里：codeEligible 拒，不占名额", () => {
    register("other");
    expect(codeEligible(req({ project: "nope" }))).toBe("项目 nope 不在注册表里");
    expect(pickAutostart([req({ id: "x", project: "nope", priority: "high" }), req({ id: "y", project: "other" })], env).map((t) => t.id)).toEqual(["y"]);
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
  const mk = (name: string, review: Brief["review"], typeKey = "story") => {
    const t = createTask({ title: `需求-${name}`, kind: "work_item", status: "understood", project: name, source: { external: wi(kindOf(typeKey), { id: name }), brief: brief({ review }) } });
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
  it("缺陷同一种门禁、同一种记账，evidence 里没有 confidence", async () => {
    setup("bugapp");
    const t = mk("bugapp", "approved", "issue");
    vi.mocked(startAutonomousJob).mockResolvedValueOnce(undefined as never);
    expect(await autostartTick(NOW)).toBe(1);
    const e = listAudit({ taskId: t.id }).find((x) => x.action === "autostart")!;
    expect(e.why).toBe("理解卡你审过、依赖齐了");
    expect(e.evidence).not.toHaveProperty("confidence");
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
    expect(codeEligible(getTask(t.id)!)).toBe("理解卡在重写");
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
    const d = mk("storyapp6", "approved", "issue");
    const r0 = createTask({ title: "需求", kind: "work_item", status: "understood", project: "storyapp6", source: { external: wi("story", { id: "S6" }), brief: brief() } });
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
