import { describe, expect, it } from "vitest";
import { continuationPrompt, parseContinuation } from "./continuation.js";

describe("parseContinuation", () => {
  it("只认显式的 true", () => {
    expect(parseContinuation('{"same": true, "why": "都在说验收问题"}')).toBe(true);
    expect(parseContinuation('{"same": false, "why": "两个需求"}')).toBe(false);
  });

  it("解析不出来当作不是同一件事", () => {
    expect(parseContinuation("这两条看起来一样")).toBe(false);
    expect(parseContinuation('{"same":')).toBe(false);
    expect(parseContinuation('{"same": "true"}')).toBe(false);
  });

  it("能从解释性文字里挑出 JSON", () => {
    expect(parseContinuation('判断如下：\n{"same": true, "why": "催办"}\n以上。')).toBe(true);
  });
});

describe("continuationPrompt", () => {
  it("带上已有消息和新消息", () => {
    const { system, prompt } = continuationPrompt(["验收问题先改一波"], "抽空验收问题改一改");
    expect(prompt).toContain("验收问题先改一波");
    expect(prompt).toContain("抽空验收问题改一改");
    expect(system).toContain("拿不准就答 false");
  });
});
