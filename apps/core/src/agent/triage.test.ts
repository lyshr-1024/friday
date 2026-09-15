import { describe, expect, it } from "vitest";
import { parseTriage, triagePrompt } from "./triage.js";

describe("预处理结果解析", () => {
  it("解析 JSON、容忍前后废话、丢弃越界序号、规范紧急度", () => {
    const text = '好的：[{"index":1,"needsReply":true,"urgency":"high","summary":"灵雨要你看登录报错","draft":"我看看，十分钟回你"},{"index":2,"urgency":"weird","summary":"通知"},{"index":9,"summary":"越界"}]';
    const m = parseTriage(text, 2);
    const withProject = parseTriage('[{"index":1,"needsReply":true,"urgency":"high","summary":"US 缺多语言","project":"whale-console","task":"补 US 环境活动类型的多语言文案"}]', 1);
    expect(withProject.get(1)).toMatchObject({ project: "whale-console", task: "补 US 环境活动类型的多语言文案" });
    expect(m.get(1)).toEqual({ needsReply: true, urgency: "high", summary: "灵雨要你看登录报错", draft: "我看看，十分钟回你" });
    expect(m.get(2)).toEqual({ needsReply: false, urgency: "normal", summary: "通知" });
    expect(m.has(9)).toBe(false);
  });
});

describe("预处理提示词", () => {
  it("带上项目注册表的名字、别名和频道", () => {
    const { system } = triagePrompt([], [{ name: "whale-console", dir: "/w", aliases: ["后台"], channels: ["#team-fe-bo"], urls: [], note: "后台前端" }]);
    expect(system).toContain("- whale-console（别名：后台） 频道：#team-fe-bo — 后台前端");
  });
});
