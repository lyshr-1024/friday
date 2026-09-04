import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { decide } from "./permission.js";
import { readMemoryFile, writeMemoryFile } from "../memory/files.js";
import { addLocalTodo } from "../memory/todos.js";

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
  ],
});

export const FRIDAY_TOOL_NAMES = ["mcp__friday__memory_read", "mcp__friday__memory_write", "mcp__friday__todo_add"];
