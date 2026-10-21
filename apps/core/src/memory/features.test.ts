import { describe, expect, it } from "vitest";
import {
  addFeatureHistory,
  createFeature,
  deleteFeature,
  featureHistory,
  findFeatureByName,
  getFeature,
  hasHistoryFor,
  listFeatures,
  listKnowledge,
  matchFeatures,
  mergeFeature,
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
