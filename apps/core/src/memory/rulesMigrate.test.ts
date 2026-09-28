import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handbookDir } from "./handbooks.js";
import { activeRules } from "./rules.js";
import { migrateHandbooksToRules } from "./rulesMigrate.js";

const head = (t: string) => `# ${t}\n\n<!-- Friday 从 Claude Code 历史提炼，可以直接手改 -->\n\n`;

describe("把现有手册迁进 rules 表", () => {
  it("逐条迁、出处跟着走、跨项目重复的归到通用、手写段落原样留作笔记", () => {
    mkdirSync(handbookDir(), { recursive: true });
    writeFileSync(join(handbookDir(), "_global.md"), `${head("通用习惯")}## 约定\n- 只改指定范围\n> 只改这一处，不要动其他列。\n`);
    writeFileSync(
      join(handbookDir(), "wc.md"),
      `${head("wc")}## 技术口径\n- i18n key 禁止拼接\n> 禁止 key 拼接\n> 全仓展开成完整字面量\n- 新建按钮统一 ghost button\n> 新建按钮都应该用 ghost button\n## 奇怪的分区\n- 这条归到约定\n> 原话\n`,
    );
    writeFileSync(
      join(handbookDir(), "fwa.md"),
      `${head("fwa")}## 技术口径\n- i18n key  禁止拼接\n> 不要用模板字符串拼 key\n\n## ref 是系统级还是租户级：自己看代码判断，不要问人\n判断方法：\n1. grep 这个 ref key。\n- 已核实结论：系统级\n`,
    );

    expect(migrateHandbooksToRules()).toMatchObject({ migrated: 4 });

    const global = activeRules("_global");
    const i18n = global.find((r) => r.text.startsWith("i18n key"))!;
    expect(i18n.evidence.map((e) => e.quote).sort()).toEqual(["不要用模板字符串拼 key", "全仓展开成完整字面量", "禁止 key 拼接"].sort());
    expect(global.map((r) => r.text)).toContain("只改指定范围");
    expect(activeRules("wc").map((r) => [r.section, r.text])).toEqual([
      ["技术口径", "新建按钮统一 ghost button"],
      ["约定", "这条归到约定"],
    ]);
    // 「已核实结论」那行在手写段落里，不能被当成规则
    expect(activeRules("fwa")).toEqual([]);
    expect(readFileSync(join(handbookDir(), "notes", "fwa.md"), "utf8")).toContain("判断方法：\n1. grep 这个 ref key。\n- 已核实结论：系统级");

    expect(existsSync(join(handbookDir(), "wc.md.migrated"))).toBe(true);
    const md = readFileSync(join(handbookDir(), "wc.md"), "utf8");
    expect(md).toMatch(/- 新建按钮统一 ghost button <!-- r-[0-9a-f]{8} -->/);
    expect(readFileSync(join(handbookDir(), "fwa.md"), "utf8")).toContain("ref 是系统级还是租户级");
  });

  it("迁过一次就不再迁", () => {
    expect(migrateHandbooksToRules()).toEqual({ migrated: 0, skipped: "已迁移" });
  });
});
