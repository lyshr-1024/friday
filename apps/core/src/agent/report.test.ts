import { describe, expect, it } from "vitest";
import { parseReport, queryReplyDraft } from "./report.js";
import { autonomousPrompt, buildScript } from "./runner.js";

describe("交付报告", () => {
  it("按约定结构解析，截图存为附件", () => {
    const md = `## 概要\n把登录页的报错提示补上了。\n\n## 改动\n- src/pages/login.tsx — 加错误提示\n- src/api/auth.ts — 透传错误码\n\n## 测试\n- pnpm typecheck → 通过\n- pnpm test → 42 passed\n\n## 测试结果\n全部通过。\n\n## 请验证\n- 打开登录页输错密码，应看到红字提示\n\n## 截图\n- login-before.png — 改前\n`;
    const r = parseReport(md, [{ name: "login-before.png", data: Buffer.from("iVBORw0KGgo=", "base64") }]);
    expect(r.summary).toBe("把登录页的报错提示补上了。");
    expect(r.changes).toHaveLength(2);
    expect(r.testSteps[1]).toContain("42 passed");
    expect(r.testResult).toBe("全部通过。");
    expect(r.verify[0]).toContain("登录页");
    expect(r.screenshots[0]!.name).toBe("login-before.png");
  });

  it("自主模式脚本用 claude -p，提示词带分支命名规范、报告路径与截图目录", () => {
    const prompt = autonomousPrompt("abcdef12-0000", "修登录报错", "whale-console");
    // 分支名由终端里的 Claude 按项目规范自己起，提示词只给规则不给固定名字
    expect(prompt).toContain("feat/<topic>");
    expect(prompt).toContain("fix/<bug>");
    expect(prompt).not.toContain("friday/abcdef12");
    expect(prompt).toContain("abcdef12-0000.report.md");
    expect(prompt).toContain("abcdef12-0000.shots");
    expect(prompt).toContain("agent-browser");
    const script = buildScript({ id: "j", dir: "/w", task: prompt, terminal: "ghostty", autonomous: true }, "/opt/claude", 7788, { settings: "/runs/j.settings.json", mcp: "/runs/j.mcp.json" });
    expect(script).toContain("-p --dangerously-skip-permissions");
    expect(script).toContain("/opt/claude");
    // 整条 claude 命令被 shellQuote 包了一层，内层引号变成 '\''，所以分开断言
    expect(script).toContain("--mcp-config");
    expect(script).toContain("j.mcp.json");
    expect(script).toContain("--append-system-prompt");
    expect(script).toContain("friday_done");
  });
});

describe("查询任务的回复草稿", () => {
  it("从报告里取出「回复草稿」那一段", () => {
    const md = [
      "## 概要", "分群奖励配置在活动编辑页的分群 tab。", "",
      "## 依据", "- apps/web/src/pages/activity/Groups.tsx:88 — 分群奖励表单在这里", "",
      "## 回复草稿", "分群奖励在活动编辑页的分群 tab 里配，每个分群单独填奖励 ID，详情接口已经返回了。",
    ].join("\n");
    const r = parseReport(md);
    expect(r.changes[0]).toContain("Groups.tsx:88");
    expect(queryReplyDraft(r)).toContain("分群 tab");
  });

  it("没有回复草稿那段时返回 undefined", () => {
    expect(queryReplyDraft(parseReport("## 概要\n查不到。"))).toBeUndefined();
  });

  it("草稿超长截断", () => {
    const long = "啊".repeat(400);
    const r = parseReport(`## 概要\nx\n\n## 回复草稿\n${long}`);
    expect(queryReplyDraft(r)!.length).toBeLessThanOrEqual(300);
  });
});
