import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { runCli } = vi.hoisted(() => ({ runCli: vi.fn<(binary: string, argv: string[], timeoutMs?: number) => Promise<string>>() }));
vi.mock("./cli.js", async (orig) => ({ ...(await orig<typeof import("./cli.js")>()), runCli }));

import { listAudit, undoPlan } from "../memory/audit.js";
import { createTask, getTask } from "../memory/tasks.js";
import { defineBuiltin, seedBuiltins } from "./builtin.js";
import { executePending } from "../agent/pipeline.js";
import { tasks } from "../api/tasks.js";
import { invokeTool } from "./invoke.js";
import { getTool, saveTool } from "./registry.js";

const calls = { get: 0, flip: 0, send: 0 };
const model = { kind: "model" as const, why: "测试" };

beforeAll(() => {
  defineBuiltin({
    name: "fake", scenario: "测试用", roles: [], binaries: [],
    ops: [
      { name: "get", description: "读", input: { id: z.string().optional() }, level: "read", run: async () => { calls.get++; return { text: "got", value: { v: 1 } }; } },
      { name: "flip", description: "翻", input: {}, level: "reversible", run: async () => { calls.flip++; return { text: "flipped", undo: { kind: "delete_research", file: "x.md" } }; } },
      { name: "send", description: "发", input: {}, level: "irreversible", audit: "fake_sent", run: async () => { calls.send++; return { text: "sent", evidence: { ts: "1.2" } }; } },
    ],
  });
  seedBuiltins();
});

beforeEach(() => {
  calls.get = 0; calls.flip = 0; calls.send = 0;
  runCli.mockReset();
});

const latest = () => listAudit({ limit: 1 })[0]!;

