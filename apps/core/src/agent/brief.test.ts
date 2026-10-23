import { describe, expect, it } from "vitest";
import type { Brief, Task } from "@friday/shared";
import type { Project } from "../memory/projects.js";
import { briefBasis, briefDetail, briefPolicy, briefable, parseBrief, pickBriefQueue, reviewFor, AUTOSTART_SETTLE_MS } from "./brief.js";

const task = (o: Partial<Task> & { source?: Task["source"] } = {}): Task =>
  ({ id: "t", title: "T", kind: "code", status: "understood", priority: "normal", createdAt: "2026-10-01", updatedAt: "2026-10-01", source: {}, ...o }) as Task;
const project = (extra: Record<string, string>): Project => ({ name: "p", dir: "/p", aliases: [], channels: [], urls: [], envs: [], protected: [], extra });
const aBrief = (o: Partial<Brief> = {}): Brief => ({
  todo: "x", deps: [], acceptance: { source: "own", cases: ["c"] }, release: "r", plan: "p", size: "small", sizeWhy: "w",
  review: "none", basis: "b", at: "2026-10-01", features: [], ...o,
});

describe("briefable", () => {
  it("没项目、查询任务、容器、已开工、已收工、kind 不对都不建", () => {
    expect(briefable(task({ kind: "work_item", project: "p", source: { external: { tool: "meegle", type: "work_item", id: "1", kind: "story" } } }))).toBe(true);
    expect(briefable(task({ kind: "verbal", project: "p" }))).toBe(true);
    expect(briefable(task({ kind: "work_item", project: "p", source: { external: { tool: "meegle", type: "work_item", id: "1", kind: "defect" } } }))).toBe(true);
    expect(briefable(task({ kind: "verbal" }))).toBe(false);
    expect(briefable(task({ kind: "slack", project: "p", source: { headless: true, conversation: "c:1" } }))).toBe(false);
    expect(briefable(task({ kind: "work_item", project: "p", source: { external: { tool: "meegle", type: "work_item", id: "1", kind: "story" }, container: true } }))).toBe(false);
    expect(briefable(task({ kind: "code", project: "p", source: { jobId: "j" } }))).toBe(false);
    expect(briefable(task({ kind: "code", project: "p", stage: "dev" }))).toBe(false);
    expect(briefable(task({ kind: "code", project: "p", status: "done" }))).toBe(false);
    expect(briefable(task({ kind: "project", project: "p" }))).toBe(false);
  });
});

describe("pickBriefQueue", () => {
  it("跳过已有理解卡、建失败未重试、你说先别做的；按截止 → 优先级 → 进来先后", () => {
    const a = task({ id: "a", project: "p", due: "2026-11-05", priority: "normal", createdAt: "2026-10-01" });
    const b = task({ id: "b", project: "p", due: "2026-11-01", priority: "low", createdAt: "2026-10-02" });
    const c = task({ id: "c", project: "p", priority: "high", createdAt: "2026-09-01" });
    const done = task({ id: "d", project: "p", due: "2026-10-01", source: { brief: aBrief() } });
    const off = task({ id: "e", project: "p", due: "2026-10-01", source: { autostartOff: true } });
    const failed = task({ id: "f", project: "p", due: "2026-10-01", source: { briefFailed: { at: "x", why: "y" } } });
    expect(pickBriefQueue([a, b, c, done, off, failed])?.id).toBe("b");
    expect(pickBriefQueue([c, task({ id: "g", project: "p", priority: "low" })])?.id).toBe("c");
  });
});

describe("pickBriefQueue 的等待与跳过", () => {
  const NOW = Date.parse("2026-10-22T10:00:00Z");
  const ago = (ms: number) => new Date(NOW - ms).toISOString();
  it("Meegle 来的进来不满 15 分钟不进队列，满了进；口头的刚建就进", () => {
    const fresh = task({ id: "m1", kind: "work_item", project: "p", createdAt: ago(5 * 60_000) });
    const old = task({ id: "m2", kind: "work_item", project: "p", createdAt: ago(20 * 60_000) });
    const verbal = task({ id: "v1", kind: "verbal", project: "p", createdAt: ago(1000) });
    expect(AUTOSTART_SETTLE_MS).toBe(15 * 60_000);
    expect(pickBriefQueue([fresh], NOW)).toBeUndefined();
    expect(pickBriefQueue([fresh, old], NOW)?.id).toBe("m2");
    expect(pickBriefQueue([verbal], NOW)?.id).toBe("v1");
  });
  it("skip 为真的不进队列", () => {
    const a = task({ id: "a", project: "p", createdAt: ago(60_000) });
    const b = task({ id: "b", project: "p", createdAt: ago(30_000) });
    expect(pickBriefQueue([a, b], NOW, (t) => t.id === "a")?.id).toBe("b");
  });
});

