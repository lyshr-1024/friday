import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { gitInspect } from "./git.js";
import { decide } from "./permission.js";
import { launchClaude } from "./runner.js";
import { readMemoryFile, writeMemoryFile } from "../memory/files.js";
import { listInbox } from "../memory/inbox.js";
import { resolveProject } from "../memory/projects.js";
import { addLocalTodo } from "../memory/todos.js";
import { userSettings } from "../settings.js";

const project = z.string().min(1).describe("项目名、别名或目录路径");

function resolveOrExplain(query: string) {
  const r = resolveProject(query);
  if (r.kind === "match") return { dir: r.project.dir, name: r.project.name };
  if (r.kind === "ambiguous") return `「${query}」匹配到多个项目：${r.candidates.map((c) => `${c.name}（${c.dir}）`).join("、")}，请让用户明确。`;
  return `没找到项目「${query}」，请让用户在项目注册表里登记，或直接给目录路径。`;
}

const file = z.enum(["projects", "decisions", "people"]).describe("projects=项目注册表，decisions=决策记录，people=人物");
const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

// Friday 在对话里能用的全部工具。都是对记忆库的可逆写操作，按 permission.ts 归为 reversible：放行并留痕。
export const fridayTools = createSdkMcpServer({
  name: "friday",
  version: "0.1.0",
  tools: [
    tool("memory_read", "读取记忆库里的一个 markdown 文件全文。", { file }, async ({ file }) => text(readMemoryFile(file) || "（空文件）")),
    tool(
      "memory_write",
      "整篇覆盖写入记忆库 markdown 文件。改项目别名、登记新项目、记决策、记人物都用它：先 memory_read 拿全文，改好后整篇写回，保持原有格式（## 名称 / - 目录 / - 别名 / - 状态 / - 说明）。",
      { file, content: z.string().max(200_000) },
      async ({ file, content }) => {
        if (!decide("reversible").allowed) return text("操作被拒绝");
        writeMemoryFile(file, content);
        console.log(`[tool] memory_write ${file} ${content.length} chars`);
        return text(`已写入 ${file}`);
      },
    ),
    tool(
      "todo_add",
      "添加一条本地待办。",
      { text: z.string().min(1).max(2000), due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("截止日期 YYYY-MM-DD") },
      async (input) => {
        const todo = addLocalTodo(input.due ? { text: input.text, due: input.due } : { text: input.text });
        return text(`已记录：${todo.text}${todo.due ? `（截止 ${todo.due}）` : ""}`);
      },
    ),
    tool(
      "git_inspect",
      "只读查看某个项目的 git 状态。what=status 当前分支/未提交改动/相对上游；worktrees 每个 worktree 的分支、是否已合并进主分支、最后提交、是否有未提交改动；log 最近 15 条提交；branches 已合并/未合并分支。",
      { project, what: z.enum(["status", "worktrees", "log", "branches"]) },
      async ({ project, what }) => {
        const r = resolveOrExplain(project);
        if (typeof r === "string") return text(r);
        return text(`${r.name} (${r.dir})\n${await gitInspect(r.dir, what)}`);
      },
    ),
    tool(
      "slack_inbox",
      "列出 Slack 收件箱里未处理的消息（已预处理：谁、摘要、是否需回复、紧急度、关联项目、建议任务、链接）。用户问“Slack 有什么”“谁找我”“处理 XX 那条”时先用它。",
      {},
      async () => {
        const items = listInbox();
        if (!items.length) return text("收件箱没有未处理消息。");
        return text(
          items
            .map((it, i) => {
              const t = it.triage;
              return `${i + 1}. [${it.kind === "dm" ? "私聊" : it.channelName}] ${it.userName}：${t?.summary ?? it.text.slice(0, 80)}${t?.needsReply ? " · 需回复" : ""}${t ? ` · ${t.urgency}` : ""}${t?.project ? ` · 项目 ${t.project}` : ""}${t?.task ? `\n   建议任务：${t.task}` : ""}${t?.draft ? `\n   草稿：${t.draft}` : ""}${it.permalink ? `\n   ${it.permalink}` : ""}`;
            })
            .join("\n"),
        );
      },
    ),
    tool(
      "run_claude",
      "在用户默认终端打开该项目目录并启动交互式 Claude Code，可附带任务描述。用户说“起个终端”“让 Claude 去改/去查”“跑一下 X”时用它。",
      { project, task: z.string().max(4000).optional().describe("交给 Claude Code 的任务，一句话") },
      async ({ project, task }) => {
        const r = resolveOrExplain(project);
        if (typeof r === "string") return text(r);
        if (!decide("reversible").allowed) return text("操作被拒绝");
        const { terminal } = userSettings();
        await launchClaude({ id: randomUUID(), dir: r.dir, terminal, ...(task ? { task } : {}) });
        console.log(`[tool] run_claude ${r.name} ${task ?? "(交互)"}`);
        return text(`已在 ${terminal === "ghostty" ? "Ghostty" : "Terminal"} 打开 ${r.name}（${r.dir}）${task ? `，任务：${task}` : ""}`);
      },
    ),
  ],
});

export const FRIDAY_TOOL_NAMES = [
  "mcp__friday__memory_read",
  "mcp__friday__memory_write",
  "mcp__friday__todo_add",
  "mcp__friday__git_inspect",
  "mcp__friday__slack_inbox",
  "mcp__friday__run_claude",
];
