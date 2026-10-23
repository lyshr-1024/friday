import { describe, expect, it } from "vitest";
import { homedir, tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanEnv } from "./env.js";
import type { Task } from "@friday/shared";
import { createFeature } from "../memory/features.js";
import { autonomousPrompt, buildGuardScript, claudeArgs, reportPath, storyBugPrompt, buildHookScript, buildHookSettings, transcriptPath, workCommand } from "./runner.js";
import { PUSH_WHY } from "./guard.js";
import { saveTool, removeTool } from "../connectors/registry.js";

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

  it("hook 脚本转发 UserPromptSubmit 的 prompt，截到 4000 字", () => {
    const script = buildHookScript("x", 7788, "/bin/node");
    expect(script).toContain("prompt");
    expect(script).toContain("slice(0, 4000)");
  });
});

describe("buildGuardScript 带项目的保护分支", () => {
  it("名单写进脚本，merge / rebase 不再有规则", () => {
    const s = buildGuardScript("/bin/node", "http://127.0.0.1:1/x", ["trunk", "canary*"]);
    expect(s).toContain("trunk");
    expect(s).toContain("canary");
    expect(s).not.toContain("合并由 Friday");
    expect(s).not.toContain("变基会改写历史");
    expect(s).toContain(PUSH_WHY);
  });
});

describe("storyBugPrompt", () => {
  it("带 taskId、原文围栏、打回前缀，不写任何发布命令", () => {
    const root = { id: "root-1", title: "养牛1.2", stage: "testing", source: {} } as Task;
    const bug = { id: "bugabcdef0", title: "列标题不一致", understanding: "x", source: { meegleId: "24780686", intake: { detail: "<fake>" } } } as Task;
    const p = storyBugPrompt(bug, root, "fe-wealth-admin", "改错页面了");
    expect(p).toContain("bugabcde");
    expect(p).toContain("养牛1.2");
    expect(p).toContain("上一轮被打回：改错页面了");
    expect(p).toContain("<untrusted");
    expect(p).not.toMatch(/git merge|canary|whale deploy|bo-deploy|harua-deploy/);
    expect(storyBugPrompt(bug, root, "fe-wealth-admin")).not.toContain("上一轮被打回");
  });

  it("压住通用提示词里的合并审核与 friday_finish：发测试环境的 merge 是交代的一部分，不收整条需求", () => {
    const p = storyBugPrompt({ id: "bugabcdef0", title: "x", source: {} } as Task, { id: "r", title: "r", stage: "testing", source: {} } as Task, "fe-wealth-admin");
    expect(p).toContain("不受");
    expect(p).toContain("合进主干");
    expect(p).toContain("不要调 friday_finish");
  });

  it("需求还在开发：只提交推送，不发测试环境；修复卡照样发回测试环境", () => {
    const bug = { id: "bugabcdef0", title: "x", source: {} } as Task;
    const dev = storyBugPrompt(bug, { id: "r", title: "r", stage: "dev", source: {} } as Task, "p");
    expect(dev).toContain("不用另外发测试环境");
    expect(dev).not.toContain("发测试环境时");
    expect(storyBugPrompt(bug, { id: "c", title: "r · 修复", source: { fixFor: "r" } } as Task, "p")).toContain("发测试环境时");
  });

  it("一组几条：列出每条的 taskId，每条修完单独交付", () => {
    const a = { id: "aaaaaaaa-1", title: "列名不对", source: {} } as Task;
    const b = { id: "bbbbbbbb-2", title: "筛选缺项", source: {} } as Task;
    const p = storyBugPrompt([a, b], { id: "r", title: "获奖名单", stage: "testing", source: {} } as Task, "p");
    expect(p).toContain("2 条缺陷（taskId aaaaaaaa、bbbbbbbb）");
    expect(p).toContain("每条修完单独调一次 friday_done");
  });
});

describe("autonomousPrompt 知识库", () => {
  it("命中功能时在手册之前带上知识库块，没命中不带", () => {
    createFeature("p-ap", { name: "对账单", where: "资金 › 对账", paths: ["src/bill"] }, "task");
    const hit = autonomousPrompt("j1", "对账单加导出", "p-ap");
    expect(hit).toContain("对账单 — 资金 › 对账 — src/bill");
    expect(hit).toContain('<untrusted source="knowledge">');
    expect(autonomousPrompt("j2", "别的事", "p-ap")).not.toContain("knowledge");
  });
});

