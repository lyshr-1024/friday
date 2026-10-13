import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./pipeline.js", () => ({
  startAutonomousJob: vi.fn(async (t) => t),
  startInteractiveJob: vi.fn(async (t) => t),
  reopenTask: vi.fn(async (id) => ({ task: { id }, terminal: false })),
}));
vi.mock("./runs.js", () => ({ startRun: vi.fn(), subscribe: vi.fn(() => () => {}), isRunning: vi.fn(() => false) }));
vi.mock("../memory/projects.js", async (orig) => ({
  ...(await orig<typeof import("../memory/projects.js")>()),
  resolveProject: (q: string) => (q === "whale-console" ? { kind: "match", project: { name: "whale-console", dir: "/tmp/wc" } } : { kind: "none" }),
}));

import { startAutonomousJob, startInteractiveJob, reopenTask } from "./pipeline.js";
import { startRun, isRunning, subscribe } from "./runs.js";
import { busyReason, fireSchedule, validateSchedule } from "./schedule.js";
import { createSchedule, getSchedule, updateSchedule } from "../memory/schedules.js";
import { getTask, updateTask } from "../memory/tasks.js";
import { getConversation } from "../memory/conversations.js";

beforeEach(() => vi.clearAllMocks());

describe("validateSchedule", () => {
  it("拒：cron 错、项目找不到、缺 prompt、call 指自己、friday 没有这个工具", () => {
    expect(validateSchedule({ title: "x", cron: "0 25 * * *", executor: "friday", prompt: "p" })).toMatch(/cron/);
    expect(validateSchedule({ title: "x", cron: "0 10 * * *", executor: "project", project: "nope", prompt: "p" })).toMatch(/项目/);
    expect(validateSchedule({ title: "x", cron: "0 10 * * *", executor: "friday" })).toMatch(/提示词/);
    expect(validateSchedule({ title: "x", cron: "0 10 * * *", executor: "call", server: "friday", tool: "schedule_add" })).toMatch(/定时/);
    expect(validateSchedule({ title: "x", cron: "0 10 * * *", executor: "call", server: "friday", tool: "no_such_tool" })).toMatch(/no_such_tool/);
    expect(validateSchedule({ title: "x", cron: "0 10 * * *", executor: "call", server: "friday", tool: "memory_read" })).toBeUndefined();
    expect(validateSchedule({ title: "x", cron: "0 10 * * *", executor: "project", project: "whale-console", prompt: "p" })).toBeUndefined();
  });
});

describe("project 执行方", () => {
  it("continue：第一次建长期卡，第二次复用、带上一轮概要", async () => {
    const s = createSchedule({ title: "修验收", cron: "0 10 * * *", executor: "project", project: "whale-console", prompt: "去修" });
    const r1 = await fireSchedule(s, "due");
    expect(r1.ok).toBe(true);
    const anchor = getSchedule(s.id)!.anchorTaskId!;
    expect(getTask(anchor)).toMatchObject({ kind: "code", title: "[定时] 修验收", project: "whale-console", source: { scheduleId: s.id } });
    expect(vi.mocked(startAutonomousJob).mock.calls[0]![4]).toBe("schedule");

    updateTask(anchor, { report: { summary: "修了资产总览配色", changes: [], testSteps: [], testResult: "通过", screenshots: [], verify: [], at: "2026-10-13T02:30:00.000Z" } });
    await fireSchedule(getSchedule(s.id)!, "due");
    const call2 = vi.mocked(startAutonomousJob).mock.calls[1]!;
    expect(call2[0].id).toBe(anchor);
    expect(call2[3]).toContain("修了资产总览配色");
    expect(getSchedule(s.id)!.history).toHaveLength(1);
  });

  it("continue：长期卡被标完成了先重开", async () => {
    const s = createSchedule({ title: "a", cron: "0 10 * * *", executor: "project", project: "whale-console", prompt: "p" });
    await fireSchedule(s, "due");
    const anchor = getSchedule(s.id)!.anchorTaskId!;
    updateTask(anchor, { status: "done" });
    await fireSchedule(getSchedule(s.id)!, "due");
    expect(reopenTask).toHaveBeenCalledWith(anchor, { revive: false });
  });

  it("fresh + 有人值守：每次新卡、走交互式", async () => {
    const s = createSchedule({ title: "b", cron: "0 10 * * *", executor: "project", project: "whale-console", prompt: "p", mode: "fresh", attended: true });
    const a = await fireSchedule(s, "due");
    const b = await fireSchedule(getSchedule(s.id)!, "due");
    expect(a.ref).not.toBe(b.ref);
    expect(startInteractiveJob).toHaveBeenCalledTimes(2);
  });

  it("项目没了：不抛，返回失败", async () => {
    const s = createSchedule({ title: "c", cron: "0 10 * * *", executor: "project", project: "gone", prompt: "p" });
    const r = await fireSchedule(s, "due");
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/项目/);
  });
});

describe("friday 执行方", () => {
  it("系统提示带定时说明，continue 复用同一段会话", async () => {
    const s = createSchedule({ title: "早报", cron: "0 9 * * *", executor: "friday", prompt: "看看今天" });
    const r1 = await fireSchedule(s, "due");
    const r2 = await fireSchedule(getSchedule(s.id)!, "due");
    expect(r1.ref).toBe(r2.ref);
    expect(getConversation(r1.ref!)?.title).toBe("早报");
    const opts = vi.mocked(startRun).mock.calls[0]![2];
    expect(opts.systemPrompt).toContain("定时任务「早报」");
    expect(opts.label).toBe("schedule");
  });

  it("生成结束后把结果写回 last_*，出错写 last_ok=0", async () => {
    const s = createSchedule({ title: "g", cron: "0 9 * * *", executor: "friday", prompt: "p" });
    const finish = async (events: Array<Record<string, unknown>>) => {
      await fireSchedule(getSchedule(s.id)!, "due");
      const cb = vi.mocked(subscribe).mock.calls.at(-1)![1] as (ev: unknown) => void;
      events.forEach(cb);
    };
    await finish([{ type: "delta", text: "结论：都好\n细节" }, { type: "done" }]);
    expect(getSchedule(s.id)).toMatchObject({ lastOk: true, lastResult: "结论：都好" });
    await finish([{ type: "error", message: "炸了" }, { type: "done" }]);
    expect(getSchedule(s.id)).toMatchObject({ lastOk: false, lastResult: "炸了" });
  });

  it("上一轮还在生成就算忙", () => {
    const s = createSchedule({ title: "d", cron: "0 9 * * *", executor: "friday", prompt: "p" });
    updateSchedule(s.id, { conversationId: "c-busy" });
    vi.mocked(isRunning).mockReturnValueOnce(true);
    expect(busyReason(getSchedule(s.id)!)).toMatch(/还在/);
  });
});

describe("call 执行方", () => {
  it("friday 工具直调 handler，参数过 schema", async () => {
    const s = createSchedule({ title: "e", cron: "0 9 * * *", executor: "call", server: "friday", tool: "memory_read", args: { file: "projects" } });
    const r = await fireSchedule(s, "due");
    expect(r.ok).toBe(true);
  });
  it("参数不合 schema 返回失败", async () => {
    const s = createSchedule({ title: "f", cron: "0 9 * * *", executor: "call", server: "friday", tool: "memory_read", args: {} });
    expect((await fireSchedule(s, "due")).ok).toBe(false);
  });
});
