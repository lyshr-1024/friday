import { describe, expect, it } from "vitest";
import { createSchedule, deleteSchedule, getSchedule, listSchedules, pushHistory, scheduleByConversation, setLastRun, updateSchedule } from "./schedules.js";

describe("schedules 表", () => {
  it("建、读、改、删", () => {
    const s = createSchedule({ title: "修验收", cron: "0 10 * * *", executor: "project", project: "whale-console", prompt: "去修" });
    expect(s.id).toMatch(/^s-[0-9a-f]{8}$/);
    expect(s).toMatchObject({ enabled: true, mode: "continue", attended: false, history: [] });
    expect(getSchedule(s.id)?.prompt).toBe("去修");
    updateSchedule(s.id, { enabled: false, anchorTaskId: "t1" });
    expect(getSchedule(s.id)).toMatchObject({ enabled: false, anchorTaskId: "t1" });
    expect(listSchedules().some((x) => x.id === s.id)).toBe(true);
    expect(deleteSchedule(s.id)).toBe(true);
    expect(getSchedule(s.id)).toBeUndefined();
  });

  it("call 的 args 存 JSON 读回原样", () => {
    const s = createSchedule({ title: "同步", cron: "0 9 * * *", executor: "call", server: "friday", tool: "meegle_sync", args: { a: 1 } });
    expect(getSchedule(s.id)?.args).toEqual({ a: 1 });
  });

  it("记上次结果", () => {
    const s = createSchedule({ title: "x", cron: "* * * * *", executor: "friday", prompt: "p" });
    setLastRun(s.id, { ok: false, result: "炸了", ref: "c1", at: "2026-10-13T02:00:00.000Z" });
    expect(getSchedule(s.id)).toMatchObject({ lastOk: false, lastResult: "炸了", lastRef: "c1", lastRunAt: "2026-10-13T02:00:00.000Z" });
  });

  it("history 按 at 去重、只留最近 5 条", () => {
    const s = createSchedule({ title: "h", cron: "* * * * *", executor: "project", project: "p", prompt: "p" });
    for (let i = 1; i <= 6; i++) pushHistory(s.id, { at: `2026-10-0${i}`, summary: `第${i}轮` });
    pushHistory(s.id, { at: "2026-10-06", summary: "第6轮" });
    expect(getSchedule(s.id)!.history.map((h) => h.summary)).toEqual(["第2轮", "第3轮", "第4轮", "第5轮", "第6轮"]);
  });

  it("按会话找定时任务", () => {
    const s = createSchedule({ title: "f", cron: "* * * * *", executor: "friday", prompt: "p" });
    updateSchedule(s.id, { conversationId: "conv-x" });
    expect(scheduleByConversation("conv-x")?.id).toBe(s.id);
    expect(scheduleByConversation("nope")).toBeUndefined();
  });
});