describe("invokeTool", () => {
  it("未登记的工具 refused", async () => {
    expect(await invokeTool(model, "nope", "get", {})).toMatchObject({ kind: "refused" });
  });

  it("工具里已经没有的操作 refused", async () => {
    const r = await invokeTool(model, "fake", "gone", {});
    expect(r.kind).toBe("refused");
    expect(r.kind === "refused" && r.why).toContain("没有操作 gone");
  });

  it("未定级的操作 refused", async () => {
    const reg = getTool("fake")!;
    saveTool({ ...reg, ops: reg.ops.map((o) => (o.name === "get" ? { ...o, level: null } : o)) });
    try {
      const r = await invokeTool(model, "fake", "get", {});
      expect(r.kind).toBe("refused");
      expect(r.kind === "refused" && r.why).toContain("还没定级");
      expect(calls.get).toBe(0);
    } finally {
      seedBuiltins();
    }
  });

  it("builtin 的 reversible 不因没有 undo 说明降成 irreversible", () => {
    expect(getTool("fake")!.ops.find((o) => o.name === "flip")?.level).toBe("reversible");
  });

  it("seedBuiltins 保留已有的 enabled / projects", () => {
    const reg = getTool("fake")!;
    saveTool({ ...reg, enabled: false, projects: ["p1"] });
    seedBuiltins();
    expect(getTool("fake")).toMatchObject({ enabled: false, projects: ["p1"], draft: false });
    saveTool({ ...getTool("fake")!, enabled: true, projects: [] });
  });

  it("friday 调不可逆没带批准就抛", async () => {
    await expect(invokeTool({ kind: "friday", why: "x" }, "fake", "send", {})).rejects.toThrow("必须带已批准的待审动作");
    expect(calls.send).toBe(0);
  });

  it("friday 带批准能执行", async () => {
    const r = await invokeTool({ kind: "friday", why: "x", approvedPendingId: "p1" }, "fake", "send", {});
    expect(r).toMatchObject({ kind: "ok", text: "sent" });
    const ev = latest();
    expect(ev).toMatchObject({ risk: "irreversible", action: "fake_sent" });
    expect(ev.evidence).toMatchObject({ tool: "fake", op: "send", caller: "friday", ts: "1.2" });
  });

  it("model 有任务挂待审", async () => {
    const t = createTask({ title: "t", kind: "code", source: {}, status: "processing" });
    const r = await invokeTool({ ...model, taskId: t.id, conversationId: "c1" }, "fake", "send", { to: "a" });
    expect(r.kind).toBe("held");
    expect(getTask(t.id)!.status).toBe("processing");
    const p = getTask(t.id)!.pending!.find((a) => a.type === "tool_call")!;
    expect(p).toBeTruthy();
    expect(r.kind === "held" && r.pendingId).toBe(p.id);
    expect(p.payload).toMatchObject({ tool: "fake", op: "send", args: { to: "a" }, conversationId: "c1" });
    expect(calls.send).toBe(0);
  });

  it("model 无任务要两步同意", async () => {
    const r = await invokeTool(model, "fake", "send", {});
    expect(r.kind).toBe("needs_consent");
    expect(r.kind === "needs_consent" && r.summary).toContain("撤不回");
    expect(calls.send).toBe(0);
  });

  it("model 的任务不在工具的项目里 refused", async () => {
    saveTool({ ...getTool("fake")!, projects: ["p1"] });
    try {
      const t = createTask({ title: "t", kind: "code", source: {}, project: "p2" });
      expect((await invokeTool({ ...model, taskId: t.id }, "fake", "get", {})).kind).toBe("refused");
      const ok = createTask({ title: "t", kind: "code", source: {}, project: "p1" });
      expect((await invokeTool({ ...model, taskId: ok.id }, "fake", "get", {})).kind).toBe("ok");
    } finally {
      saveTool({ ...getTool("fake")!, projects: [] });
    }
  });

  it("model 读也记账、friday 读不记账", async () => {
    const before = listAudit({ limit: 1000 }).length;
    await invokeTool(model, "fake", "get", {});
    await invokeTool({ kind: "friday", why: "同步" }, "fake", "get", {});
    expect(listAudit({ limit: 1000 }).length).toBe(before + 1);
    expect(latest()).toMatchObject({ risk: "read" });
    expect(latest().evidence.caller).toBe("model");
  });

  it("builtin 的 reversible 撤销用 run 返回的 undo", async () => {
    const r = await invokeTool(model, "fake", "flip", {});
    expect(r.kind).toBe("ok");
    expect(undoPlan(latest().id)).toEqual({ kind: "delete_research", file: "x.md" });
    expect(latest().risk).toBe("reversible");
  });

  it("外部 reversible 撤销参数从 before 和 result 取", async () => {
    saveTool({
      name: "kv", transport: "cli", connection: "kvcli", scenario: "测试", projects: [], roles: [], binaries: ["kvcli"],
      enabled: true, draft: false,
      ops: [
        { name: "get", description: "读", inputSchema: {}, level: "read", levelBy: "user", template: ["get", "{id}"] },
        {
          name: "set", description: "写", inputSchema: {}, level: "reversible", levelBy: "user", template: ["set", "{id}", "{value}"],
          undo: { op: "set", before: { op: "get", args: { id: "$args.id" } }, args: { id: "$args.id", value: "$before.value" } },
        },
      ],
    });
    runCli.mockResolvedValueOnce('{"value":"old"}').mockResolvedValueOnce("{}");
    const r = await invokeTool({ kind: "user", why: "测试" }, "kv", "set", { id: "1", value: "new" });
    expect(r.kind).toBe("ok");
    expect(runCli.mock.calls.map((c) => c.slice(0, 2))).toEqual([["kvcli", ["get", "1"]], ["kvcli", ["set", "1", "new"]]]);
    expect(undoPlan(latest().id)).toEqual({ kind: "tool_undo", tool: "kv", op: "set", args: { id: "1", value: "old" } });
  });

  it("批准待审的 tool_call 由 executePending 执行", async () => {
    const t = createTask({ title: "t", kind: "code", source: {}, status: "processing" });
    const held = await invokeTool({ ...model, taskId: t.id }, "fake", "send", {});
    const pendingId = held.kind === "held" ? held.pendingId : "";
    const after = await executePending(t.id, pendingId, { slackPost: async () => ({ ts: "" }) });
    expect(calls.send).toBe(1);
    expect(after.status).toBe("processing");
    expect(getTask(t.id)!.status).toBe("processing");
    expect(listAudit({ taskId: t.id }).some((e) => e.action === "terminal_closed")).toBe(false);
    expect(latest()).toMatchObject({ taskId: t.id, risk: "irreversible", status: "approved", action: "fake_sent" });
    expect(getTask(t.id)!.pending ?? []).toHaveLength(0);
  });

  it("撤销 tool_undo 按登记再调一次，失败回 409", async () => {
    runCli.mockResolvedValueOnce('{"value":"old"}').mockResolvedValueOnce("{}");
    await invokeTool({ kind: "user", why: "测试" }, "kv", "set", { id: "2", value: "new" });
    const id = latest().id;
    runCli.mockReset();
    runCli.mockRejectedValueOnce(new Error("kvcli 失败：boom"));
    const bad = await tasks.request(`/audit/${id}/undo`, { method: "POST" });
    expect(bad.status).toBe(409);
    expect(((await bad.json()) as { error: string }).error).toContain("boom");
    runCli.mockResolvedValueOnce('{"value":"new"}').mockResolvedValueOnce("{}");
    const ok = await tasks.request(`/audit/${id}/undo`, { method: "POST" });
    expect(ok.status).toBe(200);
    expect(runCli.mock.calls.at(-1)?.slice(0, 2)).toEqual(["kvcli", ["set", "2", "old"]]);
  });

  it("撤销快照要用的操作不是只读就 refused，不执行主操作", async () => {
    for (const level of [null, "irreversible"] as const) {
      saveTool({
        name: "kv2", transport: "cli", connection: "kv2cli", scenario: "测试", projects: [], roles: [], binaries: [],
        enabled: true, draft: false,
        ops: [
          { name: "peek", description: "快照", inputSchema: {}, level, levelBy: "user", template: ["peek", "{id}"] },
          {
            name: "set", description: "写", inputSchema: {}, level: "reversible", levelBy: "user", template: ["set", "{id}", "{value}"],
            undo: { op: "set", before: { op: "peek", args: { id: "$args.id" } }, args: { id: "$args.id", value: "$before.value" } },
          },
        ],
      });
      runCli.mockReset();
      const r = await invokeTool({ kind: "user", why: "测试" }, "kv2", "set", { id: "1", value: "x" });
      expect(r.kind).toBe("refused");
      expect(r.kind === "refused" && r.why).toContain("不是只读");
      expect(runCli).not.toHaveBeenCalled();
    }
  });
});