describe("送审档位", () => {
  it("briefPolicy 缺省和认不出的都按全部；reviewFor 三档", () => {
    expect(briefPolicy(undefined)).toBe("全部");
    expect(briefPolicy(project({ 方案送审: "大的" }))).toBe("大的");
    expect(briefPolicy(project({ 方案送审: "随便" }))).toBe("全部");
    expect(briefPolicy({ ...project({ 方案送审: "不用" }), name: "friday" })).toBe("全部");
    expect(briefPolicy({ ...project({ 方案送审: "大的" }), name: " Friday " })).toBe("全部");
    expect(reviewFor("small", "全部")).toBe("pending");
    expect(reviewFor("small", "大的")).toBe("none");
    expect(reviewFor("large", "大的")).toBe("pending");
    expect(reviewFor("large", "不用")).toBe("none");
  });
});

describe("briefBasis", () => {
  it("正文或资料变了指纹就变", () => {
    const t = task({ title: "T", source: { description: "d", docs: [{ url: "u1", from: "meegle" }] } });
    expect(briefBasis(t)).toBe(briefBasis({ ...t }));
    expect(briefBasis({ ...t, source: { ...t.source, description: "d2" } })).not.toBe(briefBasis(t));
    expect(briefBasis({ ...t, source: { ...t.source, docs: [] } })).not.toBe(briefBasis(t));
    expect(briefBasis(t)).toHaveLength(12);
  });
});

describe("parseBrief", () => {
  const ok = { todo: "做 A", deps: [{ what: "接口", status: "ready" }], acceptance: { source: "own", cases: ["打开页面看到 A"] }, release: "按 harua-deploy", plan: "改 src/a.tsx", size: "small", sizeWhy: "一个文件", features: ["f-11111111", "f-deadbeef"] };
  const ctx = { featureIds: new Set<string>(), basis: "b" };
  it("拒绝空用例和越界字段", () => {
    const r = parseBrief(ok, { featureIds: new Set(["f-11111111"]), basis: "b" });
    expect(typeof r).toBe("object");
    expect((r as Brief).features).toEqual(["f-11111111"]);
    expect((r as Brief).review).toBe("none");
    expect(parseBrief({ ...ok, acceptance: { source: "own", cases: [] } }, ctx)).toMatch(/用例/);
    expect(parseBrief({ ...ok, size: "huge" }, ctx)).toMatch(/size/);
    expect(parseBrief({ ...ok, todo: "" }, ctx)).toMatch(/todo/);
    expect(parseBrief({ ...ok, acceptance: { source: "x", cases: ["a"] } }, ctx)).toMatch(/acceptance\.source/);
    expect((parseBrief({ ...ok, deps: [{ what: "x", status: "weird" }] }, ctx) as Brief).deps[0]!.status).toBe("pending");
  });
  it("钳长度和条数", () => {
    const r = parseBrief({ ...ok, todo: "a".repeat(5000), acceptance: { source: "own", cases: Array.from({ length: 40 }, () => "c".repeat(400)) } }, ctx) as Brief;
    expect(r.todo).toHaveLength(4000);
    expect(r.acceptance.cases).toHaveLength(30);
    expect(r.acceptance.cases[0]).toHaveLength(300);
  });
});

describe("briefDetail", () => {
  it("带上用例清单和「偏离方案要写明」", () => {
    const d = briefDetail(task({ title: "加筛选" }), aBrief({ acceptance: { source: "own", cases: ["选高风险只剩高风险"] } }));
    expect(d).toContain("选高风险只剩高风险");
    expect(d).toContain("偏离");
  });
});
