import { beforeEach, describe, expect, it, vi } from "vitest";
import { addMessage, createConversation } from "../memory/conversations.js";
import { listAudit, undoPlan } from "../memory/audit.js";
import { getTool, removeTool, saveTool, usableOps } from "../connectors/registry.js";
import { invokeTool } from "../connectors/invoke.js";
import { createSchedule, updateSchedule } from "../memory/schedules.js";
import { seedBuiltins } from "../connectors/builtin.js";

const mcp = vi.hoisted(() => ({ ops: ["a", "b"] }));
vi.mock("../connectors/mcp.js", async (orig) => {
  const m = await orig<typeof import("../connectors/mcp.js")>();
  return { ...m, listTools: vi.fn(async () => mcp.ops.map((name) => ({ name, description: `op ${name}`, inputSchema: {} }))) };
});
import { fridayToolList } from "./tools.js";

const callIn = async (conv: string | undefined, name: string, args: Record<string, unknown>) => {
  const t = fridayToolList(conv).find((x) => x.name === name)!;
  return ((await t.handler(args as never, {})).content[0] as { text: string }).text;
};
const said = (c: string, content: string) => addMessage(c, { role: "user", kind: "ask", content });
const model = { kind: "model" as const, why: "测试" };

const reg = (name: string, ops: Array<{ name: string; level: "read" | "reversible" | "irreversible" }>, transport = "cli") =>
  callIn(undefined, "tool_register", {
    name, transport, connection: transport === "cli" ? "echo" : "srv", scenario: "测试",
    ops: ops.map((o) => ({ ...o, description: "d", inputSchema: {}, ...(transport === "cli" ? { template: ["x"] } : {}) })),
  });

beforeEach(() => seedBuiltins());

