import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { runCli, readChunk, fetchLarkDoc, sayToSession } = vi.hoisted(() => ({
  runCli: vi.fn<(binary: string, argv: string[], timeoutMs?: number) => Promise<string>>(),
  readChunk: vi.fn(),
  fetchLarkDoc: vi.fn(),
  sayToSession: vi.fn(async () => "sent" as const),
}));
vi.mock("./cli.js", async (orig) => ({ ...(await orig<typeof import("./cli.js")>()), runCli }));
vi.mock("./web/index.js", async (orig) => ({ ...(await orig<typeof import("./web/index.js")>()), readChunk }));
vi.mock("./lark/index.js", async (orig) => ({ ...(await orig<typeof import("./lark/index.js")>()), fetchLarkDoc }));
vi.mock("../agent/sessions.js", async (orig) => ({ ...(await orig<typeof import("../agent/sessions.js")>()), sayToSession }));

import { listAudit, undoPlan } from "../memory/audit.js";
import { addMessage, createConversation, listMessages } from "../memory/conversations.js";
import { createJob } from "../memory/jobs.js";
import { createRun, runsForTask } from "../memory/runs.js";
import { addPending, createTask, getTask } from "../memory/tasks.js";
import { defineBuiltin, seedBuiltins } from "./builtin.js";
import { executePending } from "../agent/pipeline.js";
import { updateTaskFromChat } from "../agent/taskUpdate.js";
import { tasks } from "../api/tasks.js";
import { invokeTool } from "./invoke.js";
import { getTool, saveTool } from "./registry.js";
import "./web/tool.js";
import "./lark/tool.js";
import { meegleClient } from "./meegle/index.js";

const calls = { get: 0, flip: 0, send: 0 };
const model = { kind: "model" as const, why: "测试" };

