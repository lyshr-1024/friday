import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { friday } from "../agent/prompt.js";
import { loadMemoryContext } from "./context.js";
import { initMemory } from "./db.js";
import { addNoteTask } from "./noteTask.js";

describe("记忆注入", () => {
  it("系统提示包含项目注册表与未完成待办，注释被去掉", () => {
    const dir = process.env.FRIDAY_DATA_DIR!;
    initMemory(dir);
    writeFileSync(join(dir, "projects.md"), "# 项目注册表\n\n<!-- 注释 -->\n\n## whale\n- 目录：~/w\n");
    addNoteTask({ text: "给 Friday 写测试", due: "2026-09-05" });
    const system = friday(loadMemoryContext());
    expect(system).toContain("## whale");
    expect(system).not.toContain("注释");
    expect(system).toContain("- [verbal] 给 Friday 写测试（截止 2026-09-05）");
    expect(system).toContain("memory_write");
  });

  it("people 与 decisions 不内联，只说一句需要时去读", () => {
    const dir = process.env.FRIDAY_DATA_DIR!;
    initMemory(dir);
    writeFileSync(join(dir, "people.md"), "## 灵雨\n- QA，负责 whale 的回归测试\n");
    writeFileSync(join(dir, "decisions.md"), "## 不做自动更新\n- 2026-09-01 定的\n");
    const system = friday(loadMemoryContext());
    // 正文一个字都不该出现在每轮重发的提示里
    expect(system).not.toContain("负责 whale 的回归测试");
    expect(system).not.toContain("不做自动更新");
    expect(system).toContain("memory_read");
    expect(system).toContain("people");
    expect(system).toContain("decisions");
  });

  it("文件为空时不提那一句，免得让它去读空文件", () => {
    const dir = process.env.FRIDAY_DATA_DIR!;
    initMemory(dir);
    writeFileSync(join(dir, "people.md"), "");
    writeFileSync(join(dir, "decisions.md"), "");
    const m = loadMemoryContext();
    expect(m.hasPeople).toBe(false);
    expect(m.hasDecisions).toBe(false);
    expect(friday(m)).not.toContain("先用 memory_read 读出来");
  });
});

describe("Skill 模式提示词", () => {
  it("开着时说明 Bash/Skill 可用，关着时明确不能执行命令", () => {
    expect(friday(undefined, true)).toContain("Bash（执行命令）");
    expect(friday(undefined, true)).not.toContain("不能执行任意命令");
    expect(friday(undefined, false)).toContain("不能执行任意命令");
    expect(friday(undefined, false)).not.toContain("Skill（");
  });
});
