import { describe, expect, it } from "vitest";
import { describeTool, formatActivity, parseActivity, parseCost, sessionCost } from "./transcript.js";

const row = (type: "user" | "assistant", content: unknown, ts = "2026-09-08T08:00:00Z") => JSON.stringify({ type, timestamp: ts, message: { role: type, content } });

describe("终端动作流", () => {
  it("把 transcript 压成一步一条，工具调用按 tool_result 标成败", () => {
    const jsonl = [
      row("user", "把登录页的报错提示补上"),
      row("assistant", [{ type: "text", text: "先看现状。" }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "cat src/login.tsx", description: "读登录页" } }]),
      row("user", [{ type: "tool_result", tool_use_id: "t1", content: "…", is_error: false }]),
      row("assistant", [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: "/w/src/login.tsx" } }]),
      row("user", [{ type: "tool_result", tool_use_id: "t2", content: "boom", is_error: true }]),
      row("assistant", [{ type: "tool_use", id: "t3", name: "mcp__friday__friday_progress", input: { text: "改到一半" } }]),
      '{"type":"file-history-snapshot","snapshot":{}}',
      "{not json",
    ].join("\n");
    const items = parseActivity(jsonl);
    expect(items.map((a) => [a.kind, a.text, a.ok])).toEqual([
      ["user", "把登录页的报错提示补上", undefined],
      ["say", "先看现状。", undefined],
      ["tool", "执行：读登录页", true],
      ["tool", "改 login.tsx", false],
      ["tool", "向 Friday 汇报：friday_progress", undefined],
    ]);
    expect(formatActivity(items)).toContain("✓ 执行：读登录页");
    expect(formatActivity(items)).toContain("✗ 改 login.tsx");
    expect(formatActivity(items)).toContain("… 向 Friday 汇报");
  });

  it("只留最后 N 条，用户注入的 skill 正文（text 块）不算动作", () => {
    const many = Array.from({ length: 20 }, (_, i) => row("assistant", [{ type: "text", text: `第 ${i} 句` }]));
    many.push(row("user", [{ type: "text", text: "Base directory for this skill: …" }]));
    const items = parseActivity(many.join("\n"), 5);
    expect(items).toHaveLength(5);
    expect(items.at(-1)!.text).toBe("第 19 句");
  });

  it("工具描述挑关键参数", () => {
    expect(describeTool("Grep", { pattern: "useAuth" })).toBe("搜「useAuth」");
    expect(describeTool("Skill", { skill: "agent-browser" })).toBe("用 skill agent-browser");
    expect(describeTool("Bash", { command: "pnpm test" })).toBe("执行：pnpm test");
    expect(describeTool("Whatever", {})).toBe("Whatever");
  });
});

describe("一次运行的成本：取最后一条 cost-state", () => {
  const cost = (usd: number, usage: Record<string, number>, added = 0, removed = 0, ms = 0) =>
    JSON.stringify({ type: "cost-state", totalCostUSD: usd, totalLinesAdded: added, totalLinesRemoved: removed, totalDuration: ms, modelUsage: Object.fromEntries(Object.entries(usage).map(([m, c]) => [m, { costUSD: c }])) });

  it("取最后一条；模型取花得最多的那个", () => {
    const jsonl = [cost(0.5, { "claude-opus-5": 0.5 }, 3, 1, 1000), row("user", "x"), cost(1.25, { "claude-haiku-4-5": 0.05, "claude-opus-5": 1.2 }, 10, 2, 9000)].join("\n");
    expect(parseCost(jsonl)).toEqual({ costUsd: 1.25, model: "claude-opus-5", linesAdded: 10, linesRemoved: 2, durationMs: 9000 });
  });

  it("没有 cost-state、或尾读切到半行，都不抛", () => {
    expect(parseCost([row("user", "x"), row("assistant", [{ type: "text", text: "好" }])].join("\n"))).toBeUndefined();
    expect(parseCost(`"totalCostUSD":3}\n${cost(0.2, { "claude-sonnet-5": 0.2 })}`)).toMatchObject({ costUsd: 0.2, model: "claude-sonnet-5" });
  });

  it("没有 session 或 transcript 不在，返回 undefined", () => {
    expect(sessionCost("/nowhere", undefined)).toBeUndefined();
    expect(sessionCost("/nowhere", "no-such-session")).toBeUndefined();
  });
});
