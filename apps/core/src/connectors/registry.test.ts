import { describe, expect, it } from "vitest";
import type { ToolOp, ToolRegistration } from "@friday/shared";
import { getTool, guardedBinaries, listTools, removeTool, saveTool, setHealth, usableOps } from "./registry.js";

const op = (name: string, extra: Partial<ToolOp> = {}): ToolOp => ({
  name, description: `${name} 说明`, inputSchema: { type: "object", properties: { q: { type: "string" } } },
  level: "read", levelBy: "friday", ...extra,
});

const reg = (name: string, extra: Partial<ToolRegistration> = {}): Omit<ToolRegistration, "createdAt" | "updatedAt"> => ({
  name, transport: "cli", connection: name, scenario: "测试用", projects: [], roles: [], binaries: [],
  enabled: true, draft: false, ops: [op("get")], ...extra,
});

describe("工具注册处", () => {
  it("saveTool 往返", () => {
    const saved = saveTool(reg("rt", {
      skill: "meegle", projects: ["p1"], roles: ["tracker"], binaries: ["rt"],
      ops: [op("get", { template: ["rt", "get", "{id}"] }), op("set", { level: "reversible", undo: { op: "set", args: { id: "$args.id" } } })],
    }));
    const got = getTool("rt")!;
    expect(got).toEqual(saved);
    expect(got.createdAt).toBeTruthy();
    expect(got).toMatchObject({ skill: "meegle", projects: ["p1"], roles: ["tracker"], binaries: ["rt"], enabled: true, draft: false });
    expect(got.ops.map((o) => o.name).sort()).toEqual(["get", "set"]);
    expect(got.ops.find((o) => o.name === "get")?.template).toEqual(["rt", "get", "{id}"]);
    expect(got.ops.find((o) => o.name === "set")?.undo).toEqual({ op: "set", args: { id: "$args.id" } });
  });

  it("reversible 没 undo 存成 irreversible", () => {
    saveTool(reg("rv", { ops: [op("w", { level: "reversible" })] }));
    expect(getTool("rv")!.ops[0]?.level).toBe("irreversible");
  });

  it("saveTool 覆盖 ops", () => {
    saveTool(reg("ow", { ops: [op("a"), op("b")] }));
    saveTool(reg("ow", { ops: [op("c")] }));
    expect(getTool("ow")!.ops.map((o) => o.name)).toEqual(["c"]);
  });

  it("guardedBinaries 停用、草稿的也算（停用不等于放行它的命令行），并去重", () => {
    saveTool(reg("g1", { binaries: ["aa", "bb"] }));
    saveTool(reg("g2", { binaries: ["bb", "cc"] }));
    saveTool(reg("g3", { enabled: false, binaries: ["zz"] }));
    saveTool(reg("g4", { enabled: false, draft: true, binaries: ["dd"] }));
    const bins = guardedBinaries();
    expect(bins).toEqual(expect.arrayContaining(["aa", "bb", "cc", "zz", "dd"]));
    expect(bins.filter((b) => b === "bb")).toHaveLength(1);
  });

  it("usableOps 去掉未定级", () => {
    const r = saveTool(reg("uo", { ops: [op("a"), op("b", { level: null })] }));
    expect(usableOps(r).map((o) => o.name)).toEqual(["a"]);
  });

  it("listTools 按 enabled 过滤，removeTool 返回快照并连 ops 一起删，setHealth 落库", () => {
    saveTool(reg("l1"));
    saveTool(reg("l2", { enabled: false }));
    expect(listTools({ enabled: true }).map((t) => t.name)).toContain("l1");
    expect(listTools({ enabled: true }).map((t) => t.name)).not.toContain("l2");
    expect(listTools().map((t) => t.name)).toEqual(expect.arrayContaining(["l1", "l2"]));
    setHealth("l1", { at: "2026-10-23T00:00:00.000Z", ok: false, error: "炸了" });
    expect(getTool("l1")!.health).toEqual({ at: "2026-10-23T00:00:00.000Z", ok: false, error: "炸了" });
    const snap = removeTool("l1");
    expect(snap?.name).toBe("l1");
    expect(snap?.ops).toHaveLength(1);
    expect(getTool("l1")).toBeUndefined();
    expect(removeTool("l1")).toBeUndefined();
  });

  it("再存同名保留 createdAt 和 health", () => {
    const a = saveTool(reg("keep"));
    setHealth("keep", { at: "t", ok: true });
    const b = saveTool(reg("keep", { scenario: "改了" }));
    expect(b.createdAt).toBe(a.createdAt);
    expect(b.health).toEqual({ at: "t", ok: true });
    expect(b.scenario).toBe("改了");
  });
});
