import { describe, expect, it } from "vitest";
import { personEntry } from "./slack.js";


describe("personEntry", () => {
  const md = "# 人物\n\n## 拂晓\n- 产品，负责养牛活动\n\n## 灵雨\n- QA，负责 whale 的回归测试\n";

  it("取到该人条目的第一行", () => {
    expect(personEntry(md, "拂晓")).toBe("拂晓：产品，负责养牛活动");
  });

  it("取到列表里的第二个人", () => {
    expect(personEntry(md, "灵雨")).toBe("灵雨：QA，负责 whale 的回归测试");
  });

  it("查不到的人返回 undefined", () => {
    expect(personEntry(md, "路人")).toBeUndefined();
  });

  it("空文档返回 undefined", () => {
    expect(personEntry("", "拂晓")).toBeUndefined();
  });
});
