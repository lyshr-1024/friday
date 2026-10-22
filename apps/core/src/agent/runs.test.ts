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

const { startRun, touchTask } = await import("./runs.js");

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
