import { describe, expect, it } from "vitest";
import type { ToolOp, ToolRegistration } from "@friday/shared";
import { saveTool } from "../connectors/registry.js";
import { catalogLines, describeTool, preselect } from "./toolCatalog.js";
import { friday, terminalBridgePrompt } from "./prompt.js";
import { autonomousPrompt } from "./runner.js";

const op = (name: string, extra: Partial<ToolOp> = {}): ToolOp => ({
  name, description: `${name} 说明`, inputSchema: { type: "object", properties: { q: { type: "string" } } },
  level: "read", levelBy: "friday", ...extra,
});

const reg = (name: string, extra: Partial<ToolRegistration> = {}): Omit<ToolRegistration, "createdAt" | "updatedAt"> => ({
  name, transport: "cli", connection: name, scenario: `${name} 的场景`, projects: [], roles: [], binaries: [],
  enabled: true, draft: false, ops: [op("get")], ...extra,
});

describe("工具目录", () => {
  it("catalogLines 按项目过滤", () => {
    saveTool(reg("cat-a", { projects: ["p1"] }));
    saveTool(reg("cat-b"));
    const p2 = catalogLines("p2");
    expect(p2).toContain("cat-b · cat-b 的场景");
    expect(p2.some((l) => l.startsWith("cat-a"))).toBe(false);
    const all = catalogLines();
    expect(all).toContain("cat-a · cat-a 的场景");
    expect(all).toContain("cat-b · cat-b 的场景");
  });

  it("draft 与全未定级的工具不进目录", () => {
    saveTool(reg("cat-draft", { draft: true }));
    saveTool(reg("cat-null", { ops: [op("get", { level: null })] }));
    saveTool(reg("cat-off", { enabled: false }));
    const all = catalogLines().join("\n");
    expect(all).not.toContain("cat-draft");
    expect(all).not.toContain("cat-null");
    expect(all).not.toContain("cat-off");
  });

  it("preselect 只取显式登记该项目的", () => {
    saveTool(reg("pre-a", { projects: ["p1"], ops: [op("get"), op("put", { level: "irreversible" })] }));
    saveTool(reg("pre-b"));
    const s = preselect("p1");
    expect(s).toContain("pre-a");
    expect(s).not.toContain("pre-b");
    expect(preselect("p-none")).toBe("");
  });

  it("describeTool 列已定级操作的等级和参数，未定级的不列", () => {
    saveTool(reg("desc-a", { ops: [op("get"), op("put", { level: "irreversible" }), op("hide", { level: null })] }));
    const d = describeTool("desc-a");
    expect(d).toContain("get（read）：get 说明");
    expect(d).toContain("put（irreversible）：put 说明");
    expect(d).toContain('"q"');
    expect(d).not.toContain("hide");
  });

  it("describeTool 工具不可用说原因", () => {
    saveTool(reg("desc-proj", { projects: ["p1"] }));
    expect(describeTool("nope")).toMatch(/^nope 不可用：/);
    expect(describeTool("cat-draft")).toMatch(/^cat-draft 不可用：/);
    expect(describeTool("desc-proj", "p2")).toMatch(/^desc-proj 不可用：.*p1/);
  });
});

describe("提示词里的工具目录", () => {
  it("主对话带【外部工具】，终端按项目过滤，自主任务带预选", () => {
    saveTool(reg("pr-only", { projects: ["p-pr"] }));
    expect(friday()).toContain("【外部工具】");
    expect(friday()).toContain("pr-only · pr-only 的场景");
    expect(terminalBridgePrompt("p-other")).not.toContain("pr-only");
    expect(terminalBridgePrompt("p-pr")).toContain("pr-only · pr-only 的场景");
    expect(autonomousPrompt("j", "做点事", "p-pr")).toContain("【这个项目常用的外部工具】");
    expect(autonomousPrompt("j", "做点事", "p-other")).not.toContain("【这个项目常用的外部工具】");
  });
});
