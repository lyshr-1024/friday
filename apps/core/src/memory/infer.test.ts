import { describe, expect, it } from "vitest";
import { conversationKey, slackNode } from "./infer.js";

describe("conversationKey", () => {
  it("thread 里的回复归到根消息", () => {
    expect(conversationKey({ channelId: "C1", ts: "1789000002.1", threadTs: "1789000001.0" })).toBe("C1:1789000001.0");
  });

  it("thread 根消息自己算一段：threadTs 等于自身 ts", () => {
    expect(conversationKey({ channelId: "C1", ts: "1789000001.0", threadTs: "1789000001.0" })).toBe("C1:1789000001.0");
  });

  it("不在 thread 里的单条消息自己算一段", () => {
    expect(conversationKey({ channelId: "D9", ts: "1789000005.5" })).toBe("D9:1789000005.5");
  });
});

describe("slackNode", () => {
  it("是 slack 类型的节点，ref 就是对话键", () => {
    expect(slackNode("C1:1789000001.0")).toEqual({ kind: "slack", ref: "C1:1789000001.0" });
  });
});
