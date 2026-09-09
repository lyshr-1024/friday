import { describe, expect, it } from "vitest";
import { friday } from "./prompt.js";

describe("系统提示", () => {
  it("绑了任务的会话把卡片当第一上下文注入", () => {
    const s = friday(undefined, false, "任务：修登录（processing）\n进展：改到一半");
    expect(s).toContain("【当前任务】");
    expect(s).toContain("修登录");
    expect(s.indexOf("【当前任务】")).toBeLessThan(s.length);
    expect(friday(undefined, false)).not.toContain("【当前任务】");
  });
});
