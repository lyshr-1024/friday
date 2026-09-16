import { describe, expect, it } from "vitest";
import { HISTORY_EVERY_DAYS, draftSummary, historyDue, parseDraft } from "./handbook.js";
import { GLOBAL } from "../memory/handbooks.js";

const full = JSON.stringify({
  handbook: "## 技术口径\n- member_id 一律用 string\n  > member_id 应该用 string 类型",
  decisions: [{ text: "id 全链路用 string", why: "可能超 int64", at: "2026-09-01" }],
  people: [{ name: "拂晓", note: "养牛活动的产品" }],
  aliases: ["新BO", "wbo"],
});

describe("parseDraft", () => {
  it("解析完整结果", () => {
    const d = parseDraft(full)!;
    expect(d.handbook).toContain("member_id");
    expect(d.decisions[0]!.at).toBe("2026-09-01");
    expect(d.people[0]!.name).toBe("拂晓");
    expect(d.aliases).toEqual(["新BO", "wbo"]);
  });

  it("模型在前后多说两句、包了代码块也能取出来", () => {
    expect(parseDraft("好的，结果如下：\n```json\n" + full + "\n```\n以上。")).toBeDefined();
  });

  it("没有 handbook 就当这轮没提炼出东西", () => {
    expect(parseDraft(JSON.stringify({ decisions: [{ text: "x" }] }))).toBeUndefined();
  });

  it("解析不了返回 undefined，不抛", () => {
    expect(parseDraft("我没法完成这个任务")).toBeUndefined();
  });

  it("越界字段一律钳掉，不让模型往记忆库塞脏数据", () => {
    const d = parseDraft(
      JSON.stringify({
        handbook: "## 约定\n- 一条",
        decisions: [{ text: "", why: "空标题要丢" }, { text: "留下", at: "去年" }],
        people: [{ name: "只有名字没有备注" }],
        aliases: ["a", "够长的别名"],
      }),
    )!;
    expect(d.decisions).toEqual([{ text: "留下" }]);
    expect(d.people).toEqual([]);
    expect(d.aliases).toEqual(["够长的别名"]);
  });

  it("字段类型不对时当空处理", () => {
    const d = parseDraft(JSON.stringify({ handbook: "## 约定\n- 一条", decisions: "不是数组", people: 3, aliases: null }))!;
    expect(d.decisions).toEqual([]);
    expect(d.people).toEqual([]);
    expect(d.aliases).toEqual([]);
  });
});

describe("historyDue", () => {
  const now = Date.parse("2026-09-15T10:00:00Z");

  it("从没跑过就该跑", () => {
    expect(historyDue(undefined, now)).toBe(true);
  });

  it("刚跑过不重复跑", () => {
    expect(historyDue("2026-09-14T10:00:00Z", now)).toBe(false);
  });

  it("满一周就跑，不看是星期几——机器关着也不会整周漏掉", () => {
    expect(historyDue(new Date(now - HISTORY_EVERY_DAYS * 86_400_000).toISOString(), now)).toBe(true);
  });

  it("存的时间坏了就当没跑过", () => {
    expect(historyDue("坏数据", now)).toBe(true);
  });
});

describe("draftSummary", () => {
  it("按项目分节，附上依据了多少条原话", () => {
    const md = draftSummary({
      groups: [
        { project: "whale-console", handbook: "## 约定\n- 一条", decisions: [{ text: "决策一" }], people: [], aliases: ["wbo"], sources: 12 },
        { project: GLOBAL, handbook: "## 流程\n- 提交前跑类型检查", decisions: [], people: [], aliases: [], sources: 5 },
      ],
    });
    expect(md).toContain("## whale-console（依据 12 条原话）");
    expect(md).toContain("## 通用习惯（依据 5 条原话）");
    expect(md).toContain("决策 1 条：决策一");
    expect(md).toContain("别名：wbo");
  });
});