beforeAll(() => {
  defineBuiltin({
    name: "fake", scenario: "测试用", roles: [], binaries: [],
    ops: [
      { name: "get", description: "读", input: { id: z.string().optional() }, level: "read", run: async () => { calls.get++; return { text: "got", value: { v: 1 } }; } },
      { name: "flip", description: "翻", input: {}, level: "reversible", run: async () => { calls.flip++; return { text: "flipped", undo: { kind: "delete_research", file: "x.md" } }; } },
      { name: "send", description: "发", input: { to: z.string().optional() }, level: "irreversible", audit: "fake_sent", run: async () => { calls.send++; return { text: "sent", evidence: { ts: "1.2" } }; } },
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
    const after = await executePending(t.id, pendingId);
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

describe("builtin 参数校验", () => {
  it("web read 拒绝 file:// 地址，不去读", async () => {
    readChunk.mockReset();
    const r = await invokeTool(model, "web", "read", { url: "file:///etc/passwd" });
    expect(r.kind).toBe("refused");
    expect(r.kind === "refused" && r.why).toContain("参数不对");
    expect(readChunk).not.toHaveBeenCalled();
  });

  it("多给的参数也拒", async () => {
    readChunk.mockReset();
    expect((await invokeTool(model, "web", "read", { url: "https://a.com", evil: 1 })).kind).toBe("refused");
    expect(readChunk).not.toHaveBeenCalled();
  });

  it("lark read 只认飞书 / Lark 的 http(s) 地址", async () => {
    fetchLarkDoc.mockReset();
    for (const url of ["file:///Users/x/.claude.json", "https://evil.com/docx/abc"]) {
      expect((await invokeTool(model, "lark", "read", { url })).kind).toBe("refused");
    }
    expect(fetchLarkDoc).not.toHaveBeenCalled();
  });

  it("meegle get 工单号不是数字、空间 key 带怪字符都拒，不调 CLI", async () => {
    const spy = vi.spyOn(meegleClient, "fetchOne").mockRejectedValue(new Error("不该调到"));
    try {
      for (const args of [{ space: "proj", id: "--help" }, { space: "proj", id: "12 34" }, { space: "-x", id: "123" }, { space: "a/b", id: "123" }]) {
        const r = await invokeTool(model, "meegle", "get", args);
        expect(r.kind).toBe("refused");
      }
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("lark read 分段", () => {
  it("长文档两次读完，第一段结尾给 offset", async () => {
    const text = `${"甲".repeat(20_000)}${"乙".repeat(5_000)}结尾标记`;
    fetchLarkDoc.mockReset();
    fetchLarkDoc.mockResolvedValue({ title: "PRD", outline: ["一"], text });
    const url = "https://x.feishu.cn/docx/abc";
    const a = await invokeTool(model, "lark", "read", { url });
    expect(a.kind).toBe("ok");
    const first = a.kind === "ok" ? a.text : "";
    expect(first).not.toContain("结尾标记");
    const next = /offset=(\d+)/.exec(first)?.[1];
    expect(next).toBeTruthy();
    expect(first).toContain(`tool_call lark read url=${url} offset=${next}`);
    const b = await invokeTool(model, "lark", "read", { url, offset: Number(next) });
    const second = b.kind === "ok" ? b.text : "";
    expect(second).toContain("结尾标记");
    expect(second).toContain("乙");
    expect(second).not.toContain("offset=");
  });
});

describe("外部工具的撤销说明", () => {
  const kv = (undo: unknown) =>
    saveTool({
      name: "kv3", transport: "cli", connection: "kv3cli", scenario: "测试", projects: [], roles: [], binaries: [],
      enabled: true, draft: false,
      ops: [
        { name: "get", description: "读", inputSchema: {}, level: "read", levelBy: "user", template: ["get", "{id}"] },
        { name: "set", description: "写", inputSchema: {}, level: "reversible", levelBy: "user", template: ["set", "{id}", "{value}"], undo: undo as never },
      ],
    });

  it("撤销说明缺 args：执行前就拒，不写外部", async () => {
    kv({ op: "set" });
    runCli.mockReset();
    const r = await invokeTool({ kind: "user", why: "测试" }, "kv3", "set", { id: "1", value: "x" });
    expect(r.kind).toBe("refused");
    expect(runCli).not.toHaveBeenCalled();
  });

  it("撤销说明指向不存在的操作：执行前就拒", async () => {
    kv({ op: "nope", args: { id: "$args.id" } });
    runCli.mockReset();
    expect((await invokeTool({ kind: "user", why: "测试" }, "kv3", "set", { id: "1", value: "x" })).kind).toBe("refused");
    expect(runCli).not.toHaveBeenCalled();
  });

  it("撤销参数取不到值：照样记账，但不带撤销并写明", async () => {
    kv({ op: "set", before: { op: "get", args: { id: "$args.id" } }, args: { id: "$args.id", value: "$before.value" } });
    runCli.mockReset();
    runCli.mockResolvedValueOnce("{}").mockResolvedValueOnce("{}");
    const r = await invokeTool({ kind: "user", why: "测试" }, "kv3", "set", { id: "9", value: "x" });
    expect(r.kind).toBe("ok");
    const ev = latest();
    expect(ev.action).toBe("kv3_set");
    expect(undoPlan(ev.id)).toBeUndefined();
    expect(ev.how).toContain("撤不了");
  });
});

describe("挂起的 tool_call", () => {
  const held = async (taskId: string, extra: Record<string, unknown> = {}) => {
    const r = await invokeTool({ ...model, taskId, ...extra }, "fake", "send", { to: "a" });
    return r.kind === "held" ? r.pendingId : "";
  };

  it("同一个调用再调一次不重复挂，回同一个 pendingId", async () => {
    const t = createTask({ title: "t", kind: "code", source: {}, status: "processing" });
    const a = await held(t.id);
    const b = await invokeTool({ ...model, taskId: t.id }, "fake", "send", { to: "a" });
    expect(b).toEqual({ kind: "held", pendingId: a });
    expect(getTask(t.id)!.pending!.filter((p) => p.type === "tool_call")).toHaveLength(1);
    const c = await invokeTool({ ...model, taskId: t.id }, "fake", "send", { to: "b" });
    expect(c.kind === "held" && c.pendingId).not.toBe(a);
  });

  it("执行失败放回待审、任务状态不动", async () => {
    defineBuiltin({
      name: "boom", scenario: "测试", roles: [], binaries: [],
      ops: [{ name: "send", description: "发", input: {}, level: "irreversible", run: async () => { throw new Error("炸了"); } }],
    });
    seedBuiltins();
    const t = createTask({ title: "t", kind: "code", source: {}, status: "processing" });
    const r = await invokeTool({ ...model, taskId: t.id }, "boom", "send", {});
    const id = r.kind === "held" ? r.pendingId : "";
    await expect(executePending(t.id, id)).rejects.toThrow("炸了");
    expect(getTask(t.id)!.status).toBe("processing");
    expect(getTask(t.id)!.pending!.some((p) => p.id === id)).toBe(true);
  });

  it("批了以后把结果告诉发起的终端和主对话", async () => {
    const t = createTask({ title: "t", kind: "code", source: {}, status: "processing" });
    createJob({ id: "job-tc1", project: "p", dir: "/tmp", logPath: "/tmp/x.log", taskId: t.id, sessionId: "sess-tc1" });
    const conv = createConversation().id;
    sayToSession.mockClear();
    const id = await held(t.id, { jobId: "job-tc1", conversationId: conv });
    await executePending(t.id, id);
    expect(sayToSession).toHaveBeenCalledWith("sess-tc1", expect.stringContaining("用户批了，fake.send 已执行：sent"));
    const m = listMessages(conv).at(-1)!;
    expect(m).toMatchObject({ kind: "run", taskIds: [t.id] });
    expect(m.content).toContain("sent");
  });

  it("不执行：只撤这一条，状态和运行结局不动，告诉发起方", async () => {
    const t = createTask({ title: "t", kind: "code", source: {}, status: "processing" });
    createJob({ id: "job-tc2", project: "p", dir: "/tmp", logPath: "/tmp/x.log", taskId: t.id, sessionId: "sess-tc2" });
    createRun({ id: "job-tc2", jobId: "job-tc2", taskId: t.id, project: "p", kind: "autonomous", trigger: "user" });
    const conv = createConversation().id;
    addMessage(conv, { role: "user", kind: "ask", content: "hi" });
    sayToSession.mockClear();
    const id = await held(t.id, { jobId: "job-tc2", conversationId: conv });
    const res = await tasks.request(`/tasks/${t.id}/pending/${id}/dismiss`, { method: "POST" });
    expect(res.status).toBe(200);
    const after = getTask(t.id)!;
    expect(after.status).toBe("processing");
    expect(after.pending ?? []).toHaveLength(0);
    expect(runsForTask(t.id)[0]!.outcome).toBe("pending");
    expect(listAudit({ taskId: t.id }).some((e) => e.action === "tool_call_dismissed")).toBe(true);
    expect(sayToSession).toHaveBeenCalledWith("sess-tc2", expect.stringContaining("用户没批 fake.send"));
    expect(listMessages(conv).at(-1)!.content).toContain("没批");
  });

  it("不执行只收 tool_call", async () => {
    const t = createTask({ title: "t", kind: "code", source: {}, status: "review" });
    const gm = addPending(t.id, { type: "git_merge", label: "合并", detail: "", payload: {} })!.pending![0]!.id;
    const res = await tasks.request(`/tasks/${t.id}/pending/${gm}/dismiss`, { method: "POST" });
    expect(res.status).toBe(400);
    expect(getTask(t.id)!.pending).toHaveLength(1);
  });

  it("会话里 dropToolCall 撤掉这条任务的 tool_call，留着别的待审", async () => {
    const t = createTask({ title: "t", kind: "code", source: {}, status: "processing" });
    addPending(t.id, { type: "git_merge", label: "合并", detail: "", payload: {} }, { keepStatus: true });
    await held(t.id);
    const r = updateTaskFromChat(t.id, { dropToolCall: true })!;
    expect(r.changed.join("")).toContain("撤掉");
    expect(getTask(t.id)!.pending!.map((p) => p.type)).toEqual(["git_merge"]);
    expect(getTask(t.id)!.status).toBe("processing");
    expect(listAudit({ taskId: t.id }).some((e) => e.action === "tool_call_dismissed")).toBe(true);
  });
});

describe("meegle 流转的撤销", () => {
  it("读不到线上状态时，用调用方给的 from 当撤销目标", async () => {
    const get = vi.spyOn(meegleClient, "getWorkItem").mockResolvedValue(undefined);
    const tr = vi.spyOn(meegleClient, "transitionState").mockResolvedValue(undefined as never);
    try {
      const r = await invokeTool({ kind: "user", why: "测试" }, "meegle", "transition", { space: "proj", id: "123456", transitionId: "7", stateKey: "IN PROGRESS", from: "OPEN" });
      expect(r.kind).toBe("ok");
      expect(undoPlan(latest().id)).toMatchObject({ kind: "meegle_state", backTo: "OPEN" });
    } finally {
      get.mockRestore();
      tr.mockRestore();
    }
  });
});
