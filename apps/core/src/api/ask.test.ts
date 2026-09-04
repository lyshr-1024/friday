import { describe, expect, it, vi } from "vitest";

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
    const list = (await (await app.request("/conversations")).json()) as Array<{ title: string; messageCount: number }>;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ title: "hi", messageCount: 2 });
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
