import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpError, callTool, mcpEndpoint, mcpServers, parseRpcBody } from "./mcp.js";

let server: Server;
let file = "";
let mode: "json" | "sse" | "error" | "slow" = "json";

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body) as { id?: number; method: string };
      if (msg.method === "notifications/initialized") return void res.writeHead(202).end();
      if (msg.method === "initialize") return void res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s1" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
      if (mode === "slow") return;
      const result = mode === "error" ? { isError: true, content: [{ type: "text", text: "不行" }] } : { content: [{ type: "text", text: "ok:" + req.headers["mcp-session-id"] }] };
      const payload = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result });
      if (mode === "sse") res.writeHead(200, { "content-type": "text/event-stream" }).end(`event: message\ndata: ${payload}\n\n`);
      else res.writeHead(200, { "content-type": "application/json" }).end(payload);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  file = join(mkdtempSync(join(tmpdir(), "mcp-")), "claude.json");
  writeFileSync(file, JSON.stringify({ mcpServers: { fake: { type: "http", url: `http://127.0.0.1:${port}/mcp`, headers: { authorization: "x" } }, local: { command: "node" } } }));
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe("http MCP 客户端", () => {
  it("列出 server，标出是不是 http", () => {
    expect(mcpServers(file)).toEqual([{ name: "fake", http: true }, { name: "local", http: false }]);
  });
  it("stdio 和不存在的拒掉", () => {
    expect(() => mcpEndpoint("local", file)).toThrow(/http/);
    expect(() => mcpEndpoint("nope", file)).toThrow(/没有/);
  });
  it("JSON 响应，带上 session id", async () => {
    mode = "json";
    expect(await callTool("fake", "t", {}, { file })).toEqual({ text: "ok:s1", blocks: ["ok:s1"], isError: false });
  });
  it("SSE 响应", async () => {
    mode = "sse";
    expect((await callTool("fake", "t", {}, { file })).text).toBe("ok:s1");
  });
  it("isError 透传", async () => {
    mode = "error";
    expect(await callTool("fake", "t", {}, { file })).toEqual({ text: "不行", blocks: ["不行"], isError: true });
  });
  it("超时报错", async () => {
    mode = "slow";
    await expect(callTool("fake", "t", {}, { file, timeoutMs: 300 })).rejects.toThrow(/没响应/);
  }, 5000);
});

describe("parseRpcBody", () => {
  it("JSON 和 SSE 两种响应体都能解析", () => {
    expect(parseRpcBody('{"jsonrpc":"2.0","id":1,"result":{"a":1}}').result).toEqual({ a: 1 });
    expect(parseRpcBody('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"a":2}}\n\n').result).toEqual({ a: 2 });
    expect(() => parseRpcBody("")).toThrow(McpError);
  });
  it("乱码不说「空响应」，label 用在文案里", () => {
    expect(() => parseRpcBody("{oops", "OKR 平台")).toThrow("OKR 平台返回的内容解析不了：{oops");
    expect(() => parseRpcBody("data: {oops")).toThrow("解析不了");
    expect(() => parseRpcBody("event: message")).toThrow("解析不了：event: message");
    expect(() => parseRpcBody("   ", "OKR 平台")).toThrow("OKR 平台返回了空响应");
  });
});