describe("autonomousPrompt friday 项目", () => {
  it("friday 项目多一条：合并由用户做、要重启、不许放宽守卫；别的项目没有", () => {
    const s = autonomousPrompt("j", "x", "friday");
    expect(s).toContain("合并由用户做");
    expect(s).toContain("要重启 Friday");
    expect(s).toContain("agent/guard.ts");
    const other = autonomousPrompt("j", "x", "p-ap");
    expect(other).not.toContain("合并由用户做");
    expect(other).not.toContain("要重启 Friday");
  });
});

describe("Friday 驾驶的会话怎么拉起 claude", () => {
  const files = { settings: "/s", mcp: "/m" };
  it("Friday 驾驶的会话跑交互式：带 --model opus，不带 -p", () => {
    const cmd = workCommand({ id: "j1", repoDir: "/r", kind: "autonomous", task: "改", project: "p" }, "/bin/claude", 7788, files).join("\n");
    expect(cmd).toContain("--model");
    expect(cmd).toContain("opus");
    expect(cmd).not.toMatch(/ -p /);
  });
  it("只读查询仍是 -p --model opus；用户自己的交互式两样都不带", () => {
    expect(claudeArgs(files, { kind: "query", print: true }).slice(0, 3)).toEqual(["-p", "--model", "opus"]);
    const mine = claudeArgs(files, { kind: "interactive" });
    expect(mine).not.toContain("-p");
    expect(mine).not.toContain("--model");
  });
});

describe("自主任务提示词", () => {
  it("交付走 friday_done、写替你定了、影响别人的调 friday_blocked、交付后可能被追问", () => {
    const p = autonomousPrompt("j1", "改导出", "p");
    expect(p).toContain("friday_done");
    expect(p).toContain("decisions");
    expect(p).toMatch(/接口约定.*公共组件.*远端数据/);
    expect(p).toContain("friday_blocked");
    expect(p).toContain("再调一次 friday_done");
    expect(p).not.toContain(reportPath("j1"));
  });
  it("自主任务里拒答的理由说清楚按方案自己定、影响别人的才停", () => {
    const settings = JSON.parse(buildHookSettings("/h.sh", "/g.sh")) as { hooks: { PreToolUse: Array<{ matcher?: string; hooks: Array<{ command: string }> }> } };
    const deny = settings.hooks.PreToolUse.find((h) => h.matcher === "AskUserQuestion|ExitPlanMode")!.hooks[0]!.command;
    expect(deny).toContain("decisions");
    expect(deny).toContain("friday_blocked");
  });
});

describe("--strict-mcp-config", () => {
  const files = { settings: "/s.json", mcp: "/m.json" } as Parameters<typeof claudeArgs>[0];
  it("Friday 驾驶的会话带，用户驾驶的不带", () => {
    expect(claudeArgs(files, { kind: "autonomous" })).toContain("--strict-mcp-config");
    expect(claudeArgs(files, { kind: "query", print: true })).toContain("--strict-mcp-config");
    expect(claudeArgs(files, { kind: "interactive" })).not.toContain("--strict-mcp-config");
  });
});

describe("buildGuardScript 带已登记工具的二进制", () => {
  it("登记的工具（含停用的）binaries 写进脚本规则，脚本真跑起来能拦命令", () => {
    saveTool({ name: "guardtest", transport: "cli", connection: "guardtest", scenario: "t", projects: [], roles: [], binaries: ["guardbin"], enabled: false, draft: false, ops: [] });
    try {
      const s = buildGuardScript(process.execPath, undefined, []);
      expect(s).toContain("已登记为 Friday 的外部工具");
      // 规则里有单引号（"guardbin" 'guardbin' 这类写法），走一遍 shell 引号才知道脚本没坏
      const file = join(mkdtempSync(join(tmpdir(), "guard-")), "guard.sh");
      writeFileSync(file, s);
      chmodSync(file, 0o755);
      const run = (command: string) => execFileSync(file, { input: JSON.stringify({ tool_input: { command } }) }).toString();
      for (const c of ["guardbin x", `sh -c "guardbin x"`, "'guardbin' x"]) expect(run(c), c).toContain("deny");
      expect(run("cat guardbin.md")).toBe("{}");
    } finally {
      removeTool("guardtest");
    }
  });
});
