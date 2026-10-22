import { describe, expect, it, vi } from "vitest";
import { listMessages } from "../memory/conversations.js";

// 每个 prompt 一个闸门：测试决定它何时结束、是否出错
const gates = new Map<string, { release: () => void; fail: boolean }>();
const started: string[] = [];

vi.mock("../agent/claude.js", () => ({
  askStream: async function* (prompt: unknown) {
    const key = typeof prompt === "string" ? prompt : "(附件)";
    started.push(key);
    await new Promise<void>((resolve) => gates.set(key, { release: resolve, fail: false }));
    const g = gates.get(key)!;
    if (g.fail) throw new Error("boom");
    yield { type: "delta", text: `答:${key}` };
    yield { type: "done" };
  },
}));

const boardFail = vi.hoisted(() => ({ left: 0 }));
vi.mock("../agent/needs.js", async (orig) => ({
  ...(await orig<typeof import("../agent/needs.js")>()),
  boardBlock: () => {
    if (boardFail.left > 0) {
      boardFail.left--;
      throw new Error("板读不出来");
    }
    return "";
  },
}));

const { app } = await import("./index.js");

const post = (prompt: string, conversationId: string) =>
  app.request("/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt, conversationId }) });
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const newConv = async () => ((await (await app.request("/conversation/new", { method: "POST" })).json()) as { id: string }).id;
const queue = async (id: string) => (await (await app.request(`/ask/queue?conversationId=${id}`)).json()) as Array<{ id: string; prompt: string }>;

describe("生成中再发", () => {
  it("202 排队，这一轮结束后按顺序跑", async () => {
    const conv = await newConv();
    void post("q1-first", conv);
    await tick();
    const r2 = await post("q1-second", conv);
    const r3 = await post("q1-third", conv);
    expect(r2.status).toBe(202);
    expect(((await r2.json()) as { queued: { prompt: string } }).queued.prompt).toBe("q1-second");
    expect(r3.status).toBe(202);
    expect((await queue(conv)).map((q) => q.prompt)).toEqual(["q1-second", "q1-third"]);
    expect(listMessages(conv).map((m) => m.content)).toEqual(["q1-first"]);

    gates.get("q1-first")!.release();
    await tick();
    expect(started).toContain("q1-second");
    expect(started).not.toContain("q1-third");
    gates.get("q1-second")!.release();
    await tick();
    gates.get("q1-third")!.release();
    await tick();
    expect(listMessages(conv).map((m) => m.content)).toEqual(["q1-first", "答:q1-first", "q1-second", "答:q1-second", "q1-third", "答:q1-third"]);
    expect(await queue(conv)).toEqual([]);
  });

  it("撤回的不跑", async () => {
    const conv = await newConv();
    void post("q2-first", conv);
    await tick();
    const queued = ((await (await post("q2-second", conv)).json()) as { queued: { id: string } }).queued;
    const del = await app.request(`/ask/queue/${queued.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await app.request(`/ask/queue/${queued.id}`, { method: "DELETE" })).status).toBe(404);
    gates.get("q2-first")!.release();
    await tick();
    expect(started).not.toContain("q2-second");
  });

  it("上一轮出错 / 被中断，队列照样往下走", async () => {
    const conv = await newConv();
    void post("q3-first", conv);
    await tick();
    await post("q3-second", conv);
    await post("q3-third", conv);
    gates.get("q3-first")!.fail = true;
    gates.get("q3-first")!.release();
    await tick();
    expect(started).toContain("q3-second");
    await app.request("/ask/cancel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: conv }) });
    gates.get("q3-second")!.release();
    await tick();
    expect(started).toContain("q3-third");
    gates.get("q3-third")!.release();
    await tick();
  });
});

describe("排队开跑出错", () => {
  it("不崩、不丢：放回队首，会话里留一条 error", async () => {
    const conv = await newConv();
    void post("q4-first", conv);
    await tick();
    await post("q4-second", conv);
    boardFail.left = 1;
    gates.get("q4-first")!.release();
    await tick();
    expect(started).not.toContain("q4-second");
    expect((await queue(conv)).map((q) => q.prompt)).toEqual(["q4-second"]);
    const err = listMessages(conv).find((m) => m.kind === "error");
    expect(err?.content).toBe("排队的这句没能开跑：板读不出来");
  });
});
