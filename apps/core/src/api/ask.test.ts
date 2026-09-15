import { describe, expect, it, vi } from "vitest";
import { taskBlock } from "./ask.js";
import { createTask, updateTask } from "../memory/tasks.js";

vi.mock("../agent/claude.js", () => ({
  askStream: async function* () {
    yield { type: "session", sessionId: "s-1" };
    yield { type: "delta", text: "我先查一下" };
    yield { type: "reset" };
    yield { type: "delta", text: "你" };
    yield { type: "delta", text: "好" };
    yield { type: "done" };
  },
}));

const { app } = await import("./index.js");

describe("POST /ask", () => {
  it("拒绝空 prompt", async () => {
    const res = await app.request("/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "  " }),
    });
    expect(res.status).toBe(400);
  });

  it("以 SSE 逐段返回回答", async () => {
    const res = await app.request("/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi" }),
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const frames = (await res.text())
      .split("\n\n")
      .filter(Boolean)
      .map((f) => JSON.parse(f.replace(/^data: /, "")));
    expect(frames).toEqual([
      { type: "session", sessionId: "s-1" },
      { type: "delta", text: "我先查一下" },
      { type: "reset" },
      { type: "delta", text: "你" },
      { type: "delta", text: "好" },
      { type: "done" },
    ]);
  });
});

describe("对话历史", () => {
  it("/ask 把问答记进对话，并记录 Claude 会话 id 供续接", async () => {
    const conv = (await (await app.request("/conversation/new", { method: "POST" })).json()) as { id: string };
    const res = await app.request("/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi", conversationId: conv.id }),
    });
    await res.text();
    const current = (await (await app.request("/conversation")).json()) as { id: string; messages: Array<{ role: string; content: string }> };
    expect(current.id).toBe(conv.id);
    expect(current.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "hi"],
      ["assistant", "你好"],
    ]);
    const { claudeSessionId } = await import("../memory/conversations.js");
    expect(claudeSessionId(conv.id)).toBe("s-1");
  });
});

describe("会话列表", () => {
  it("只列出有消息的会话，标题取第一条用户消息", async () => {
    await app.request("/conversation/new", { method: "POST" });
    const list = (await (await app.request("/conversations")).json()) as Array<{ title: string; messageCount: number; running: boolean }>;
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list[0]).toMatchObject({ title: "hi", messageCount: 2, running: false });
    const byId = await app.request(`/conversation/${(await (await app.request("/conversation")).json() as { id: string }).id}`);
    expect(byId.status).toBe(200);
    expect((await app.request("/conversation/00000000-0000-0000-0000-000000000000")).status).toBe(404);
  });
});

describe("删除会话", () => {
  it("删掉会话及其消息，列表里消失", async () => {
    const before = (await (await app.request("/conversations")).json()) as Array<{ id: string }>;
    expect(before.length).toBeGreaterThan(0);
    const res = await app.request(`/conversation/${before[0]!.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const after = (await (await app.request("/conversations")).json()) as Array<{ id: string }>;
    expect(after.some((c) => c.id === before[0]!.id)).toBe(false);
    expect((await app.request(`/conversation/${before[0]!.id}`)).status).toBe(404);
  });
});

describe("后台生成任务", () => {
  it("没有进行中任务时订阅与中断都返回 404", async () => {
    expect((await app.request("/ask/stream?conversationId=00000000-0000-0000-0000-000000000000")).status).toBe(404);
    const cancel = await app.request("/ask/cancel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: "x" }) });
    expect(cancel.status).toBe(404);
  });
});

describe("重命名会话", () => {
  it("自定义标题优先于第一条消息，清空则回退", async () => {
    const conv = (await (await app.request("/conversation/new", { method: "POST" })).json()) as { id: string };
    await (await app.request("/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "hello", conversationId: conv.id }) })).text();
    const patch = await app.request(`/conversation/${conv.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "旅行计划" }) });
    expect(patch.status).toBe(200);
    const list = (await (await app.request("/conversations")).json()) as Array<{ id: string; title: string }>;
    expect(list.find((c) => c.id === conv.id)?.title).toBe("旅行计划");
    await app.request(`/conversation/${conv.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "  " }) });
    const again = (await (await app.request("/conversations")).json()) as Array<{ id: string; title: string }>;
    expect(again.find((c) => c.id === conv.id)?.title).toBe("hello");
  });

  it("taskBlock：会话绑着任务才有，带理解 / 方案 / 待审 / 等你看", async () => {
    const conv = (await (await app.request("/conversation/new", { method: "POST" })).json()) as { id: string };
    expect(taskBlock(conv.id)).toBeUndefined();
    createTask({ title: "知许：改 segment", kind: "slack", source: { conversationId: conv.id }, status: "processing", understanding: "过期饲料罐提交逻辑要改", plan: "variant_mode 改 exclusive" });
    const block = taskBlock(conv.id)!;
    expect(block).toContain("知许：改 segment");
    expect(block).toContain("variant_mode 改 exclusive");
  });

  it("taskBlock：Friday 自己问的归属问题不能说成终端在问，别引它去敲 terminal_say", async () => {
    const conv = (await (await app.request("/conversation/new", { method: "POST" })).json()) as { id: string };
    const t = createTask({ title: "【NZ-开户详情页】无人脸照片时展示「暂无照片」", kind: "meegle", source: { conversationId: conv.id }, status: "understood" });
    updateTask(t.id, { attention: "intake", progress: "这条工单是财富后台（fe-wealth-admin）还是新BO（whale-console）项目的？" });
    const block = taskBlock(conv.id)!;
    expect(block).toContain("这条工单是财富后台");
    // 这条任务没有终端，别让 Friday 去敲 terminal_say，也别把它描述成终端停在提问上
    expect(block).not.toContain("terminal_say");
    expect(block).not.toContain("终端正停在");
    expect(block).toContain("task_update");
  });
});
