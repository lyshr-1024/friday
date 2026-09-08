import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { cleanEnv } from "./pty.js";
import { buildHookSettings, transcriptPath } from "./runner.js";

describe("终端环境与会话恢复", () => {
  it("清掉从 Claude Code 继承的会话标记，保留其他变量", () => {
    const env = cleanEnv({ PATH: "/bin", CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1", CLAUDE_CODE_SESSION_ID: "x", CLAUDE_PID: "9", CLAUDE_CONFIG_DIR: "/c", HOME: "/h" });
    expect(env).toEqual({ PATH: "/bin", CLAUDE_CONFIG_DIR: "/c", HOME: "/h" });
  });

  it("transcript 路径按 Claude Code 的目录编码规则拼", () => {
    expect(transcriptPath("/Users/me/workspace/fe-wealth-admin", "abc")).toBe(`${homedir()}/.claude/projects/-Users-me-workspace-fe-wealth-admin/abc.jsonl`);
    expect(transcriptPath("/Users/me/a.b/c", "s")).toBe(`${homedir()}/.claude/projects/-Users-me-a-b-c/s.jsonl`);
    expect(transcriptPath("/Users/me/Library/Application Support/Friday", "s")).toBe(`${homedir()}/.claude/projects/-Users-me-Library-Application-Support-Friday/s.jsonl`);
  });

  it("hook 在 SessionStart 就回传 session id，Stop 再回传每轮回答", () => {
    const settings = JSON.parse(buildHookSettings("/runs/x.hook.sh")) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    expect(Object.keys(settings.hooks).sort()).toEqual(["SessionStart", "Stop"]);
    expect(settings.hooks.SessionStart![0]!.hooks[0]!.command).toContain("x.hook.sh");
  });
});
