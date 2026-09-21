import { describe, expect, it } from "vitest";
import type { InboxItem } from "@friday/shared";
import { hasQuestionSignal, parseQuery, queryPrompt } from "./query.js";

const item = (text: string, over: Partial<InboxItem> = {}): InboxItem => ({
  id: "q1", kind: "dm", channelId: "D1", channelName: "与拂晓的私聊",
  userId: "U9", userName: "拂晓", text, permalink: "https://s/1",
  ts: "1789000010.0", receivedAt: "2026-09-21T00:00:00Z", done: false, ...over,
});

describe("hasQuestionSignal", () => {
  it("认全角和半角问号", () => {
    expect(hasQuestionSignal("这个字段哪来的？")).toBe(true);
    expect(hasQuestionSignal("where is it?")).toBe(true);
  });

  it("没问号但有疑问词也算", () => {
    expect(hasQuestionSignal("这块逻辑怎么实现的")).toBe(true);
    expect(hasQuestionSignal("分群奖励在哪里配置")).toBe(true);
    expect(hasQuestionSignal("为什么会渲染成 1970")).toBe(true);
    expect(hasQuestionSignal("能不能加个字段")).toBe(true);
    expect(hasQuestionSignal("有没有开关控制这个")).toBe(true);
  });

  it("陈述句不算", () => {
    expect(hasQuestionSignal("这个改完了，你看下")).toBe(false);
    expect(hasQuestionSignal("发布到 UAT 了")).toBe(false);
  });
});

describe("parseQuery", () => {
  it("是查询类时给出问题和项目", () => {
    expect(parseQuery('{"codeAnswerable": true, "ask": "分群奖励在哪配置", "project": "whale-console"}', ["whale-console"]))
      .toEqual({ ask: "分群奖励在哪配置", project: "whale-console" });
  });

  it("不是查询类返回 undefined", () => {
    expect(parseQuery('{"codeAnswerable": false}', ["whale-console"])).toBeUndefined();
  });

  it("项目不在注册表里就不填", () => {
    expect(parseQuery('{"codeAnswerable": true, "ask": "x", "project": "不存在的项目"}', ["whale-console"]))
      .toEqual({ ask: "x" });
  });

  it("没写 ask 的当作判不出来", () => {
    expect(parseQuery('{"codeAnswerable": true}', ["whale-console"])).toBeUndefined();
  });

  it("解析不出来返回 undefined", () => {
    expect(parseQuery("看起来是在问实现", ["whale-console"])).toBeUndefined();
  });
});

describe("queryPrompt", () => {
  it("列出全部项目名，消息过 untrusted", () => {
    const projects = [
      { name: "whale-console", dir: "/w", aliases: ["后台"], channels: [], urls: [] },
      { name: "fe-wealth-admin", dir: "/f", aliases: [], channels: [], urls: [] },
    ];
    const { system, prompt } = queryPrompt(item("分群奖励在哪配置？"), [], projects);
    expect(system).toContain("whale-console");
    expect(system).toContain("fe-wealth-admin");
    expect(prompt).toContain('<untrusted source="slack">');
    expect(prompt).toContain("分群奖励在哪配置");
  });
});