describe("工具登记会话工具", () => {
  it("register 写草稿且草稿不可调用", async () => {
    await reg("ta-draft", [{ name: "get_x", level: "read" }]);
    expect(getTool("ta-draft")).toMatchObject({ draft: true, enabled: false });
    expect((await invokeTool(model, "ta-draft", "get_x", {})).kind).toBe("refused");
  });

  it("提议 read 但名字是写操作的改成 irreversible", async () => {
    await reg("ta-lvl", [{ name: "deployApi", level: "read" }, { name: "listApi", level: "read" }]);
    const ops = getTool("ta-lvl")!.ops;
    expect(ops.find((o) => o.name === "deployApi")!.level).toBe("irreversible");
    expect(ops.find((o) => o.name === "listApi")!.level).toBe("read");
  });

  it("没给 undo 的 reversible 改 irreversible", async () => {
    await reg("ta-rev", [{ name: "setX", level: "reversible" }]);
    expect(getTool("ta-rev")!.ops[0]!.level).toBe("irreversible");
  });

  it("与 builtin 重名拒绝", async () => {
    const out = await reg("slack", [{ name: "get_x", level: "read" }]);
    expect(out).toContain("已有");
    expect(getTool("slack")!.transport).toBe("builtin");
  });

  it("confirm 两步同意后启用", async () => {
    await reg("ta-conf", [{ name: "get_x", level: "read" }]);
    const c = createConversation().id;
    said(c, "接好了吧");
    const a = await callIn(c, "tool_update", { name: "ta-conf", confirm: true });
    expect(a).toContain("「确认」");
    expect(getTool("ta-conf")!.draft).toBe(true);
    const b = await callIn(c, "tool_update", { name: "ta-conf", confirm: true });
    expect(getTool("ta-conf")!.draft).toBe(true);
    expect(b).toContain("「确认」");
    said(c, "确认");
    await callIn(c, "tool_update", { name: "ta-conf", confirm: true });
    expect(getTool("ta-conf")).toMatchObject({ enabled: true, draft: false });
  });

  it("撤销 register 删掉登记", async () => {
    const c = createConversation().id;
    said(c, "接一下 ta-undo");
    await callIn(c, "tool_register", { name: "ta-undo", transport: "cli", connection: "echo", scenario: "t", ops: [{ name: "get_x", description: "d", inputSchema: {}, level: "read", template: ["x"] }] });
    const e = listAudit({}).find((x) => x.action === "tool_registered")!;
    expect(e.evidence.quote).toBe("接一下 ta-undo");
    const plan = undoPlan(e.id);
    expect(plan).toMatchObject({ kind: "restore_tool", name: "ta-undo", before: null });
    if (plan?.kind === "restore_tool" && plan.before === null) removeTool(plan.name);
    expect(getTool("ta-undo")).toBeUndefined();
  });

  it("刷新后新操作默认不可用、消失的操作被移除", async () => {
    mcp.ops = ["get_a", "get_b"];
    await reg("ta-mcp", [{ name: "get_a", level: "read" }, { name: "get_b", level: "read" }], "mcp_http");
    saveTool({ ...getTool("ta-mcp")!, draft: false, enabled: true });
    mcp.ops = ["get_b", "get_c"];
    await callIn(undefined, "tool_update", { name: "ta-mcp", refresh: true });
    const ops = getTool("ta-mcp")!.ops;
    expect(ops.map((o) => o.name).sort()).toEqual(["get_b", "get_c"]);
    expect(ops.find((o) => o.name === "get_b")!.level).toBe("read");
    expect(ops.find((o) => o.name === "get_c")!.level).toBeNull();
    const r = await invokeTool(model, "ta-mcp", "get_a", {});
    expect(r).toMatchObject({ kind: "refused" });
    expect((r as { why: string }).why).toContain("没有操作 get_a");
    expect(usableOps(getTool("ta-mcp")!).map((o) => o.name)).not.toContain("get_c");
  });

  it("定时会话里写类工具被拒", async () => {
    const conv = createConversation().id;
    const sch = createSchedule({ title: "cfg", cron: "0 10 * * *", executor: "friday", prompt: "p" });
    updateSchedule(sch.id, { conversationId: conv });
    const msg = "定时任务里不能改 Friday 的配置，等用户回来。";
    expect(await callIn(conv, "tool_register", { name: "ta-sch", transport: "cli", connection: "echo", scenario: "t", ops: [{ name: "get_x", description: "d", inputSchema: {}, level: "read" }] })).toBe(msg);
    expect(await callIn(conv, "tool_update", { name: "ta-conf", enabled: false })).toBe(msg);
    expect(await callIn(conv, "tool_remove", { name: "ta-conf" })).toBe(msg);
    expect(getTool("ta-sch")).toBeUndefined();
  });

  it("写操作名不能定成 read，即使同意过", async () => {
    await reg("ta-low", [{ name: "deployApi", level: "irreversible" }]);
    saveTool({ ...getTool("ta-low")!, draft: false, enabled: true });
    const c = createConversation().id;
    said(c, "确认");
    for (let i = 0; i < 2; i++) expect(await callIn(c, "tool_update", { name: "ta-low", levels: { deployApi: "read" } })).toContain("不能定成 read");
    expect(getTool("ta-low")!.ops[0]!.level).toBe("irreversible");
  });

  it("读名字的操作调低到 read 需同意，同意后 levelBy 为 user；调高不需要", async () => {
    await reg("ta-low2", [{ name: "get_y", level: "irreversible" }]);
    saveTool({ ...getTool("ta-low2")!, draft: false, enabled: true });
    const c = createConversation().id;
    said(c, "get_y 其实是只读的");
    await callIn(c, "tool_update", { name: "ta-low2", levels: { get_y: "read" } });
    expect(getTool("ta-low2")!.ops[0]!.level).toBe("irreversible");
    said(c, "确认");
    await callIn(c, "tool_update", { name: "ta-low2", levels: { get_y: "read" } });
    expect(getTool("ta-low2")!.ops[0]).toMatchObject({ level: "read", levelBy: "user" });
    await callIn(undefined, "tool_update", { name: "ta-low2", levels: { get_y: "irreversible" } });
    expect(getTool("ta-low2")!.ops[0]!.level).toBe("irreversible");
  });

  it("confirm 同意绑定当时展示的内容：参数变了重问", async () => {
    await reg("ta-bind", [{ name: "get_a", level: "read" }, { name: "get_b", level: "read" }]);
    const c = createConversation().id;
    said(c, "好");
    await callIn(c, "tool_update", { name: "ta-bind", confirm: true });
    said(c, "确认");
    const out = await callIn(c, "tool_update", { name: "ta-bind", confirm: true, levels: { get_a: "irreversible" } });
    expect(out).toContain("「确认」");
    expect(getTool("ta-bind")!.draft).toBe(true);
  });

  it("tool_discover 拒绝奇怪的名字", async () => {
    const t = fridayToolList(undefined).find((x) => x.name === "tool_discover")!;
    const bad = ["a b", "x;rm", "$(id)"];
    const { z } = await import("zod");
    const schema = z.object(t.inputSchema as never);
    for (const name of bad) expect(schema.safeParse({ name }).success).toBe(false);
    expect(schema.safeParse({ name: "lark-cli" }).success).toBe(true);
  });

  it("草稿不能直接 enabled", async () => {
    await reg("ta-en", [{ name: "get_x", level: "read" }]);
    expect(await callIn(undefined, "tool_update", { name: "ta-en", enabled: true })).toContain("草稿");
    expect(getTool("ta-en")).toMatchObject({ draft: true, enabled: false });
  });
});
