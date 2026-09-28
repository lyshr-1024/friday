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
    expect(sys(claudeArgs(files, false, "demo-proj"))).toContain("ghost button");
    expect(sys(claudeArgs(files, true, "demo-proj"))).not.toContain("ghost button");
  });
});
