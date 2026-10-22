import { describe, expect, it } from "vitest";
import {
  addFeatureHistory,
  correctFeature,
  createFeature,
  deleteFeature,
  featureHistory,
  findFeatureByName,
  getFeature,
  hasHistoryFor,
  listFeatures,
  knowledgeBlock,
  listKnowledge,
  matchFeatures,
  mergeFeature,
  mergeFeatures,
  moveHistory,
  readKnowledge,
  renderKnowledge,
  restoreFeatures,
  snapshotFeatures,
  writeKnowledge,
} from "./features.js";

describe("功能表", () => {
  it("create 之后能按项目列出，id 形如 f-xxxxxxxx", () => {
    const f = createFeature("p-c", { name: "基金筛选", paths: ["src/funds"] }, "task", "2026-10-01T00:00:00Z");
    expect(f.id).toMatch(/^f-[0-9a-f]{8}$/);
    expect(listFeatures("p-c").map((x) => x.name)).toEqual(["基金筛选"]);
  });

  it("merge：aliases/paths/routes 取并集，owners 新值覆盖旧值，where/summary 非空才覆盖", () => {
    const f = createFeature("p-m", { name: "提现规则", aliases: ["提现"], paths: ["a"], owners: { backend: "甲", pm: "乙" }, summary: "旧" }, "bootstrap");
    const m = mergeFeature(f.id, { aliases: ["提现", "出金规则"], paths: ["b"], owners: { backend: "丙" }, summary: "" });
    expect(m.aliases).toEqual(["提现", "出金规则"]);
    expect(m.paths).toEqual(["a", "b"]);
    expect(m.owners).toEqual({ backend: "丙", pm: "乙" });
    expect(m.summary).toBe("旧");
  });

  it("findFeatureByName 忽略空白大小写并认别名", () => {
    createFeature("p-n", { name: "Fund Filter", aliases: ["基金 筛选"] }, "task");
    expect(findFeatureByName("p-n", "fundfilter")?.name).toBe("Fund Filter");
    expect(findFeatureByName("p-n", "基金筛选")?.name).toBe("Fund Filter");
    expect(findFeatureByName("p-other", "fundfilter")).toBeUndefined();
  });

  it("matchFeatures：名字命中排在别名命中前，短于 2 字的别名不参与，别的项目不出现", () => {
    createFeature("p-x", { name: "基金筛选", aliases: ["筛"] }, "task");
    createFeature("p-x", { name: "提现规则", aliases: ["基金"] }, "task");
    createFeature("p-y", { name: "基金筛选" }, "task");
    const hits = matchFeatures("p-x", "财富页基金筛选加一个入口");
    expect(hits.map((h) => h.name)).toEqual(["基金筛选", "提现规则"]);
    expect(matchFeatures("p-x", "筛一下")).toEqual([]);
  });

  it("matchFeatures：同为名字命中时，where / summary 的二字片段多的靠前；limit 生效", () => {
    createFeature("p-s", { name: "订单列表", summary: "无关" }, "task", "2026-10-02T00:00:00Z");
    createFeature("p-s", { name: "订单导出", where: "后台 › 订单中心", summary: "导出订单" }, "task", "2026-10-01T00:00:00Z");
    const hits = matchFeatures("p-s", "订单列表和订单导出都要改，订单中心");
    expect(hits.map((h) => h.name)).toEqual(["订单导出", "订单列表"]);
    expect(matchFeatures("p-s", "订单列表和订单导出", 1)).toHaveLength(1);
  });

  it("deleteFeature 连历史一起删", () => {
    const f = createFeature("p-d", { name: "A 功能" }, "task");
    addFeatureHistory({ featureId: f.id, taskId: "t1", at: "2026-10-02T00:00:00Z", what: "改了 A", files: [] });
    expect(hasHistoryFor(f.id, "t1")).toBe(true);
    expect(deleteFeature(f.id)).toBe(true);
    expect(featureHistory(f.id)).toEqual([]);
  });

  it("snapshot / restore：删掉新增的功能和历史，还原被改的功能", () => {
    const f = createFeature("p-snap", { name: "还原功能", summary: "旧" }, "task");
    const snap = snapshotFeatures([f.id]);
    mergeFeature(f.id, { summary: "新" });
    const h = addFeatureHistory({ featureId: f.id, at: "2026-10-03T00:00:00Z", what: "x", files: [] });
    const g = createFeature("p-snap", { name: "新增功能" }, "task");
    const gh = addFeatureHistory({ featureId: g.id, at: "2026-10-03T00:00:00Z", what: "y", files: [] });
    snap.added.push(g.id);
    snap.historyIds.push(h, gh);
    expect(restoreFeatures(snap)).toEqual(["p-snap"]);
    expect(getFeature(f.id)?.summary).toBe("旧");
    expect(getFeature(g.id)).toBeUndefined();
    expect(featureHistory(f.id)).toEqual([]);
    expect(featureHistory(g.id)).toEqual([]);
  });

  it("renderKnowledge 每条带 id 注释，writeKnowledge 落到 knowledge/<项目>.md，没功能时删文件", () => {
    const f = createFeature("p-r", { name: "订单列表", where: "后台 › 订单", paths: ["src/orders"] }, "task");
    expect(renderKnowledge("p-r")).toContain(`<!-- ${f.id} -->`);
    writeKnowledge("p-r");
    expect(listKnowledge()).toContain("p-r");
    expect(readKnowledge("p-r")).toContain("订单列表");
    deleteFeature(f.id);
    writeKnowledge("p-r");
    expect(listKnowledge()).not.toContain("p-r");
    expect(readKnowledge("p-r")).toBe("");
  });
});

