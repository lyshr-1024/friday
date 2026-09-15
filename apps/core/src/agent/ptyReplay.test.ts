import { describe, expect, it } from "vitest";
import { replayTail } from "./pty.js";

describe("replayTail", () => {
  it("没超长就原样回放", () => {
    expect(replayTail("abc\ndef", 100)).toBe("abc\ndef");
  });

  it("从行边界开始，丢掉被切断的那半行", () => {
    // 尾部 10 字符是「行\n第二行\n第三行」，开头那个残缺的「行」要丢掉
    expect(replayTail("第一行\n第二行\n第三行", 10)).toBe("第二行\n第三行");
  });

  it("残缺的转义序列不能留：切点落在序列中间时整行丢掉", () => {
    // 尾部 12 字符是 "b[31m红\n收尾"（\x1b 被切掉了半个序列）
    const out = replayTail(`前面很长的内容\x1b[31m红\n收尾`, 12);
    expect(out).toBe("收尾");
    expect(out).not.toContain("[31m");
  });

  it("整段没有换行时只能原样给出尾部", () => {
    expect(replayTail("aaaaaaaaaa", 4)).toBe("aaaa");
  });
});
