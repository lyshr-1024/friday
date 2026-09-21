import { describe, expect, it } from "vitest";
import type { InboxItem, Task } from "@friday/shared";
import { hardSignal } from "./attach.js";

const item = (text: string, over: Partial<InboxItem> = {}): InboxItem => ({
  id: "i1", kind: "mention", channelId: "C1", channelName: "team-fe-bo",
  userId: "U9", userName: "拂晓", text, permalink: "https://s/1",
  ts: "1789000010.0", receivedAt: "2026-09-21T00:00:00Z", done: false, ...over,
});

const task = (id: string, over: Partial<Task> = {}): Task => ({
  id, title: `任务 ${id}`, kind: "meegle", source: {}, status: "understood",
  priority: "normal", createdAt: "2026-09-20T00:00:00Z", updatedAt: "2026-09-20T00:00:00Z", ...over,
});

describe("hardSignal", () => {
  it("消息里贴了工单链接就挂到那条工单的任务上", () => {
    const tasks = [task("t1", { source: { meegleId: "24440539" } }), task("t2")];
    const hit = hardSignal(item("这个问题看下 https://project.larksuite.com/projectlb/story/detail/24440539"), tasks, () => []);
    expect(hit?.taskId).toBe("t1");
    expect(hit?.why).toContain("24440539");
  });

  it("裸工单号也算", () => {
    const tasks = [task("t1", { source: { meegleId: "24440539" } })];
    expect(hardSignal(item("24440539 这条改完了吗"), tasks, () => [])?.taskId).toBe("t1");
  });

  it("工单号没对应任务时不硬挂", () => {
    expect(hardSignal(item("24440539 看下"), [task("t2")], () => [])).toBeUndefined();
  });

  it("没有工单时用同一人同一频道近期挂过的任务", () => {
    const tasks = [task("t5")];
    const hit = hardSignal(item("抽空改一下"), tasks, () => [{ taskId: "t5", userName: "拂晓", hoursAgo: 3 }]);
    expect(hit?.taskId).toBe("t5");
    expect(hit?.why).toContain("拂晓");
    expect(hit?.why).toContain("3 小时前");
  });

  it("工单优先于近期", () => {
    const tasks = [task("t1", { source: { meegleId: "24440539" } }), task("t5")];
    const hit = hardSignal(item("24440539 改完了"), tasks, () => [{ taskId: "t5", userName: "拂晓", hoursAgo: 1 }]);
    expect(hit?.taskId).toBe("t1");
  });

  it("近期命中的任务已经不在候选里就不挂", () => {
    expect(hardSignal(item("抽空改一下"), [task("t9")], () => [{ taskId: "t5", userName: "拂晓", hoursAgo: 3 }])).toBeUndefined();
  });

  it("两样都没有就交给上层去问模型", () => {
    expect(hardSignal(item("抽空改一下"), [task("t9")], () => [])).toBeUndefined();
  });
});
