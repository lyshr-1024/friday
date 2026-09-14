import { Hono } from "hono";
import { BRIDGE_TOOLS, callBridge } from "../agent/bridge.js";
import { getJob } from "../memory/jobs.js";

interface Rpc {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const ok = (id: Rpc["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const fail = (id: Rpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

/** 最小 MCP Streamable HTTP：一个 POST 一条 JSON-RPC，只实现终端 Claude Code 用到的几个方法，无状态。 */
export async function handleRpc(jobId: string, msg: Rpc): Promise<unknown> {
  if (msg.id === undefined) return undefined;
  switch (msg.method) {
    case "initialize":
      return ok(msg.id, {
        protocolVersion: (msg.params?.protocolVersion as string | undefined) ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "friday", version: "0.1.0" },
      });
    case "ping":
      return ok(msg.id, {});
    case "tools/list":
      return ok(msg.id, { tools: BRIDGE_TOOLS });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const args = (msg.params?.arguments as Record<string, unknown> | undefined) ?? {};
      const r = await callBridge(jobId, name, args);
      return ok(msg.id, { content: [{ type: "text", text: r.text }], ...(r.isError ? { isError: true } : {}) });
    }
    default:
      return fail(msg.id, -32601, `不支持的方法：${msg.method}`);
  }
}

export const mcp = new Hono()
  .post("/mcp/:jobId", async (c) => {
    const jobId = c.req.param("jobId");
    if (!getJob(jobId)) return c.json(fail(null, -32000, "任务不存在"), 404);
    const body = (await c.req.json().catch(() => null)) as Rpc | Rpc[] | null;
    if (!body || typeof body !== "object") return c.json(fail(null, -32700, "不是合法 JSON"), 400);
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => handleRpc(jobId, m)))).filter(Boolean);
      return out.length ? c.json(out) : c.body(null, 202);
    }
    const res = await handleRpc(jobId, body);
    return res === undefined ? c.body(null, 202) : c.json(res);
  })
  .get("/mcp/:jobId", (c) => c.json({ error: "这个 MCP 端点只接 POST" }, 405))
  .delete("/mcp/:jobId", (c) => c.body(null, 200));
