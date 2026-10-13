import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { fridayToolList, fridayTools } from "./tools.js";

describe("Friday MCP server", () => {
  // tools/list 一次返回全部工具，一个 schema 转不了整个列表就失败，会话里一个工具都没有（2026-10-13 z.record 踩过）
  it("tools/list 能列出全部工具", async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await fridayTools().instance.connect(a);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(b);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(fridayToolList().map((t) => t.name).sort());
    await client.close();
  });
});
