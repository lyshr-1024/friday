import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getTool } from "../../connectors/registry.js";
import { OkrError, enrichOkr, myKRs, registerOkr, submit } from "./okr.js";

const appr = { kind: "friday" as const, why: "t", approvedPendingId: "p1" };

const dir = mkdtempSync(join(tmpdir(), "okr-"));
const cfg = (v: unknown) => {
  const f = join(dir, `${Math.random()}.json`);
  writeFileSync(f, JSON.stringify(v));
  process.env.FRIDAY_CLAUDE_JSON = f;
  return f;
};
const good = () => {
  const f = cfg({ mcpServers: { okr: { type: "http", url: "https://okr.test/mcp", headers: { "x-authorization": "tok" } } } });
  registerOkr();
  return f;
};

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
  it("配置里没有 okr 就什么都不登记", () => {
    cfg({ mcpServers: {} });
    expect(registerOkr()).toBe(false);
  });

  it("登记周报用到的几个操作：读 read，建 / 删周报 irreversible；已登记不重复", () => {
    good();
    expect(getTool("okr")).toMatchObject({ transport: "mcp_http", connection: "okr", scenario: "OKR 周报起草与提交", enabled: true });
    expect(Object.fromEntries(getTool("okr")!.ops.map((o) => [o.name, o.level]))).toEqual({
      get_current_user: "read", list_user_okr_hierarchy: "read", list_progress_reports: "read",
      create_progress_report: "irreversible", delete_progress_report: "irreversible",
    });
    expect(registerOkr()).toBe(false);
  });

  it("enrichOkr 从服务端补说明和参数模式，不动定级", async () => {
    good();
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      const msg = JSON.parse(String(init.body)) as { id?: number; method: string };
      if (msg.id === undefined) return new Response(null, { status: 202 });
      const result = msg.method === "tools/list" ? { tools: [{ name: "get_current_user", description: "当前用户", inputSchema: { type: "object" } }] } : {};
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    }));
    await enrichOkr();
    const op = getTool("okr")!.ops.find((o) => o.name === "get_current_user")!;
    expect(op).toMatchObject({ description: "当前用户", inputSchema: { type: "object" }, level: "read" });
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
    await expect(myKRs()).rejects.toThrow(OkrError);
  });

  it("工具报错（isError）要抛出来，不当成成功", async () => {
    good();
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      const msg = JSON.parse(String(init.body)) as { id?: number; method: string };
      if (msg.id === undefined) return new Response(null, { status: 202 });
      const result = msg.method === "initialize" ? {} : { isError: true, content: [{ type: "text", text: "INVALID_ARGUMENT: week" }] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    }));
    await expect(submit({ objectId: 2, week: "2026W0921-0927", quarter: "2026Q3", content: "x", pct: 50 }, appr)).rejects.toThrow("INVALID_ARGUMENT");
  });

  it("submit 返回 report id；响应里没有 id 就回查这周", async () => {
    good();
    vi.stubGlobal("fetch", rpcFetch((name) => (name === "create_progress_report" ? { ok: true } : name === "get_current_user" ? { id: 9, name: "me" } : { reports: [{ id: 77, object_id: 2, week: "2026W0921-0927", content: "x", progress_percentage: 50 }] })));
    expect(await submit({ objectId: 2, week: "2026W0921-0927", quarter: "2026Q3", content: "x", pct: 50 }, appr)).toBe(77);
  });

  it("网络层的错也翻成 OkrError：连不上、超时、响应体解析不了", async () => {
    good();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect(myKRs()).rejects.toThrow(OkrError);
    await expect(myKRs()).rejects.toThrow("fetch failed");

    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); }));
    await expect(myKRs()).rejects.toThrow("15 秒没响应");

    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>502 Bad Gateway</html>")));
    await expect(myKRs()).rejects.toThrow(OkrError);
    await expect(myKRs()).rejects.toThrow("<html>502 Bad Gateway</html>");
  });

  it("多段文本只解析第一段 JSON（后面的说明文字不能把解析弄坏）", async () => {
    good();
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      const msg = JSON.parse(String(init.body)) as { id?: number; method: string };
      if (msg.id === undefined) return new Response(null, { status: 202 });
      const result = msg.method === "initialize" ? {} : { content: [{ type: "text", text: JSON.stringify({ root: { objects: [{ id: 1, name: "O", label: "O", parent_id: 0, quarter: "q" }, { id: 2, name: "KR", label: "KR", parent_id: 1, quarter: "q" }] } }) }, { type: "text", text: "共 2 条" }] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    }));
    expect(await myKRs()).toEqual([{ id: 2, name: "KR", objective: "O", quarter: "q" }]);
  });
});
