import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineBuiltin, seedBuiltins } from "../connectors/builtin.js";
import { listAudit } from "../memory/audit.js";
import { addMessage, createConversation, listMessages } from "../memory/conversations.js";
import { createTask, getTask } from "../memory/tasks.js";
import { createSchedule, updateSchedule } from "../memory/schedules.js";
import { fridayToolList } from "./tools.js";

const runs = { send: 0, boom: 0 };

beforeAll(() => {
  defineBuiltin({
    name: "tc-fake", scenario: "两步同意测试", roles: [], binaries: [],
    ops: [
      { name: "get", description: "读", input: {}, level: "read", run: async () => ({ text: "读到了" }) },
      { name: "send", description: "发", input: { a: z.number().optional() }, level: "irreversible", run: async () => { runs.send++; return { text: "发了" }; } },
      { name: "boom", description: "炸", input: {}, level: "read", run: async () => { runs.boom++; throw new Error("连不上"); } },
    ],
  });
  seedBuiltins();
});

beforeEach(() => {
  runs.send = 0;
  runs.boom = 0;
});

const callIn = async (conv: string | undefined, name: string, args: Record<string, unknown>) => {
  const t = fridayToolList(conv).find((x) => x.name === name)!;
  return ((await t.handler(args as never, {})).content[0] as { text: string }).text;
};
const said = (c: string, content: string) => addMessage(c, { role: "user", kind: "ask", content });

describe("tool_describe / tool_call", () => {
  it("tool_describe 列操作", async () => {
    const out = await callIn(createConversation().id, "tool_describe", { tool: "tc-fake" });
    expect(out).toContain("send（irreversible）");
  });

  it("read 直接返回结果", async () => {
    const c = createConversation().id;
    said(c, "读一下");
    expect(await callIn(c, "tool_call", { tool: "tc-fake", op: "get", args: {} })).toBe("读到了");
  });

  it("抛错不往上抛：没调成", async () => {
    const c = createConversation().id;
    expect(await callIn(c, "tool_call", { tool: "tc-fake", op: "boom", args: {} })).toBe("没调成：连不上");
  });

  it("两步同意：同一轮连调两次不执行", async () => {
    const c = createConversation().id;
    said(c, "执行");
    const a = await callIn(c, "tool_call", { tool: "tc-fake", op: "send", args: { a: 1 } });
    const b = await callIn(c, "tool_call", { tool: "tc-fake", op: "send", args: { a: 1 } });
    expect(runs.send).toBe(0);
    for (const s of [a, b]) {
      expect(s).toContain("撤不回");
      expect(s).toContain("「执行」");
    }
  });

  it("两步同意：参数变了要重问", async () => {
    const c = createConversation().id;
    said(c, "帮我发一下");
    await callIn(c, "tool_call", { tool: "tc-fake", op: "send", args: { a: 1 } });
    said(c, "执行");
    const out = await callIn(c, "tool_call", { tool: "tc-fake", op: "send", args: { a: 2 } });
    expect(runs.send).toBe(0);
    expect(out).toContain("「执行」");
  });

  it("两步同意：新的一句「执行」后执行", async () => {
    const c = createConversation().id;
    said(c, "帮我发一下");
    await callIn(c, "tool_call", { tool: "tc-fake", op: "send", args: { a: 1 } });
    said(c, "执行");
    expect(await callIn(c, "tool_call", { tool: "tc-fake", op: "send", args: { a: 1 } })).toBe("发了");
    expect(runs.send).toBe(1);
    const ev = listAudit({ limit: 1 })[0]!;
    expect(ev.evidence).toMatchObject({ caller: "user", quote: "执行" });
  });

  it("两步同意：同意词不对不执行", async () => {
    const c = createConversation().id;
    said(c, "帮我发一下");
    await callIn(c, "tool_call", { tool: "tc-fake", op: "send", args: {} });
    said(c, "执行吗？");
    await callIn(c, "tool_call", { tool: "tc-fake", op: "send", args: {} });
    expect(runs.send).toBe(0);
  });

  it("句首 #N 点名任务：不可逆挂到那条任务上", async () => {
    const c = createConversation().id;
    const t = createTask({ title: "发通知", kind: "code", source: {}, status: "processing" });
    said(c, `#${t.seq} 把通知发了`);
    const out = await callIn(c, "tool_call", { tool: "tc-fake", op: "send", args: { a: 1 } });
    expect(out).toBe(`已挂待审 #${t.seq}：执行 tc-fake.send，等用户点头`);
    expect(getTask(t.id)!.pending!.some((p) => p.type === "tool_call")).toBe(true);
    expect(runs.send).toBe(0);
    const run = listMessages(c).find((m) => m.kind === "run")!;
    expect(run.content).toBe(`→ #${t.seq} 发通知：挂了待审：执行 tc-fake.send`);
    expect(run.taskIds).toEqual([t.id]);
  });

  it("句首 #N 点名任务：只读执行完也留痕", async () => {
    const c = createConversation().id;
    const t = createTask({ title: "查一下", kind: "code", source: {}, status: "processing" });
    said(c, `#${t.seq} 看看`);
    expect(await callIn(c, "tool_call", { tool: "tc-fake", op: "get", args: {} })).toBe("读到了");
    const run = listMessages(c).find((m) => m.kind === "run")!;
    expect(run.content).toBe(`→ #${t.seq} 查一下：执行了 tc-fake.get`);
    expect(run.taskIds).toEqual([t.id]);
  });

  it("定时会话不执行不可逆", async () => {
    const c = createConversation().id;
    updateSchedule(createSchedule({ title: "s", cron: "0 10 * * *", executor: "friday", prompt: "x" }).id, { conversationId: c });
    said(c, "执行");
    expect(await callIn(c, "tool_call", { tool: "tc-fake", op: "send", args: {} })).toBe("定时任务里不能执行不可逆操作，等用户回来。");
    expect(runs.send).toBe(0);
  });
});
