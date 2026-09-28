import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { groupByProject, isCandidate, isFridayDriven, isNoise, isOwnPrompt, projectForCwd, readSession, userText, GLOBAL, type HistoryMessage } from "./history.js";
import { config } from "../config.js";

const row = (over: Record<string, unknown> = {}) => ({ type: "user", message: { content: "把 member_id 统一改成 string 传" }, ...over });

describe("userText", () => {
  it("取纯文本消息", () => {
    expect(userText(row())).toBe("把 member_id 统一改成 string 传");
  });

  it("取 content 数组里的 text 块，跳过 tool_result", () => {
    const r = row({ message: { content: [{ type: "tool_result", content: "…" }, { type: "text", text: "应该用 string" }] } });
    expect(userText(r)).toBe("应该用 string");
  });

  it("系统注入的 meta 消息不算用户说的话", () => {
    expect(userText(row({ isMeta: true }))).toBe("");
  });

  it("subagent 的 prompt 是 Claude 自己写的，不是用户说的", () => {
    expect(userText(row({ isSidechain: true }))).toBe("");
  });

  it("assistant 行不取", () => {
    expect(userText(row({ type: "assistant" }))).toBe("");
  });
});

describe("isNoise", () => {
  it("太短的没有信息量", () => {
    expect(isNoise("修吧")).toBe(true);
  });

  it("系统标签、slash 命令、图片占位都不是用户的约定", () => {
    expect(isNoise("<system-reminder>这里是提醒内容</system-reminder>")).toBe(true);
    expect(isNoise("/clear 清理一下上下文好吗")).toBe(true);
    expect(isNoise("[Image: source: /Users/x/1.png] 看这张图")).toBe(true);
  });

  it("正常的一句约定不算噪音", () => {
    expect(isNoise("member_id 一律用 string 传递，不要用 int")).toBe(false);
  });
});

describe("isCandidate", () => {
  it("带纠正信号的留下", () => {
    expect(isCandidate("member_id 应该用 string 类型，全部保持用 string 传递")).toBe(true);
  });

  it("没有纠正信号的一次性指令筛掉", () => {
    expect(isCandidate("帮我把这个页面的表格加一列创建时间")).toBe(false);
  });
});

describe("projectForCwd", () => {
  const projects = [
    { name: "whale-console", dir: "/Users/z/Longbridge/whale-console" },
    { name: "fe-wealth-admin", dir: "/Users/z/Longbridge/fe-wealth-admin" },
  ];

  it("目录本身", () => {
    expect(projectForCwd("/Users/z/Longbridge/whale-console", projects)).toBe("whale-console");
  });

  it("worktree 在项目目录底下，跟着归到同一个项目", () => {
    expect(projectForCwd("/Users/z/Longbridge/fe-wealth-admin/.claude/worktrees/ai-agent-x", projects)).toBe("fe-wealth-admin");
  });

  it("同名前缀的兄弟目录不能误归", () => {
    expect(projectForCwd("/Users/z/Longbridge/whale-console-legacy", projects)).toBeUndefined();
  });

  it("嵌套时取最深的那个", () => {
    const nested = [...projects, { name: "sub", dir: "/Users/z/Longbridge/whale-console/packages/sub" }];
    expect(projectForCwd("/Users/z/Longbridge/whale-console/packages/sub/src", nested)).toBe("sub");
  });

  it("orca 的 workspace 跟项目目录无关，靠路径段里的仓库名认回来", () => {
    expect(projectForCwd("/Users/z/orca/workspaces/fe-wealth-admin/feat-m-123", projects)).toBe("fe-wealth-admin");
  });

  it("目录名和注册名不一致时，认目录名那一段", () => {
    expect(projectForCwd("/Users/z/orca/workspaces/whale-console/x", [{ name: "新BO", dir: "/Users/z/Longbridge/whale-console" }])).toBe("新BO");
  });

  it("不在任何项目里就没有归属", () => {
    expect(projectForCwd("/tmp/scratch", projects)).toBeUndefined();
  });
});

describe("groupByProject", () => {
  it("认不出项目的归通用组——跨项目的工作习惯多半长这样", () => {
    const msgs: HistoryMessage[] = [
      { at: "2026-09-01T00:00:00Z", cwd: "/a", project: "friday", text: "一", session: "s1" },
      { at: "2026-09-02T00:00:00Z", cwd: "/b", text: "二", session: "s1" },
    ];
    const g = groupByProject(msgs);
    expect(g.get("friday")).toHaveLength(1);
    expect(g.get(GLOBAL)).toHaveLength(1);
  });
});

describe("isOwnPrompt", () => {
  it("记忆库目录下的会话是 Friday 自己跟 Claude 说话，学回来是回音室", () => {
    expect(isOwnPrompt(config.dataDir)).toBe(true);
    expect(isOwnPrompt(`${config.dataDir}/runs`)).toBe(true);
  });

  it("项目目录里的是真人说的", () => {
    expect(isOwnPrompt("/Users/z/Longbridge/whale-console")).toBe(false);
  });

  it("没有 cwd 时不误判", () => {
    expect(isOwnPrompt("")).toBe(false);
  });
});

describe("isFridayDriven：确定性排除", () => {
  const ex = { texts: new Set(["我要开始做这条需求：X", "用户已逐项确认你上一轮列的 6 条验证点，全部通过。"]), sessions: new Set(["sess-auto"]) };

  it("程序拉起的会话（entrypoint sdk-*）整条不算", () => {
    expect(isFridayDriven({ entrypoint: "sdk-cli" }, "随便", ex)).toBe(true);
  });

  it("Friday 写进终端的第一句和后来敲进去的话，按记录精确匹配", () => {
    expect(isFridayDriven({ entrypoint: "cli" }, "我要开始做这条需求：X", ex)).toBe(true);
    expect(isFridayDriven({ entrypoint: "cli" }, "用户已逐项确认你上一轮列的 6 条验证点，全部通过。", ex)).toBe(true);
    // 没记录过的相似句子不再靠正则猜
    expect(isFridayDriven({ entrypoint: "cli" }, "用户已逐项确认你上一轮列的 9 条验证点，全部通过。", ex)).toBe(false);
  });

  it("你自己敲的照常学", () => {
    expect(isFridayDriven({ entrypoint: "cli" }, "不要用 variant=\"link\"", ex)).toBe(false);
  });
});

describe("readSession 按 session id 跳过 Friday 自己的会话", () => {
  it("文件名就是 session id，在排除集里的整份不读", () => {
    const dir = mkdtempSync(join(tmpdir(), "hist-"));
    const row = JSON.stringify({ type: "user", timestamp: "2026-09-28T01:00:00Z", cwd: "/x/whale-console", entrypoint: "cli", message: { content: "不要用 variant=link，统一 ghost" } });
    writeFileSync(join(dir, "sess-auto.jsonl"), row + "\n");
    writeFileSync(join(dir, "sess-me.jsonl"), row + "\n");
    const projects = [{ name: "whale-console", dir: "/x/whale-console" }];
    const ex = { texts: new Set<string>(), sessions: new Set(["sess-auto"]) };
    expect(readSession(join(dir, "sess-auto.jsonl"), projects, undefined, ex)).toEqual([]);
    expect(readSession(join(dir, "sess-me.jsonl"), projects, undefined, ex)).toHaveLength(1);
  });
});
