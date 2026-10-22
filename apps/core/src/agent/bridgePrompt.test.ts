import { rmSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { addRule } from "../memory/rules.js";
import { terminalBridgePrompt } from "./prompt.js";
import { claudeArgs } from "./runner.js";

const files = { settings: "/runs/j.settings.json", mcp: "/runs/j.mcp.json" };

describe("交互式终端的 system prompt 带项目手册", () => {
  it("有手册的项目内联进去；没手册的项目不多出空段", () => {
    addRule({ project: "demo-proj", section: "约定", text: "新建按钮统一用 ghost button", origin: "history", evidence: [{ quote: "原话", at: "2026-09-20T00:00:00Z", kind: "utterance" }] });
    expect(terminalBridgePrompt("demo-proj")).toContain("ghost button");
    expect(terminalBridgePrompt("no-such-proj")).not.toContain("用户在这个项目里的习惯");
    expect(terminalBridgePrompt()).not.toContain("用户在这个项目里的习惯");
  });

  it("自主任务（headless）不重复带：autonomousPrompt 里已经有一份", () => {
    const sys = (args: string[]) => args[args.indexOf("--append-system-prompt") + 1]!;
    expect(sys(claudeArgs(files, { kind: "interactive" }, "demo-proj"))).toContain("ghost button");
    expect(sys(claudeArgs(files, { kind: "autonomous" }, "demo-proj"))).not.toContain("ghost button");
  });
});

describe("git 的口径按终端归谁分开", () => {
  it("交互终端说 Friday 不拦，自主任务说清只拦保护分支", () => {
    const sys = (args: string[]) => args[args.indexOf("--append-system-prompt") + 1]!;
    const mine = sys(claudeArgs(files, { kind: "interactive" }));
    expect(mine).toContain("Friday 不拦这里的 git 操作");
    expect(mine).not.toContain("保护分支");
    const theirs = sys(claudeArgs(files, { kind: "autonomous" }));
    expect(theirs).toContain("只拦保护分支");
    expect(theirs).toContain("main");
    expect(theirs).not.toContain("授权");
  });
});

describe("交互式终端的 system prompt 点名回复语言", () => {
  it("调完 Friday 工具之后的汇报也用你的常用语言", () => {
    writeFileSync(process.env.FRIDAY_CLAUDE_SETTINGS!, JSON.stringify({ language: "chinese" }));
    try {
      expect(terminalBridgePrompt()).toMatch(/一律用中文[\s\S]*friday_\* 工具之后/);
    } finally {
      rmSync(process.env.FRIDAY_CLAUDE_SETTINGS!, { force: true });
    }
  });
});
