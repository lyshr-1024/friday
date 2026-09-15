import { beforeEach, describe, expect, it } from "vitest";
import { createTask } from "./tasks.js";
import { addMessage, createConversation, renameConversation } from "./conversations.js";
import { search, snippet } from "./search.js";

describe("snippet", () => {
  it("在命中处前后各留一段，两头加省略号", () => {
    const long = `${"前".repeat(80)}换汇中后台${"后".repeat(80)}`;
    const s = snippet(long, "换汇中后台");
    expect(s).toContain("换汇中后台");
    expect(s.startsWith("…")).toBe(true);
    expect(s.endsWith("…")).toBe(true);
  });

  it("没命中就退回开头，空文本给空串", () => {
    expect(snippet("一段不相干的话", "换汇")).toBe("一段不相干的话");
    expect(snippet("   ", "x")).toBe("");
  });

  it("把换行压成空格，结果是一行", () => {
    expect(snippet("第一行\n\n第二行", "第二行")).not.toContain("\n");
  });
});

describe("全局搜索", () => {
  beforeEach(() => {
    createTask({ title: "【BO 后台】任务类型下拉框缺少「日内融平仓」", kind: "meegle", status: "understood", priority: "high", source: { meegleType: "issue", description: "测试环境 lb staging canary 1" } });
    createTask({ title: "自动平仓重构", kind: "meegle", status: "understood", priority: "normal", source: { meegleType: "story" } });
    createTask({ title: "已经忽略掉的平仓工单", kind: "meegle", status: "ignored", priority: "low", source: { meegleType: "issue" } });
  });

  it("需求和缺陷都能搜到，并带上分类", () => {
    const r = search("平仓");
    const cats = r.tasks.map((t) => t.category);
    expect(cats).toContain("defect");
    expect(cats).toContain("story");
  });

  it("已忽略的不出现在结果里", () => {
    expect(search("平仓").tasks.some((t) => t.title.includes("已经忽略掉的"))).toBe(false);
  });

  it("命中描述时给上下文，命中标题时不给", () => {
    const byDesc = search("canary").tasks[0]!;
    expect(byDesc.snippet).toContain("canary");
    const byTitle = search("日内融").tasks[0]!;
    expect(byTitle.snippet).toBeUndefined();
  });

  it("搜得到对话内容，结果指向所在会话", () => {
    const conv = createConversation();
    renameConversation(conv.id, "换汇需求讨论");
    addMessage(conv.id, { role: "user", kind: "ask", content: "帮我看下换汇中后台的验收标准" });
    const hit = search("验收标准").messages[0]!;
    expect(hit.id).toBe(conv.id);
    expect(hit.title).toBe("换汇需求讨论");
    expect(hit.role).toBe("你");
    expect(hit.snippet).toContain("验收标准");
  });


  it("会话没起过名时，标题用第一条用户消息兜底", () => {
    const conv = createConversation();
    addMessage(conv.id, { role: "user", kind: "ask", content: "换汇这块的汇率快照要几位小数" });
    addMessage(conv.id, { role: "assistant", kind: "ask", content: "六位小数，写在验收标准里" });
    const hit = search("六位小数").messages[0]!;
    expect(hit.title).toBe("换汇这块的汇率快照要几位小数");
    expect(hit.role).toBe("Friday");
  });

  it("空查询直接返回空，不去扫库", () => {
    expect(search("   ")).toEqual({ tasks: [], messages: [] });
  });

  it("% 和 _ 当字面量搜，不当通配符", () => {
    createTask({ title: "折扣率 100% 的边界", kind: "verbal", status: "understood", priority: "low", source: {} });
    expect(search("100%").tasks.map((t) => t.title)).toEqual(["折扣率 100% 的边界"]);
    expect(search("%").tasks.every((t) => t.title.includes("%"))).toBe(true);
  });
});
