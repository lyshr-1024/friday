import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources";
import { FRIDAY_TOOL_NAMES, fridayTools } from "./tools.js";
import { addUsage } from "../memory/usage.js";

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
  /** 放行哪些 skill。给数组时未列出的 skill 不进上下文清单，也调不动；"all" 全放。 */
  skillList?: string[] | "all";
  /** 当前会话 id，工具里用来把终端挂到正在讨论的任务上 */
  conversationId?: string;
  /** 只放行这几个内置工具（如 WebSearch / WebFetch），不挂 Friday 的 MCP 工具；给研究类后台任务用 */
  builtin?: string[];
  /** 这次调用算在哪个调用点名下（ask / triage / brief …），用量统计按它分组 */
  label?: string;
  /** 放行 WebSearch。只给用户直接对话的 /ask 和 HUD，后台小判断不需要上网 */
  web?: boolean;
  /** 一轮出结果：不挂工具、不思考。HUD 呼出实测 Sonnet 5 默认的 adaptive thinking 一项就占 10 秒 */
  oneShot?: boolean;
}

const SKILL_TOOLS = ["Skill", "Bash", "Read", "Glob", "Grep"];
// 读网页走 Friday 自己的 web_read（能读要登录的内网页面、给全文），WebFetch 只回模型摘要，不再多放一条路
const WEB_TOOLS = ["WebSearch"];

/** 只答一个 JSON 的小判断都用它：挂靠、查询分类、接哪段会话 */
export const SMALL_MODEL = "haiku";

/** 要读懂中文语境、写给人看的文字，用它 */
export const SONNET_MODEL = "sonnet";

/** Friday 自己拉起的无人值守运行不继承用户的 Claude Code 默认模型：2026-09-28 默认被切成 Fable 忘了切回，一次 6 分钟花了 $4.46。用别名：出新 Opus 时 Claude Code 自己跟上 */
export const HEADLESS_MODEL = "opus";

/** 带图片/文档时走流式输入：一条 SDKUserMessage 就结束。 */
async function* single(content: MessageParam["content"]): AsyncGenerator<SDKUserMessage> {
  yield { type: "user", message: { role: "user", content }, parent_tool_use_id: null };
}

export async function* askStream(prompt: string | MessageParam["content"], opts: AskOptions): AsyncGenerator<AskEvent> {
  const abortController = new AbortController();
  opts.signal?.addEventListener("abort", () => abortController.abort(), { once: true });

  const builtins = opts.builtin ?? [...(opts.skills ? SKILL_TOOLS : []), ...(opts.web ? WEB_TOOLS : [])];
  const q = query({
    prompt: typeof prompt === "string" ? prompt : single(prompt),
    options: {
      systemPrompt: opts.systemPrompt,
      cwd: opts.cwd,
      tools: builtins,
      ...(opts.builtin || opts.oneShot ? {} : { mcpServers: { friday: fridayTools(opts.conversationId) } }),
      allowedTools: opts.oneShot ? [] : (opts.builtin ?? [...FRIDAY_TOOL_NAMES, ...builtins]),
      maxTurns: opts.oneShot ? 1 : opts.builtin ? 20 : opts.skills ? 30 : 12,
      ...(opts.oneShot ? { thinking: { type: "disabled" as const } } : {}),
      includePartialMessages: true,
      persistSession: true,
      settingSources: opts.skills ? ["user"] : [],
      // Skill 模式要读用户的 ~/.claude，那会把他自己的 MCP server 一起带进来（实测 okr 一家挂 33 个
      // 工具）。Friday 只需要自己这台，这里挡掉除显式传入之外的全部 MCP 配置。
      strictMcpConfig: true,
      // 只放行用得上的 skill：全放会把本机每个 skill 的描述都塞进上下文（实测 51KB / 每轮）
      ...(opts.skills && opts.skillList ? { skills: opts.skillList === "all" ? ("all" as const) : opts.skillList } : {}),
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
      // modelUsage 在一次 query() 里是累计值，所以直接落这一条，不跨 result 相加
      addUsage(
        opts.label ?? "other",
        msg.num_turns,
        Object.entries(msg.modelUsage).map(([model, u]) => ({
          model: u.canonicalModel ?? model,
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cacheRead: u.cacheReadInputTokens,
          cacheWrite: u.cacheCreationInputTokens,
          costUsd: u.costUSD,
        })),
      );
      if (msg.subtype !== "success") {
        yield { type: "error", message: msg.errors.join("; ") || msg.subtype };
      } else if (msg.is_error) {
        yield { type: "error", message: msg.result };
      }
      yield { type: "done" };
    }
  }
}
