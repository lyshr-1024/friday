import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { basename } from "node:path";
import { transcriptPath } from "./runner.js";

/** 从 Claude Code 的 transcript（jsonl）里读出"它在干什么"：一步一条，工具调用带成败。 */
export interface Activity {
  ts: string;
  kind: "say" | "tool" | "user";
  text: string;
  /** 工具调用的结果：还没回来就是 undefined */
  ok?: boolean;
}

interface Block {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
}

interface Row {
  type?: string;
  timestamp?: string;
  message?: { content?: string | Block[] };
}

const TAIL_BYTES = 300_000;

function readTail(path: string): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    // 从中间切进来的第一行大概率是半截 JSON，丢掉
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    closeSync(fd);
  }
}

const short = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** 把一次工具调用压成一句人能看的话 */
export function describeTool(name: string, input: Record<string, unknown> = {}): string {
  switch (name) {
    case "Bash":
      return input.description ? `执行：${short(input.description, 60)}` : `执行：${short(input.command, 60)}`;
    case "Read":
      return `读 ${basename(String(input.file_path ?? ""))}`;
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      return `改 ${basename(String(input.file_path ?? input.notebook_path ?? ""))}`;
    case "Grep":
      return `搜「${short(input.pattern, 40)}」`;
    case "Glob":
      return `找文件 ${short(input.pattern, 40)}`;
    case "Skill":
      return `用 skill ${short(input.skill, 40)}`;
    case "Agent":
    case "Task":
      return `派子代理：${short(input.description ?? input.prompt, 50)}`;
    case "WebFetch":
    case "WebSearch":
      return `查网页 ${short(input.url ?? input.query, 50)}`;
    case "TodoWrite":
      return "更新待办清单";
    default:
      if (name.startsWith("mcp__friday__")) return `向 Friday 汇报：${name.slice("mcp__friday__".length)}`;
      return name;
  }
}

export function parseActivity(jsonl: string, limit = 12): Activity[] {
  const items: Activity[] = [];
  const byToolUse = new Map<string, Activity>();
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let row: Row;
    try {
      row = JSON.parse(line) as Row;
    } catch {
      continue;
    }
    if (row.type !== "user" && row.type !== "assistant") continue;
    const ts = row.timestamp ?? "";
    const content = row.message?.content;
    if (row.type === "user" && typeof content === "string") {
      items.push({ ts, kind: "user", text: short(content, 80) });
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (row.type === "assistant" && b.type === "text" && b.text?.trim()) {
        items.push({ ts, kind: "say", text: short(b.text, 100) });
      } else if (row.type === "assistant" && b.type === "tool_use" && b.name) {
        const a: Activity = { ts, kind: "tool", text: describeTool(b.name, b.input) };
        items.push(a);
        if (b.id) byToolUse.set(b.id, a);
      } else if (row.type === "user" && b.type === "tool_result" && b.tool_use_id) {
        const a = byToolUse.get(b.tool_use_id);
        if (a) a.ok = !b.is_error;
      }
    }
  }
  return items.slice(-limit);
}

export function jobActivity(dir: string, sessionId: string | undefined, limit = 12): Activity[] {
  if (!sessionId) return [];
  const p = transcriptPath(dir, sessionId);
  if (!existsSync(p)) return [];
  return parseActivity(readTail(p), limit);
}

/** 给 Friday 会话用的一段文字 */
export function formatActivity(items: Activity[]): string {
  if (!items.length) return "还没有动作记录（可能刚启动，或 transcript 还没落盘）。";
  return items
    .map((a) => {
      const mark = a.kind === "tool" ? (a.ok === undefined ? "…" : a.ok ? "✓" : "✗") : a.kind === "say" ? "💬" : "👤";
      return `${mark} ${a.text}`;
    })
    .join("\n");
}
