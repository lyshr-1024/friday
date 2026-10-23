import { describe, expect, it } from "vitest";
import { conversationKey, extNode, inferTaskLinks } from "./infer.js";
import { neighbors } from "./links.js";
import { createTask } from "./tasks.js";
import { idsIn as meegleIdsIn } from "../connectors/meegle/rules.js";

describe("meegleIdsIn", () => {
  // 7 位躲开裸 8 位数字那条回退规则，中了就说明是 URL 正则认出来的
  it("认 project.feishu.cn", () => {
    expect(meegleIdsIn("看下 https://project.feishu.cn/whale/story/detail/2444053")).toEqual(["2444053"]);
  });

  it("认 *.meegle.com", () => {
    expect(meegleIdsIn("https://longbridge.meegle.com/whale/issue/9876543 这个")).toEqual(["9876543"]);
  });

  it("不相干的链接不认", () => {
    expect(meegleIdsIn("https://example.com/detail/1234567")).toEqual([]);
  });
});

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

describe("extNode", () => {
  it("是 ext 类型的节点，ref 是「工具:类型:对话键」", () => {
    expect(extNode("slack", "conversation", "C1:1789000001.0")).toEqual({ kind: "ext", ref: "slack:conversation:C1:1789000001.0" });
  });

  it("频道名剥掉 #", () => {
    expect(extNode("slack", "channel", "#一起养牛")).toEqual({ kind: "ext", ref: "slack:channel:一起养牛" });
  });
});

describe("inferTaskLinks", () => {
  it("老库遗留的线程任务连到 slack:thread，普通对话不由它连", () => {
    const old = createTask({ title: "老线程", kind: "conversation", source: { external: { tool: "slack", type: "conversation", id: "TH-infer", attrs: { legacy: "thread" } } } });
    const conv = createTask({ title: "新对话", kind: "conversation", source: { external: { tool: "slack", type: "conversation", id: "C7:7.7" } } });
    inferTaskLinks(old);
    inferTaskLinks(conv);
    expect(neighbors(extNode("slack", "thread", "TH-infer"), "task").map((n) => n.ref)).toEqual([old.id]);
    expect(neighbors(extNode("slack", "thread", "C7:7.7"), "task")).toEqual([]);
  });

  it("工单和它所属需求都连成 meegle:work_item", () => {
    const t = createTask({ title: "缺陷", kind: "work_item", source: { external: { tool: "meegle", type: "work_item", id: "31000001", kind: "defect", parent: { id: "31000002" } } } });
    inferTaskLinks(t);
    expect(neighbors(extNode("meegle", "work_item", "31000001"), "task").map((n) => n.ref)).toEqual([t.id]);
    expect(neighbors(extNode("meegle", "work_item", "31000002"), "task").map((n) => n.ref)).toEqual([t.id]);
  });
});
