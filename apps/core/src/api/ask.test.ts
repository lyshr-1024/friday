import { describe, expect, it, vi } from "vitest";

vi.mock("../agent/claude.js", () => ({
  askStream: async function* () {
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
      { type: "delta", text: "你" },
      { type: "delta", text: "好" },
      { type: "done" },
    ]);
  });
});
