import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { friday } from "../agent/prompt.js";
import { loadMemoryContext } from "./context.js";
import { initMemory } from "./db.js";
import { addLocalTodo } from "./todos.js";

describe("记忆注入", () => {
  it("系统提示包含项目注册表与未完成待办，注释被去掉", () => {
    const dir = process.env.FRIDAY_DATA_DIR!;
    initMemory(dir);
    writeFileSync(join(dir, "projects.md"), "# 项目注册表\n\n<!-- 注释 -->\n\n## whale\n- 目录：~/w\n");
    addLocalTodo({ text: "给 Friday 写测试", due: "2026-09-05" });
    const system = friday(loadMemoryContext());
    expect(system).toContain("## whale");
    expect(system).not.toContain("注释");
    expect(system).toContain("- [local] 给 Friday 写测试（截止 2026-09-05）");
    expect(system).toContain("memory_write");
  });
});
