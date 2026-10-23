import { describe, expect, it } from "vitest";
import { builtin, seedBuiltins } from "./builtin.js";
import "./lark/tool.js";
import "./web/tool.js";
import { getTool, saveTool } from "./registry.js";
import { implementRole, role, type DocsRole } from "./roles.js";

describe("角色", () => {
  it("role 按设置取实现", () => {
    seedBuiltins();
    const fake = { owns: () => true, read: async () => undefined, excerpt: () => "", title: async () => undefined } satisfies DocsRole;
    implementRole("docs", "lark", fake);
    expect(role("docs")).toBe(fake);
  });

  it("工具停用后 role 抛错", () => {
    seedBuiltins();
    saveTool({ ...getTool("lark")!, enabled: false });
    expect(() => role("docs")).toThrow("没有可用的工具");
    saveTool({ ...getTool("lark")!, enabled: true });
  });

  it("seedBuiltins 保留用户改过的 enabled", () => {
    seedBuiltins();
    saveTool({ ...getTool("web")!, enabled: false });
    seedBuiltins();
    expect(getTool("web")!.enabled).toBe(false);
    expect(builtin("web")!.binaries).toEqual([]);
  });
});
