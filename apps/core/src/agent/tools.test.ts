import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { fridayToolList, fridayTools } from "./tools.js";
import { addFeatureHistory, createFeature, writeKnowledge } from "../memory/features.js";

const call = async (name: string, args: Record<string, unknown>) => {
  const t = fridayToolList().find((x) => x.name === name)!;
  return ((await t.handler(args as never, {})).content[0] as { text: string }).text;
};

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

  it("memory_read knowledge:<项目> 读整份，没有时列出有知识库的项目", async () => {
    const f = createFeature("p-tk", { name: "对账单", where: "资金 › 对账" }, "task");
    writeKnowledge("p-tk");
    expect(await call("memory_read", { file: "knowledge:p-tk" })).toMatch(/^<untrusted source="knowledge">[\s\S]*## 对账单[\s\S]*<\/untrusted>$/);
    const none = await call("memory_read", { file: "knowledge:p-none" });
    expect(none).toContain("没有 p-none 的知识库");
    expect(none).toContain("p-tk");
    expect(f.id).toBeTruthy();
  });

  it("knowledge_search 返回命中条目和最近一条历史", async () => {
    const f = createFeature("p-ks", { name: "优惠券", where: "营销 › 券", paths: ["src/coupon"], routes: ["/coupon"], summary: "发券核销" }, "task");
    addFeatureHistory({ featureId: f.id, at: "2026-10-01T00:00:00Z", what: "加了过期提醒", files: [] });
    const out = await call("knowledge_search", { project: "p-ks", query: "优惠券怎么核销" });
    for (const s of ["优惠券", "营销 › 券", "src/coupon", "/coupon", "发券核销", "加了过期提醒"]) expect(out).toContain(s);
    expect(await call("knowledge_search", { project: "p-ks", query: "毫不相干" })).toContain("没有");
  });
});

describe("run_claude", () => {
  it("没给任务：不开终端，指去项目页", async () => {
    const out = await call("run_claude", { project: "whatever" });
    expect(out).toBe("没说要做什么。想自己在项目里干活去项目页开 Claude；要 Friday 做就说做什么。");
  });
});
