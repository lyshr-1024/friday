import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OkrError, myKRs, okrEndpoint, parseRpcBody, submit } from "./okr.js";

const dir = mkdtempSync(join(tmpdir(), "okr-"));
const cfg = (v: unknown) => {
  const f = join(dir, `${Math.random()}.json`);
  writeFileSync(f, JSON.stringify(v));
  process.env.FRIDAY_CLAUDE_JSON = f;
  return f;
};
const good = () => cfg({ mcpServers: { okr: { type: "http", url: "https://okr.test/mcp", headers: { "x-authorization": "tok" } } } });

function rpcFetch(tool: (name: string, args: Record<string, unknown>) => unknown) {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const msg = JSON.parse(String(init.body)) as { id?: number; method: string; params: { name: string; arguments: Record<string, unknown> } };
    if (msg.id === undefined) return new Response(null, { status: 202 });
    if (msg.method === "initialize") return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }), { headers: { "mcp-session-id": "s1" } });
    const out = tool(msg.params.name, msg.params.arguments);
    return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(out) }] } })}\n\n`);
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("OKR 客户端", () => {
  it("配置缺失时说清楚缺什么", () => {
    const f = cfg({ mcpServers: {} });
    expect(() => okrEndpoint()).toThrow(OkrError);
    expect(() => okrEndpoint()).toThrow(`${f} 里没有 mcpServers.okr`);
  });

  it("JSON 和 SSE 两种响应体都能解析", () => {
    expect(parseRpcBody('{"jsonrpc":"2.0","id":1,"result":{"a":1}}').result).toEqual({ a: 1 });
    expect(parseRpcBody('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"a":2}}\n\n').result).toEqual({ a: 2 });
    expect(() => parseRpcBody("")).toThrow(OkrError);
  });

  it("myKRs 只要 KR，带上父 O 的名字；请求带配置里的 header 和 session", async () => {
    good();
    const f = rpcFetch(() => ({ root: { objects: [
      { id: 1, name: "O 一", label: "O", parent_id: 0, quarter: "2026Q3" },
      { id: 2, name: "KR 甲", label: "KR", parent_id: 1, quarter: "2026Q3" },
    ] } }));
    vi.stubGlobal("fetch", f);
    expect(await myKRs()).toEqual([{ id: 2, name: "KR 甲", objective: "O 一", quarter: "2026Q3" }]);
    const last = f.mock.calls.at(-1)![1] as RequestInit;
    expect((last.headers as Record<string, string>)["x-authorization"]).toBe("tok");
    expect((last.headers as Record<string, string>)["mcp-session-id"]).toBe("s1");
  });

  it("401 翻成人话", async () => {
    good();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 401 })));
    await expect(myKRs()).rejects.toThrow("OKR 平台拒绝了 token");
  });

  it("工具报错（isError）要抛出来，不当成成功", async () => {
    good();
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      const msg = JSON.parse(String(init.body)) as { id?: number; method: string };
      if (msg.id === undefined) return new Response(null, { status: 202 });
      const result = msg.method === "initialize" ? {} : { isError: true, content: [{ type: "text", text: "INVALID_ARGUMENT: week" }] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    }));
    await expect(submit({ objectId: 2, week: "2026W0921-0927", quarter: "2026Q3", content: "x", pct: 50 })).rejects.toThrow("INVALID_ARGUMENT");
  });

  it("submit 返回 report id；响应里没有 id 就回查这周", async () => {
    good();
    vi.stubGlobal("fetch", rpcFetch((name) => (name === "create_progress_report" ? { ok: true } : name === "get_current_user" ? { id: 9, name: "me" } : { reports: [{ id: 77, object_id: 2, week: "2026W0921-0927", content: "x", progress_percentage: 50 }] })));
    expect(await submit({ objectId: 2, week: "2026W0921-0927", quarter: "2026Q3", content: "x", pct: 50 })).toBe(77);
  });

  it("网络层的错也翻成 OkrError：连不上、超时、响应体解析不了", async () => {
    good();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect(myKRs()).rejects.toThrow(OkrError);
    await expect(myKRs()).rejects.toThrow("连不上 OKR 平台：fetch failed");

    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); }));
    await expect(myKRs()).rejects.toThrow("OKR 平台 15 秒没响应");

    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>502 Bad Gateway</html>")));
    await expect(myKRs()).rejects.toThrow(OkrError);
    await expect(myKRs()).rejects.toThrow("OKR 平台返回的内容解析不了：<html>502 Bad Gateway</html>");
  });

  it("响应体不是空而是乱码时不说「空响应」", () => {
    expect(() => parseRpcBody("{oops")).toThrow("OKR 平台返回的内容解析不了：{oops");
    expect(() => parseRpcBody("data: {oops")).toThrow("OKR 平台返回的内容解析不了");
    expect(() => parseRpcBody("event: message")).toThrow("OKR 平台返回的内容解析不了：event: message");
    expect(() => parseRpcBody("   ")).toThrow("OKR 平台返回了空响应");
  });
});
