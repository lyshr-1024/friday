import { describe, expect, it, beforeAll } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { pageHint } from "./summon.js";

describe("pageHint", () => {
  beforeAll(() => {
    writeFileSync(
      join(config.dataDir, "projects.md"),
      "## whale-console\n- 目录：/w\n- 环境：测试 console.longbridge.xyz/x/\n\n## fe-wealth-admin\n- 目录：/f\n- 环境：线上 console.longbridge.xyz/\n",
    );
  });

  it("说清是哪个环境、哪个页面、项目在哪，但不替终端推断文件", () => {
    const hint = pageHint("https://console.longbridge.xyz/x/wbo/funds/params?tab=1", "/Users/me/work/whale-console");
    expect(hint).toBe("我开着的是 whale-console 的测试环境。页面路径 /x/wbo/funds/params，项目在 /Users/me/work/whale-console，先按路由约定找到对应文件再动手。");
  });

  it("地址谁都对不上时只说页面路径", () => {
    expect(pageHint("https://example.com/a/b", "/d")).toBe("页面路径 /a/b，项目在 /d，先按路由约定找到对应文件再动手。");
  });

  it("没有网址就什么都不加", () => {
    expect(pageHint(undefined, "/d")).toBe("");
  });
});
