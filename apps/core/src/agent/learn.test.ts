import { describe, expect, it } from "vitest";
import { learnDue, parsePick, parseResearch, pickPrompt, researchFileName, researchPrompt, type Material } from "./learn.js";

const at = (hourShanghai: number) => new Date(Date.UTC(2026, 8, 10, (hourShanghai - 8 + 24) % 24, 5));

const material: Material = {
  tasks: ["- [meegle · whale-console] 多语言字段编辑：表单里要能切语言"],
  commits: ["- [whale-console] 2026-09-09 feat: 多语言字段草稿"],
  threads: [],
  projects: [{ name: "whale-console", dir: "/x/wc", aliases: ["wbo"], channels: [], note: "后台" }],
  done: ["工作台配色与层级"],
};

describe("Friday 自学", () => {
  it("过了 8 点且今天没有笔记才到点", () => {
    expect(learnDue([], at(7))).toBe(false);
    expect(learnDue([], at(8))).toBe(true);
    expect(learnDue(["2026-09-10-多语言字段.md"], at(9))).toBe(false);
    expect(learnDue(["2026-09-09-昨天的题.md"], at(9))).toBe(true);
  });

  it("选题提示带素材、项目和已研究过的题", () => {
    const { system, prompt } = pickPrompt(material);
    expect(system).toContain("whale-console：后台");
    expect(prompt).toContain("多语言字段编辑");
    expect(prompt).toContain("工作台配色与层级");
  });

  it("解析选题：正常、跳过、坏输出", () => {
    expect(parsePick('前面废话 {"topic":"表单多语言字段的编辑交互","project":"whale-console","why":"正在做"} 后面')).toEqual({ topic: "表单多语言字段的编辑交互", project: "whale-console", why: "正在做" });
    expect(parsePick('{"skip":"素材太少"}')).toEqual({ skip: "素材太少" });
    expect(parsePick('{"topic":"","why":"x"}')).toBeUndefined();
    expect(parsePick("没有 json")).toBeUndefined();
  });

  it("研究提示点到项目目录，只放行网页工具的结构由调用方给", () => {
    const { prompt } = researchPrompt({ topic: "多语言字段编辑", project: "whale-console", why: "正在做" }, material);
    expect(prompt).toContain("目录 /x/wc");
    expect(prompt).toContain("题目：多语言字段编辑");
  });

  it("解析研究笔记：抽标题、为什么、建议", () => {
    const md = ["我查完了，输出如下：", "# 多语言字段的编辑交互", "## 为什么现在研究", "whale-console 正在做。", "## 社区做法（3–5 条）", "- Shopify：tab 切语言 https://a 2024", "## 对手头项目的建议（不超过 5 条）", "1. 用 tab 切语言\n2. 缺翻译标红", "## 不建议做的", "- 弹窗编辑"].join("\n");
    const r = parseResearch(md, "兜底");
    expect(r?.title).toBe("多语言字段的编辑交互");
    expect(r?.why).toBe("whale-console 正在做。");
    expect(r?.suggestions).toBe("1. 用 tab 切语言\n2. 缺翻译标红");
    expect(r?.markdown.startsWith("# 多语言")).toBe(true);
    expect(parseResearch("# 只有标题\n## 为什么现在研究\nx", "兜底")).toBeUndefined();
  });

  it("文件名以上海日期开头，标题里的斜杠空格换成连字符", () => {
    expect(researchFileName("表单 多语言/字段", at(9))).toBe("2026-09-10-表单-多语言-字段.md");
  });
});
