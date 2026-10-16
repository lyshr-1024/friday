import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { cleanEnv } from "./env.js";
import type { Task } from "@friday/shared";
import { buildGuardScript, storyBugPrompt, buildHookScript, buildHookSettings, transcriptPath } from "./runner.js";
import { PUSH_WHY } from "./guard.js";

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
    const settings = JSON.parse(buildHookSettings("/runs/x.hook.sh")) as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>> };
    expect(Object.keys(settings.hooks).sort()).toEqual(["Notification", "PostToolUse", "PreToolUse", "SessionStart", "Stop", "UserPromptSubmit"]);
    expect(settings.hooks.PreToolUse![0]!.matcher).toBe("AskUserQuestion|ExitPlanMode");
    expect(settings.hooks.SessionStart![0]!.hooks[0]!.command).toContain("x.hook.sh");
  });

  it("hook 脚本回传 cwd；只有 Stop 才去 transcript 里补最后一段话", () => {
    const script = buildHookScript("x", 7788, "/bin/node");
    expect(script).toContain("cwd");
    expect(script).toMatch(/hook_event_name === "Stop"/);
  });
});

describe("buildGuardScript allowMerge", () => {
  it("allowMerge 的守卫不含 merge 规则，rebase / reset --hard / push 照旧在", () => {
    const s = buildGuardScript("/bin/node", "http://127.0.0.1:1/x", true);
    expect(s).not.toContain("合并由 Friday");
    expect(s).toContain("变基会改写历史");
    expect(s).toContain("会丢掉未提交的改动");
    expect(s).toContain(PUSH_WHY);
    expect(buildGuardScript("/bin/node", "http://127.0.0.1:1/x")).toContain("合并由 Friday");
  });
});

describe("storyBugPrompt", () => {
  it("带 taskId、原文围栏、打回前缀，不写任何发布命令", () => {
    const root = { id: "root-1", title: "养牛1.2" } as Task;
    const bug = { id: "bugabcdef0", title: "列标题不一致", understanding: "x", source: { meegleId: "24780686", intake: { detail: "<fake>" } } } as Task;
    const p = storyBugPrompt(bug, root, "fe-wealth-admin", "改错页面了");
    expect(p).toContain("bugabcde");
    expect(p).toContain("养牛1.2");
    expect(p).toContain("上一轮被打回：改错页面了");
    expect(p).toContain("<untrusted");
    expect(p).not.toMatch(/git merge|canary|whale deploy|bo-deploy|harua-deploy/);
    expect(storyBugPrompt(bug, root, "fe-wealth-admin")).not.toContain("上一轮被打回");
  });
});
