import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources";
import { FRIDAY_TOOL_NAMES, fridayTools } from "./tools.js";

export type AskEvent =
  | { type: "delta"; text: string }
  /** 这一轮开始调用工具了，之前流出的文字是过程碎话，前端应清掉。 */
  | { type: "reset" }
  | { type: "session"; sessionId: string }
  | { type: "done" }
  | { type: "error"; message: string };

export interface AskOptions {
  systemPrompt: string;
  cwd: string;
  signal?: AbortSignal;
  resume?: string;
  model?: string;
  /** Skill 模式：读取用户 ~/.claude 的 skill，放行 Skill/Bash/Read/Glob/Grep，权限 bypass（用户明确要求）。 */
  skills?: boolean;
  /** 当前会话 id，工具里用来把终端挂到正在讨论的任务上 */
  conversationId?: string;
}

const SKILL_TOOLS = ["Skill", "Bash", "Read", "Glob", "Grep"];

/** 带图片/文档时走流式输入：一条 SDKUserMessage 就结束。 */
async function* single(content: MessageParam["content"]): AsyncGenerator<SDKUserMessage> {
  yield { type: "user", message: { role: "user", content }, parent_tool_use_id: null };
}

export async function* askStream(prompt: string | MessageParam["content"], opts: AskOptions): AsyncGenerator<AskEvent> {
  const abortController = new AbortController();
  opts.signal?.addEventListener("abort", () => abortController.abort(), { once: true });

  const q = query({
    prompt: typeof prompt === "string" ? prompt : single(prompt),
    options: {
      systemPrompt: opts.systemPrompt,
      cwd: opts.cwd,
      tools: opts.skills ? SKILL_TOOLS : [],
      mcpServers: { friday: fridayTools(opts.conversationId) },
      allowedTools: opts.skills ? [...FRIDAY_TOOL_NAMES, ...SKILL_TOOLS] : FRIDAY_TOOL_NAMES,
      maxTurns: opts.skills ? 30 : 8,
      includePartialMessages: true,
      persistSession: true,
      settingSources: opts.skills ? ["user"] : [],
      ...(opts.skills ? { permissionMode: "bypassPermissions" as const, allowDangerouslySkipPermissions: true } : {}),
      abortController,
      ...(opts.resume ? { resume: opts.resume } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      stderr: (line) => console.error(`[claude] ${line.trimEnd()}`),
    },
  });

  let announced = false;
  let streamedSinceTool = false;
  for await (const msg of q) {
    if (!announced && "session_id" in msg && typeof msg.session_id === "string") {
      announced = true;
      yield { type: "session", sessionId: msg.session_id };
    }
    if (msg.type === "system" && msg.subtype === "init") {
      console.log(`[claude] init model=${msg.model} mode=${msg.permissionMode} tools=${msg.tools.join(",")} skills=${msg.skills.length}`);
    }
    if (msg.type === "stream_event") {
      const ev = msg.event;
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
        streamedSinceTool = true;
        yield { type: "delta", text: ev.delta.text };
      } else if (ev.type === "content_block_start" && ev.content_block.type === "tool_use" && streamedSinceTool) {
        streamedSinceTool = false;
        yield { type: "reset" };
      }
    } else if (msg.type === "assistant" && msg.error) {
      yield { type: "error", message: `Claude 返回错误：${msg.error}` };
    } else if (msg.type === "result") {
      console.log(`[claude] model=${Object.keys(msg.modelUsage).join(",") || "?"} cost=$${msg.total_cost_usd.toFixed(4)} turns=${msg.num_turns}`);
      if (msg.subtype !== "success") {
        yield { type: "error", message: msg.errors.join("; ") || msg.subtype };
      } else if (msg.is_error) {
        yield { type: "error", message: msg.result };
      }
      yield { type: "done" };
    }
  }
}
