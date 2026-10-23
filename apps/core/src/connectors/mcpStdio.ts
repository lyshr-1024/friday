import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpError, servers, type McpToolInfo } from "./mcp.js";

const TIMEOUT_MS = 15_000;

async function withClient<T>(server: string, file: string | undefined, fn: (c: Client) => Promise<T>): Promise<T> {
  const s = servers(file)[server];
  if (!s) throw new McpError(`没有 mcpServers.${server}`);
  if (!s.command) throw new McpError(`${server} 不是 stdio 类型的 MCP`);
  const transport = new StdioClientTransport({ command: s.command, args: s.args ?? [], env: { ...(process.env as Record<string, string>), ...s.env }, stderr: "ignore" });
  const client = new Client({ name: "friday", version: "1" });
  try {
    await client.connect(transport, { timeout: TIMEOUT_MS });
    return await fn(client);
  } catch (e) {
    if (e instanceof McpError) throw e;
    throw new McpError(`${server} 调用失败：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await client.close().catch(() => {});
  }
}

export function listStdioTools(server: string, file?: string): Promise<McpToolInfo[]> {
  return withClient(server, file, async (c) =>
    (await c.listTools(undefined, { timeout: TIMEOUT_MS })).tools.map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema as Record<string, unknown> })),
  );
}

export function callStdio(server: string, tool: string, args: Record<string, unknown>, file?: string): Promise<{ text: string; isError: boolean }> {
  return withClient(server, file, async (c) => {
    const r = await c.callTool({ name: tool, arguments: args }, undefined, { timeout: TIMEOUT_MS });
    const text = ((r.content as Array<{ type: string; text?: string }> | undefined) ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
    return { text, isError: Boolean(r.isError) };
  });
}
