import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import "./meegle/index.js";
import { seedBuiltins } from "./builtin.js";
import { getTool, saveTool } from "./registry.js";
import { role } from "./roles.js";
import { checkHealth } from "./health.js";
import { fridayToolList } from "../agent/tools.js";

const prevClaudeJson = process.env.FRIDAY_CLAUDE_JSON;

afterEach(() => {
  if (prevClaudeJson === undefined) delete process.env.FRIDAY_CLAUDE_JSON;
  else process.env.FRIDAY_CLAUDE_JSON = prevClaudeJson;
});

describe("工具健康检查", () => {
  it("登记了 okr 但 ~/.claude.json 里没有：失败、不影响 builtin、主对话不抛", async () => {
    seedBuiltins();
    const file = join(process.env.FRIDAY_DATA_DIR!, "claude-no-okr.json");
    writeFileSync(file, JSON.stringify({ mcpServers: {} }));
    process.env.FRIDAY_CLAUDE_JSON = file;
    saveTool({
      name: "okr", transport: "mcp_http", connection: "okr", scenario: "OKR", projects: [], roles: [], binaries: [],
      enabled: true, draft: false, ops: [{ name: "list_okr_objects", description: "列", inputSchema: {}, level: "read", levelBy: "builtin" }],
    });
    const h = await checkHealth("okr");
    expect(h.ok).toBe(false);
    expect(h.error).toContain("没有 mcpServers.okr");
    expect(getTool("okr")!.health?.ok).toBe(false);
    expect(() => role("workItems")).not.toThrow();
    const t = fridayToolList(undefined).find((x) => x.name === "tool_call")!;
    const text = ((await t.handler({ tool: "okr", op: "list_okr_objects", args: {} } as never, {})).content[0] as { text: string }).text;
    expect(text).toContain("没调成");
    expect(text).toContain("没有 mcpServers.okr");
  });

  it("builtin 没有 health() 算 ok", async () => {
    seedBuiltins();
    expect((await checkHealth("web")).ok).toBe(true);
  });
});
