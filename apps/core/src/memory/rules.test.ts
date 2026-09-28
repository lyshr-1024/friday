import { describe, expect, it } from "vitest";
import { activeRules, addRule, confirmRule, getRule, renderHandbook, restoreRules, retireRule, reviseRule, setRuleText, snapshotRules, staleRules } from "./rules.js";

const ev = (quote: string, at = "2026-09-20T00:00:00Z") => ({ quote, at, kind: "utterance" as const, ref: "sess-1" });

describe("规则表", () => {
  it("add 之后能按项目取到，证据齐", () => {
    const r = addRule({ project: "p-add", section: "技术口径", text: "新建按钮统一用 ghost button", origin: "history", evidence: [ev("新建按钮都应该用 ghost button")] });
    expect(r.id).toMatch(/^r-[0-9a-f]{8}$/);
    expect(activeRules("p-add").map((x) => x.text)).toEqual(["新建按钮统一用 ghost button"]);
    expect(getRule(r.id)!.evidence).toEqual([ev("新建按钮都应该用 ghost button")]);
    expect(r.lastConfirmedAt).toBe("2026-09-20T00:00:00Z");
  });

  it("confirm 追加证据并刷新确认时间；revise 改文字也追加证据", () => {
    const r = addRule({ project: "p-cf", section: "流程", text: "改完跑 vp check", origin: "history", evidence: [ev("改完跑一下 vp check")] });
    confirmRule(r.id, ev("记得 vp check", "2026-09-27T00:00:00Z"));
    expect(getRule(r.id)).toMatchObject({ lastConfirmedAt: "2026-09-27T00:00:00Z" });
    expect(getRule(r.id)!.evidence).toHaveLength(2);
    reviseRule(r.id, "改完跑 vp check 和测试", ev("测试也要跑", "2026-09-28T00:00:00Z"));
    expect(getRule(r.id)).toMatchObject({ text: "改完跑 vp check 和测试", lastConfirmedAt: "2026-09-28T00:00:00Z" });
    expect(getRule(r.id)!.evidence).toHaveLength(3);
  });

  it("retire 之后不在 active 里，记下原因", () => {
    const r = addRule({ project: "p-rt", section: "约定", text: "暂时先还原老仓", origin: "history", evidence: [ev("暂时先还原老仓")] });
    retireRule(r.id, "临时口径");
    expect(activeRules("p-rt")).toEqual([]);
    expect(getRule(r.id)).toMatchObject({ status: "retired", retiredWhy: "临时口径" });
  });

  it("你亲手改过的变成 manual", () => {
    const r = addRule({ project: "p-man", section: "约定", text: "只改指定范围", origin: "history", evidence: [ev("只改这一处")] });
    setRuleText(r.id, "只改指定范围，不顺手动其他列");
    expect(getRule(r.id)).toMatchObject({ text: "只改指定范围，不顺手动其他列", origin: "manual" });
  });

  it("渲染 markdown：按分区分组、每条带 id 注释和第一条出处；退役的不出现", () => {
    addRule({ project: "p-md", section: "流程", text: "提交前跑测试", origin: "history", evidence: [ev("提交前跑一下测试"), ev("又说了一次")] });
    addRule({ project: "p-md", section: "约定", text: "先说方案再动手", origin: "history", evidence: [ev("先说方案")] });
    const gone = addRule({ project: "p-md", section: "约定", text: "已经不算了", origin: "history", evidence: [ev("x")] });
    retireRule(gone.id, "推翻");
    const md = renderHandbook("p-md");
    expect(md.startsWith("# p-md\n")).toBe(true);
    expect(md.indexOf("## 约定")).toBeLessThan(md.indexOf("## 流程"));
    expect(md).toMatch(/- 提交前跑测试 <!-- r-[0-9a-f]{8} -->\n> 提交前跑一下测试/);
    expect(md).not.toContain("又说了一次");
    expect(md).not.toContain("已经不算了");
    expect(renderHandbook("_global").startsWith("# 通用习惯")).toBe(true);
  });

  it("久未确认：超过 8 周没有新证据的", () => {
    const old = addRule({ project: "p-st", section: "约定", text: "老规矩", origin: "history", evidence: [ev("老", "2026-07-01T00:00:00Z")] });
    addRule({ project: "p-st", section: "约定", text: "新规矩", origin: "history", evidence: [ev("新", "2026-09-20T00:00:00Z")] });
    expect(staleRules("p-st", 8, new Date("2026-09-28T00:00:00Z")).map((r) => r.id)).toEqual([old.id]);
  });

  it("快照还原：退役、改写、新增都能整体撤回", () => {
    const keep = addRule({ project: "p-snap", section: "约定", text: "保留", origin: "history", evidence: [ev("保留")] });
    const snap = snapshotRules();
    retireRule(keep.id, "误退");
    addRule({ project: "p-snap", section: "约定", text: "后来加的", origin: "history", evidence: [ev("后来")] });
    restoreRules(snap);
    expect(activeRules("p-snap").map((r) => r.text)).toEqual(["保留"]);
    expect(getRule(keep.id)!.evidence).toHaveLength(1);
  });
});
