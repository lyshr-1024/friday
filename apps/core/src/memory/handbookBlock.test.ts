import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { GLOBAL, handbookNotesPath } from "./handbooks.js";
import { addRule, handbookBlock } from "./rules.js";

const ev = (at: string) => [{ quote: "原话", at, kind: "utterance" as const }];

describe("handbookBlock：注入给终端里的 Claude 的那段", () => {
  it("只带规则正文，不带出处和 id 注释；项目在前、通用在后", () => {
    addRule({ project: "hb-a", section: "约定", text: "新建按钮统一 ghost", origin: "history", evidence: ev("2026-09-20T00:00:00Z") });
    addRule({ project: GLOBAL, section: "流程", text: "提交前跑测试", origin: "history", evidence: ev("2026-09-20T00:00:00Z") });
    const b = handbookBlock("hb-a");
    expect(b).toContain("- 新建按钮统一 ghost");
    expect(b).toContain("- 提交前跑测试");
    expect(b.indexOf("ghost")).toBeLessThan(b.indexOf("提交前跑测试"));
    expect(b).not.toContain(">");
    expect(b).not.toContain("<!--");
  });

  it("超预算时留最近确认的、整行截，不切半句", () => {
    for (let i = 0; i < 20; i++) addRule({ project: "hb-b", section: "约定", text: `老规则${i}`.padEnd(30, "。"), origin: "history", evidence: ev(`2026-08-${String(i + 1).padStart(2, "0")}T00:00:00Z`) });
    addRule({ project: "hb-b", section: "约定", text: "最新的规则", origin: "history", evidence: ev("2026-09-27T00:00:00Z") });
    const b = handbookBlock("hb-b", 200);
    const own = b.split("\n\n")[0]!;
    expect(own).toContain("最新的规则");
    expect(own).not.toContain("老规则0。");
    expect(own.length).toBeLessThanOrEqual(200 + 40);
    for (const line of own.split("\n").slice(1)) expect(line.startsWith("- ")).toBe(true);
  });

  it("手写笔记在预算够时附在项目规则后面", () => {
    addRule({ project: "hb-c", section: "约定", text: "一条", origin: "history", evidence: ev("2026-09-20T00:00:00Z") });
    mkdirSync(dirname(handbookNotesPath("hb-c")), { recursive: true });
    writeFileSync(handbookNotesPath("hb-c"), "## ref 怎么判\n看有没有传 config\n");
    expect(handbookBlock("hb-c")).toContain("看有没有传 config");
  });

  it("项目自己一条规则都没有：不出现空的项目段，只剩通用", () => {
    const b = handbookBlock("hb-none-at-all");
    expect(b).not.toContain("项目 hb-none-at-all");
    expect(b.startsWith("通用：")).toBe(true);
  });
});
