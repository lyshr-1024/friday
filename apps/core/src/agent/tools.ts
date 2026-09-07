import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { gitInspect } from "./git.js";
import { decide } from "./permission.js";
import { jobLog, launchClaude } from "./runner.js";
import { createJob, listJobs, recentDuplicate } from "../memory/jobs.js";
import { readMemoryFile, writeMemoryFile } from "../memory/files.js";
import { listThreads } from "../memory/threads.js";
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
      "列出 Slack 上找用户的人（按人聚合的线程，Friday 已做完功课：情境、需要用户做什么、建议回复、关联工单与项目、原文和链接）。用户问“Slack 有什么”“谁找我”“处理 XX 那件事”时先用它。",
      {},
      async () => {
        const list = listThreads("open");
        if (!list.length) return text("没有等处理的 Slack 线程。");
        return text(
          list
            .map((th, i) => {
              const b = th.brief;
              return [
                `${i + 1}. ${th.userName}（${th.kind === "dm" ? "私聊" : th.channelName}，${th.items.length} 条）${b ? ` · ${b.urgency}${b.needsReply ? " · 等你回" : ""}` : ""}${th.project ? ` · 项目 ${th.project}` : ""}`,
                b ? `   情境：${b.situation}` : "",
                b ? `   需要你：${b.needs}` : "",
                b?.reply ? `   建议回复：${b.reply}` : "",
                b?.context.length ? `   背景：${b.context.join("；")}` : "",
                `   原文：${th.items.map((it) => it.text.slice(0, 200)).join(" / ")}`,
                th.items.some((it) => it.permalink) ? `   链接：${th.items.map((it) => it.permalink).filter(Boolean).join(" ")}` : "",
              ]
                .filter(Boolean)
                .join("\n");
            })
            .join("\n"),
        );
      },
    ),
    tool(
      "jobs_list",
      "列出最近的终端任务（跑 Claude Code 的记录）：项目、任务、状态、退出码、终端里 Claude 最后一轮说了什么。用户问“刚才那个任务怎么样了”“终端跑完了吗”时用。",
      {},
      async () =>
        text(
          listJobs(10)
            .map((j) => `- [${j.status}] ${j.project}${j.task ? `：${j.task}` : ""}（${j.startedAt.slice(11, 16)} 开始${j.exitCode !== undefined ? `，退出码 ${j.exitCode}` : ""}）${j.lastMessage ? `\n  最后一轮：${j.lastMessage.slice(0, 200)}` : ""}`)
            .join("\n") || "还没有任务记录。",
        ),
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
        const dup = recentDuplicate(r.dir, task);
        if (dup) return text(`同一任务 10 秒内已经在终端启动过了（任务 id ${dup.id}），不再重复打开。`);
        const id = randomUUID();
        await launchClaude({ id, dir: r.dir, terminal, ...(task ? { task } : {}) });
        createJob({ id, project: r.name, dir: r.dir, logPath: jobLog(id), ...(task ? { task } : {}) });
        console.log(`[tool] run_claude ${r.name} ${task ?? "(交互)"}`);
        return text(`已在 ${terminal === "ghostty" ? "Ghostty" : "Terminal"} 打开 ${r.name}（${r.dir}）${task ? `，任务：${task}` : ""}。任务 id ${id}，结束后会回报。`);
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
  "mcp__friday__jobs_list",
  "mcp__friday__run_claude",
];
