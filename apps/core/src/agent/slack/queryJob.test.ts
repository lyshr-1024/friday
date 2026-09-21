import { describe, expect, it } from "vitest";
import { queryJobPrompt } from "./queryJob.js";

describe("queryJobPrompt", () => {
  const one = [{ name: "whale-console", dir: "/w" }];
  const two = [...one, { name: "fe-wealth-admin", dir: "/f" }];

  it("写明只读、写明报告去哪", () => {
    const p = queryJobPrompt("job1", "分群奖励在哪配置", one, "拂晓");
    expect(p).toContain("只读");
    expect(p).toContain("不要修改任何文件");
    expect(p).toContain("job1.report.md");
    expect(p).toContain("分群奖励在哪配置");
    expect(p).toContain("拂晓");
  });

  it("要求给出文件路径和行号当依据", () => {
    expect(queryJobPrompt("job1", "x", one, "A")).toContain("行号");
  });

  it("项目判不出时列出全部项目让它自己判", () => {
    const p = queryJobPrompt("job1", "x", two, "A");
    expect(p).toContain("whale-console");
    expect(p).toContain("fe-wealth-admin");
    expect(p).toContain("先判断问的是哪个");
  });

  it("要求最后给一句可直接发出去的回复", () => {
    expect(queryJobPrompt("job1", "x", one, "A")).toContain("## 回复草稿");
  });

  it("不提终端、不让它等人——它跑在后台没有窗口", () => {
    const p = queryJobPrompt("job1", "x", one, "A");
    expect(p).toContain("不要问用户问题");
  });
});

describe("claudeArgs", () => {
  it("后台跑要带 -p，参数是数组不带引号（spawn 用）", async () => {
    const { claudeArgs } = await import("../runner.js");
    const args = claudeArgs({ settings: "/tmp/a b.json", mcp: "/tmp/c.json" }, true);
    expect(args[0]).toBe("-p");
    expect(args).toContain("/tmp/a b.json");
    expect(args.some((a) => a.startsWith("'"))).toBe(false);
  });
});
