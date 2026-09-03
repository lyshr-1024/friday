import { describe, expect, it } from "vitest";
import { buildScript } from "./runner.js";

describe("Claude 启动脚本", () => {
  it("用绝对路径调用 claude，任务文本安全转义，结束后留交互 shell", () => {
    const script = buildScript({ id: "x", dir: "/Users/me/my proj", task: `修 it's bug`, terminal: "ghostty" }, "/opt/bin/claude");
    expect(script).toContain(`cd '/Users/me/my proj' || exit 1`);
    expect(script).toContain(`'/opt/bin/claude' '修 it'\\''s bug'`);
    expect(script.trim().endsWith("exec /bin/zsh -il")).toBe(true);
  });

  it("没有任务时只打开交互式 claude", () => {
    const script = buildScript({ id: "x", dir: "/tmp", terminal: "terminal" }, "/opt/bin/claude");
    expect(script).toContain("\n'/opt/bin/claude'\n");
  });
});
