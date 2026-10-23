import { describe, expect, it } from "vitest";
import { addMessage, createConversation } from "../memory/conversations.js";
import { consentGate, consents } from "./consent.js";

const EXEC = ["执行", "执行吧", "确认执行"];

describe("consents：说人话也算同意", () => {
  it("以动作词或肯定词开头、没有否定 / 条件 / 追问：算", () => {
    for (const s of ["执行", "执行我看看", "执行吧！", "好，执行", "好的，提交吧", "可以", "可以，删", "确认", "没问题", "OK", "ok 执行", "行"]) expect(consents(s, EXEC), s).toBe(true);
  });

  it("带否定、条件、追问：不算", () => {
    for (const s of ["执行之前先给我看看", "先别执行", "不要执行", "执行吗？", "执行吗", "等等", "算了", "好，不过标题改一下", "可以但是先改一下", "取消执行", "执行前再确认下", "发吧，语气再软点", "合并前先跑下测试", "执行，先跑测试"]) expect(consents(s, EXEC), s).toBe(false);
  });

  it("单字和通用肯定词要独立成词：「好像不对」「行不行」不算", () => {
    for (const s of ["好像不对", "行不行", "好的我看下", "可以看看"]) expect(consents(s, EXEC), s).toBe(false);
    expect(consents("删", ["删掉", "删"])).toBe(true);
    expect(consents("删除记录先留着", ["删掉", "删"])).toBe(false);
  });

  it("有改动的 worktree：只认带「连改动」的说法", () => {
    const DIRTY = ["连改动一起删掉", "连改动一起删"];
    expect(consents("连改动一起删掉吧", DIRTY, false)).toBe(true);
    expect(consents("删掉", DIRTY, false)).toBe(false);
    expect(consents("好", DIRTY, false)).toBe(false);
  });
});

describe("consentGate：上一轮问过的，一句同意全部放行", () => {
  const say = (conv: string, content: string) => addMessage(conv, { role: "user", kind: "ask", content });

  it("一轮问了几个，下一句同意都放行；没问过的不放", () => {
    const gate = consentGate();
    const conv = createConversation().id;
    say(conv, "把这 3 条交上去");
    for (const k of ["a", "b", "c"]) expect(gate(conv, k, EXEC).ok).toBe(false);
    say(conv, "执行我看看");
    for (const k of ["c", "a", "b"]) expect(gate(conv, k, EXEC).ok, k).toBe(true);
    expect(gate(conv, "d", EXEC).ok).toBe(false);
  });

  it("同一轮连调两次不会自己批准；问完隔了一句别的再同意不算", () => {
    const gate = consentGate();
    const conv = createConversation().id;
    say(conv, "执行");
    expect(gate(conv, "x", EXEC).ok).toBe(false);
    expect(gate(conv, "x", EXEC).ok).toBe(false);
    say(conv, "先看看别的");
    say(conv, "执行");
    expect(gate(conv, "x", EXEC).ok).toBe(false);
  });

  it("放行过一次的不能再用同一句放行第二次", () => {
    const gate = consentGate();
    const conv = createConversation().id;
    say(conv, "交吧");
    gate(conv, "y", EXEC);
    say(conv, "执行");
    expect(gate(conv, "y", EXEC).ok).toBe(true);
    expect(gate(conv, "y", EXEC).ok).toBe(false);
  });
});