describe("knowledgeBlock", () => {
  it("命中的每条一行「名字 — 在哪 — 目录」，整行截到上限，没命中为空", () => {
    createFeature("p-kb", { name: "基金筛选", where: "财富 › 基金", paths: ["src/funds"] }, "task");
    expect(knowledgeBlock("p-kb", "基金筛选加入口")).toContain("- 基金筛选 — 财富 › 基金 — src/funds");
    expect(knowledgeBlock("p-kb", "完全无关")).toBe("");
    expect(knowledgeBlock("p-kb", "基金筛选", 10)).toBe("");
  });
});

describe("功能纠正", () => {
  it("correctFeature 直接替换字段并记进 corrected", () => {
    const f = createFeature("p-cf", { name: "A", where: "A 仓", aliases: ["x"] }, "task");
    const c = correctFeature(f.id, { where: "B 仓", aliases: [] });
    expect(c).toMatchObject({ where: "B 仓", aliases: [], corrected: ["aliases", "where"] });
    expect(correctFeature(f.id, { where: "C 仓", summary: "s" }).corrected).toEqual(["aliases", "where", "summary"]);
  });

  it("删功能可撤销：功能和历史都回来", () => {
    const f = createFeature("p-del-u", { name: "持仓页", where: "w" }, "task");
    const h = addFeatureHistory({ featureId: f.id, taskId: "t1", at: "2026-10-03T00:00:00Z", what: "改了排序", files: ["a"] });
    const snap = snapshotFeatures([f.id], { withHistory: true });
    deleteFeature(f.id);
    expect(getFeature(f.id)).toBeUndefined();
    restoreFeatures(snap);
    expect(getFeature(f.id)?.where).toBe("w");
    expect(featureHistory(f.id)).toMatchObject([{ id: h, what: "改了排序", files: ["a"] }]);
  });

  it("合并：历史挂到留下的那条，名字进别名，可撤销", () => {
    const keep = createFeature("p-mg", { name: "提现", aliases: ["出金"] }, "task");
    const drop = createFeature("p-mg", { name: "提现规则", aliases: ["规则"] }, "task");
    const h1 = addFeatureHistory({ featureId: keep.id, at: "2026-10-01T00:00:00Z", what: "a", files: [] });
    const h2 = addFeatureHistory({ featureId: drop.id, at: "2026-10-02T00:00:00Z", what: "b", files: [] });
    const snap = snapshotFeatures([keep.id, drop.id], { withHistory: true });
    const m = mergeFeatures(keep.id, drop.id);
    expect(m.aliases).toEqual(["出金", "提现规则", "规则"]);
    expect(getFeature(drop.id)).toBeUndefined();
    expect(featureHistory(keep.id).map((h) => h.id).sort()).toEqual([h1, h2].sort());
    restoreFeatures(snap);
    expect(getFeature(drop.id)?.name).toBe("提现规则");
    expect(getFeature(keep.id)?.aliases).toEqual(["出金"]);
    expect(featureHistory(keep.id).map((h) => h.id)).toEqual([h1]);
    expect(featureHistory(drop.id).map((h) => h.id)).toEqual([h2]);
  });

  it("挪一条历史到另一个功能，可撤销", () => {
    const a = createFeature("p-mv", { name: "A" }, "task");
    const b = createFeature("p-mv", { name: "B" }, "task");
    const h = addFeatureHistory({ featureId: a.id, at: "2026-10-01T00:00:00Z", what: "a", files: [] });
    const snap = snapshotFeatures([a.id, b.id], { withHistory: true });
    moveHistory(h, b.id);
    expect(featureHistory(a.id)).toEqual([]);
    expect(featureHistory(b.id).map((x) => x.id)).toEqual([h]);
    restoreFeatures(snap);
    expect(featureHistory(a.id).map((x) => x.id)).toEqual([h]);
    expect(featureHistory(b.id)).toEqual([]);
  });
});
