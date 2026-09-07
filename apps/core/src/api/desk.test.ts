import { describe, expect, it, vi } from "vitest";

vi.mock("../agent/claude.js", () => ({
  askStream: async function* () {
    yield { type: "delta", text: "先回灵雨，工单在 Open。\n然后处理今天到期的待办。" };
    yield { type: "done" };
  },
}));
const { app } = await import("./index.js");

describe("GET /desk", () => {
  it("给出问候、建议与素材，重复请求命中缓存", async () => {
    const d1 = (await (await app.request("/desk")).json()) as { name: string; greeting: string; advice: string; generatedAt: string; todos: unknown[] };
    expect(d1.name.length).toBeGreaterThan(0);
    expect(["夜深了", "早上好", "中午好", "下午好", "晚上好"]).toContain(d1.greeting);
    expect(d1.advice).toContain("先回灵雨");
    const d2 = (await (await app.request("/desk")).json()) as { generatedAt: string };
    expect(d2.generatedAt).toBe(d1.generatedAt);
  });
});
