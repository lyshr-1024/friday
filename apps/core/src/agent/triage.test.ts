import { describe, expect, it } from "vitest";
import { parseTriage } from "./triage.js";

describe("预处理结果解析", () => {
  it("解析 JSON、容忍前后废话、丢弃越界序号、规范紧急度", () => {
    const text = '好的：[{"index":1,"needsReply":true,"urgency":"high","summary":"灵雨要你看登录报错","draft":"我看看，十分钟回你"},{"index":2,"urgency":"weird","summary":"通知"},{"index":9,"summary":"越界"}]';
    const m = parseTriage(text, 2);
    expect(m.get(1)).toEqual({ needsReply: true, urgency: "high", summary: "灵雨要你看登录报错", draft: "我看看，十分钟回你" });
    expect(m.get(2)).toEqual({ needsReply: false, urgency: "normal", summary: "通知" });
    expect(m.has(9)).toBe(false);
  });
});
