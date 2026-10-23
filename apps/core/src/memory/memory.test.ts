import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initMemory } from "./db.js";

const dir = process.env.FRIDAY_DATA_DIR!;

describe("记忆库", () => {
  it("首次初始化创建目录、markdown 模板和 todos.db", () => {
    initMemory(dir);
    expect(existsSync(join(dir, "logs"))).toBe(true);
    expect(existsSync(join(dir, "todos.db"))).toBe(true);
    expect(readFileSync(join(dir, "projects.md"), "utf8")).toContain("# 项目注册表");
  });

  it("再次初始化不覆盖已有 markdown", () => {
    const file = join(dir, "projects.md");
    const before = readFileSync(file, "utf8") + "\n## 手写内容\n";
    writeFileSync(file, before);
    initMemory(dir);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

});
