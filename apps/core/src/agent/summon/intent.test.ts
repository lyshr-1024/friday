import { describe, expect, it } from "vitest";
import { classifyIntent } from "./intent.js";

describe("HUD 里说的话想干什么", () => {
  it("认得出「帮我查」的几种说法", () => {
    for (const s of ["帮我查这个", "查一下", "查查这个", "看看这条", "读代码看看", "帮我查一下"]) {
      expect(classifyIntent(s), s).toBe("slack_query");
    }
  });

  it("认得出「建成任务」的几种说法", () => {
    for (const s of ["建成任务", "建个任务", "记成任务", "建一条任务", "加到任务板", "记个待办"]) {
      expect(classifyIntent(s), s).toBe("slack_task");
    }
  });

  it("认得出「挂到」的几种说法", () => {
    for (const s of ["挂到", "挂到 0921 那条上", "关联到验收问题", "并入这段对话"]) {
      expect(classifyIntent(s), s).toBe("slack_attach");
    }
  });

  it("「挂到那条任务上」是挂靠不是建任务——两个词都含「任务」，顺序错了就会给用户新建一条", () => {
    expect(classifyIntent("挂到那条任务上")).toBe("slack_attach");
    expect(classifyIntent("关联到刚才那个任务")).toBe("slack_attach");
  });

  it("交代事情的话不认，交给模型", () => {
    for (const s of [
      "这条消息里说的接口是哪个",
      "告诉终端把分页参数也带上",
      "佳成催的那个走查表要怎么分组",
      "帮我看看这个问题该不该修，如果要修就挂到验收那条上再顺便把文案也改了",
    ]) {
      expect(classifyIntent(s), s).toBeUndefined();
    }
  });

  it("空话不认", () => {
    expect(classifyIntent("")).toBeUndefined();
    expect(classifyIntent("   ")).toBeUndefined();
  });
});
