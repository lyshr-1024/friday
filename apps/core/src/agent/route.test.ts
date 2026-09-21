import { describe, expect, it } from "vitest";
import type { ConversationSummary } from "@friday/shared";
import { parseRoute, routeCandidates, routePrompt } from "./route.js";

const conv = (id: string, title: string, messageCount = 4): ConversationSummary => ({ id, title, messageCount, createdAt: "2026-09-05T02:00:00Z", updatedAt: "2026-09-07T02:00:00Z" });
const convs = [conv("a", "提款规则加多语言字段"), conv("b", "Slack 怎么拿浏览器登录态"), conv("c", "买杯咖啡")];

describe("会话路由", () => {
  it("命中序号就接旧会话，带上标题", () => {
    expect(parseRoute('{"index": 1, "why": "继续说多语言字段"}', convs)).toEqual({ conversationId: "a", title: "提款规则加多语言字段", why: "继续说多语言字段" });
  });

  it("0、越界、非数字、没有 JSON 都算新话题", () => {
    expect(parseRoute('{"index": 0, "why": "新话题"}', convs).conversationId).toBeUndefined();
    expect(parseRoute('{"index": 9, "why": "x"}', convs).conversationId).toBeUndefined();
    expect(parseRoute('{"index": "1"}', convs).conversationId).toBeUndefined();
    expect(parseRoute("我觉得是新的", convs)).toEqual({ why: "新话题" });
  });

  it("候选排除生成中和空会话，最多 20 条", () => {
    const many = Array.from({ length: 30 }, (_, i) => conv(`c${i}`, `话题 ${i}`, i === 3 ? 0 : 2));
    const out = routeCandidates(many, ["c1"]);
    expect(out).toHaveLength(20);
    expect(out.map((c) => c.id)).not.toContain("c1");
    expect(out.map((c) => c.id)).not.toContain("c3");
  });

  it("提示词带上这句话、候选标题和项目别名，规则偏保守", () => {
    const { system, prompt } = routePrompt("那个多语言的事再看下", convs, [{ name: "whale-console", dir: "/w", aliases: ["鲸鱼后台"], channels: [], urls: [], envs: [], extra: {} }]);
    expect(prompt).toContain("那个多语言的事再看下");
    expect(prompt).toContain("1. 提款规则加多语言字段");
    expect(system).toContain("鲸鱼后台");
    expect(system).toContain("拿不准就选新话题");
  });
});
