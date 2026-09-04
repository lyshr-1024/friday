import { describe, expect, it, vi } from "vitest";

vi.mock("../agent/claude.js", () => ({
  askStream: async function* () {
    yield { type: "session", sessionId: "s-1" };
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
