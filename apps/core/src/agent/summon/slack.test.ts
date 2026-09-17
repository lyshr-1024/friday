import { describe, expect, it } from "vitest";
import type { Thread } from "@friday/shared";
import { personEntry, threadMatches } from "./slack.js";

function thread(over: Partial<Thread> = {}): Thread {
  return {
    id: "th1",
    kind: "dm",
    userId: "u1",
    userName: "拂晓",
    channelId: "",
    channelName: "",
    status: "open",
    firstTs: "1",
    lastTs: "2",
    updatedAt: "2026-09-16T00:00:00.000Z",
    items: [],
    ...over,
  };
}

describe("threadMatches", () => {
  it("私聊按人名匹配", () => {
    expect(threadMatches(thread(), undefined, "拂晓")).toBe(true);
    expect(threadMatches(thread(), undefined, "灵雨")).toBe(false);
  });

  it("频道按频道名匹配", () => {
    const t = thread({ kind: "mention", channelName: "wealth-fe" });
    expect(threadMatches(t, "#wealth-fe", undefined)).toBe(true);
    expect(threadMatches(t, "#other", undefined)).toBe(false);
  });

  it("私聊线程不会被频道匹配命中", () => {
    expect(threadMatches(thread(), "#wealth-fe", undefined)).toBe(false);
  });

  it("channel 和 person 都没给时不匹配", () => {
    expect(threadMatches(thread(), undefined, undefined)).toBe(false);
  });
});

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
