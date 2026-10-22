import { describe, expect, it, vi } from "vitest";
import { createConversation, listMessages } from "../memory/conversations.js";

vi.mock("./claude.js", () => {
  return {
    askStream: async function* (_p: unknown, o: { conversationId: string }) {
      const runs = await import("./runs.js");
      runs.touchTask(o.conversationId, "t-1");
      runs.touchTask(o.conversationId, "t-1");
      runs.touchTask(o.conversationId, "t-2");
      yield { type: "delta", text: "好的" };
      yield { type: "done" };
    },
  };
});

const { startRun, touchTask, isRunning } = await import("./runs.js");
const { subscribe: subscribeBus } = await import("../bus.js");

describe("touchTask", () => {
  it("这一轮碰过的任务记到用户消息和回答上", async () => {
    const c = createConversation();
    const run = startRun(c.id, "帮我看下", { systemPrompt: "", cwd: "." });
    await new Promise<void>((resolve) => {
      run.listeners.add((ev) => ev.type === "done" && resolve());
    });
    const msgs = listMessages(c.id);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.taskIds).toEqual(["t-1", "t-2"]);
    expect(msgs[1]!.taskIds).toEqual(["t-1", "t-2"]);
  });

  it("没有进行中的 run 就什么都不做", () => {
    expect(() => touchTask("none", "t-1")).not.toThrow();
  });
});

describe("startRun 前置步骤抛错", () => {
  it("不在 runs 里留一个永远不结束的 run，并发 running:false", () => {
    const events: Array<{ id: string; running: boolean }> = [];
    const off = subscribeBus((ev) => {
      if (ev.type === "conversation") events.push({ id: ev.id, running: ev.running });
    });
    const ghost = "00000000-0000-4000-8000-000000000000";
    expect(() => startRun(ghost, "hi", { systemPrompt: "", cwd: "." })).toThrow();
    off();
    expect(isRunning(ghost)).toBe(false);
    expect(events).toEqual([
      { id: ghost, running: true },
      { id: ghost, running: false },
    ]);
  });
});
