import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export class McpError extends Error {}
export type McpEndpoint = { url: string; headers: Record<string, string> };
type Conf = { type?: string; url?: string; command?: string; headers?: Record<string, string> };

const claudeJson = (file?: string) => file ?? (process.env.FRIDAY_CLAUDE_JSON || join(homedir(), ".claude.json"));

function servers(file?: string): Record<string, Conf> {
  const f = claudeJson(file);
  try {
    return (JSON.parse(readFileSync(f, "utf8")) as { mcpServers?: Record<string, Conf> }).mcpServers ?? {};
  } catch {
    throw new McpError(`读不到 ${f}`);
  }
}

export function mcpServers(file?: string): Array<{ name: string; http: boolean }> {
  return Object.entries(servers(file)).map(([name, c]) => ({ name, http: Boolean(c.url) }));
}

// 凭证是 Claude Code 的 MCP 配置，Friday 不另存一份：用户在那边换了 token 这边自动跟上
export function mcpEndpoint(server: string, file?: string): McpEndpoint {
  const s = servers(file)[server];
  if (!s) throw new McpError(`${claudeJson(file)} 里没有 mcpServers.${server}`);
  if (!s.url) throw new McpError(`${server} 不是 http 类型的 MCP，Friday 只能直连 http 的`);
  return { url: s.url, headers: s.headers ?? {} };
}

export function parseRpcBody(body: string, label = "MCP"): { result?: any; error?: { message: string } } {
  const t = body.trim();
  if (!t) throw new McpError(`${label}返回了空响应`);
  const data = t.startsWith("{") ? t : t.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean).at(-1);
  try {
    return JSON.parse(data ?? "");
  } catch {
    throw new McpError(`${label}返回的内容解析不了：${t.slice(0, 120)}`);
  }
}

let seq = 0;

async function post(ep: McpEndpoint, msg: Record<string, unknown>, label: string, timeoutMs: number, session?: string): Promise<{ res: Response; body: string }> {
  let res: Response;
  let body: string;
  try {
    res = await fetch(ep.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(session ? { "mcp-session-id": session } : {}), ...ep.headers },
      body: JSON.stringify({ jsonrpc: "2.0", ...msg }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    body = await res.text();
  } catch (e) {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) throw new McpError(`${label} ${Math.round(timeoutMs / 1000)} 秒没响应`);
    throw new McpError(`连不上 ${label}：${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status === 401 || res.status === 403) throw new McpError(`${label}拒绝了 token，去 Claude Code 里重新配一下这个 MCP`);
  if (!res.ok && res.status !== 202) throw new McpError(`${label}返回 ${res.status}`);
  return { res, body };
}

export async function callTool(
  server: string,
  tool: string,
  args: Record<string, unknown>,
  opts: { file?: string; label?: string; timeoutMs?: number } = {},
): Promise<{ text: string; isError: boolean }> {
  const label = opts.label ?? server;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const ep = mcpEndpoint(server, opts.file);
  const init = await post(ep, { id: ++seq, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "friday", version: "1" } } }, label, timeoutMs);
  const session = init.res.headers.get("mcp-session-id") ?? undefined;
  parseRpcBody(init.body, label);
  await post(ep, { method: "notifications/initialized" }, label, timeoutMs, session);
  const msg = parseRpcBody((await post(ep, { id: ++seq, method: "tools/call", params: { name: tool, arguments: args } }, label, timeoutMs, session)).body, label);
  if (msg.error) throw new McpError(`${tool} 失败：${msg.error.message}`);
  const text = (msg.result?.content as Array<{ type: string; text?: string }> | undefined)?.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n") ?? "";
  return { text, isError: Boolean(msg.result?.isError) };
}
