import { describe, expect, it } from "vitest";
import { parseReport } from "./report.js";
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

  it("自主模式脚本用 claude -p，提示词带分支、报告路径与截图目录", () => {
    const prompt = autonomousPrompt("abcdef12-0000", "修登录报错", "whale-console");
    expect(prompt).toContain("friday/abcdef12");
    expect(prompt).toContain("abcdef12-0000.report.md");
    expect(prompt).toContain("abcdef12-0000.shots");
    expect(prompt).toContain("agent-browser");
    const script = buildScript({ id: "j", dir: "/w", task: prompt, terminal: "ghostty", autonomous: true }, "/opt/claude", 7788);
    expect(script).toContain("-p --dangerously-skip-permissions");
    expect(script).toContain("/opt/claude");
  });
});
