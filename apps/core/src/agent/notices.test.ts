import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliveryReport } from "@friday/shared";
import { publish } from "../bus.js";
import { db } from "../memory/db.js";
import { listMessages } from "../memory/conversations.js";
import { mainConversationId } from "../memory/mainConversation.js";
import { addPending, createTask, updateTask } from "../memory/tasks.js";
import { noticeText, postNotices, startNoticeWatcher } from "./notices.js";
import { needOf } from "./needs.js";

const report = (at = "R1", over: Partial<DeliveryReport> = {}): DeliveryReport =>
  ({ summary: "改好了", changes: [], testSteps: [], testResult: "ok", screenshots: [], verify: [], at, ...over }) as unknown as DeliveryReport;
const notices = () => listMessages(mainConversationId()).filter((m) => m.kind === "notice");
const last = () => notices().at(-1)!;

beforeEach(() => {
  db().exec("DELETE FROM tasks; DELETE FROM sync_state WHERE source LIKE 'notice:%'");
});
afterEach(() => vi.useRealTimers());

describe("postNotices", () => {
  it("第一次跑只记不发，之后进入状态才发", () => {
    const n0 = notices().length;
    const r = createTask({ title: "旧的待验收", kind: "code", status: "review", source: {} });
    updateTask(r.id, { report: report() });
    expect(postNotices()).toBe(0);
    expect(notices()).toHaveLength(n0);
    const b = createTask({ title: "卡住的", kind: "code", status: "blocked", source: {} });
    updateTask(b.id, { progress: "没权限" });
    expect(postNotices()).toBe(1);
    expect(last().content).toContain("· 卡住");
    expect(last().taskIds).toEqual([b.id]);
    expect(last().role).toBe("assistant");
    expect(postNotices()).toBe(0);
  });

  it("同一状态不重发：改 progress、勾验证点不发；第二轮交付再发", () => {
    postNotices();
    const t = createTask({ title: "验收", kind: "code", status: "review", source: {} });
    updateTask(t.id, { report: report("R1", { verify: ["a"] }) });
    expect(postNotices()).toBe(1);
    updateTask(t.id, { progress: "又说了一句", report: report("R1", { verify: ["a"], checked: [true] }) });
    expect(postNotices()).toBe(0);
    updateTask(t.id, { report: report("R2") });
    expect(postNotices()).toBe(1);
  });

  it("离开状态再回来会再发", () => {
    postNotices();
    const t = createTask({ title: "卡", kind: "code", status: "blocked", source: {} });
    updateTask(t.id, { progress: "x" });
    expect(postNotices()).toBe(1);
    updateTask(t.id, { status: "processing" });
    expect(postNotices()).toBe(0);
    updateTask(t.id, { status: "blocked" });
    expect(postNotices()).toBe(1);
  });

  it("方案待审的文案带开工提示", () => {
    postNotices();
    const t = createTask({ title: "方案", kind: "code", status: "review", plan: "先改 A 再改 B", source: {} });
    addPending(t.id, { type: "brief_approve", label: "批方案", detail: "d", payload: {} } as never);
    expect(postNotices()).toBe(1);
    expect(last().content).toContain("· 方案待审");
    expect(last().content).toContain(`说「#${t.seq} 按这个做」开工`);
  });

  it("待验收带截图附件", () => {
    postNotices();
    const t = createTask({ title: "验收", kind: "code", status: "review", source: {} });
    updateTask(t.id, { report: report("R1", { screenshots: [{ name: "a.png", path: "/x/a.png" }] as never }) });
    postNotices();
    expect(last().content).toContain("· 待验收");
    expect((last().payload as { attachments: unknown[] }).attachments).toHaveLength(1);
  });

  it("noticeText 按模板拼", () => {
    const t = createTask({ title: "卡", kind: "code", status: "blocked", source: {} });
    updateTask(t.id, { progress: "没权限" });
    const full = (await_(t.id));
    expect(noticeText(full, needOf(full)!)).toBe(`#${full.seq} 卡 · 卡住\n没权限`);
  });
});

import { getTask } from "../memory/tasks.js";
const await_ = (id: string) => getTask(id)!;

describe("startNoticeWatcher", () => {
  it("tasks 事件 500ms 合并后只跑一次", () => {
    vi.useFakeTimers();
    postNotices();
    const before = notices().length;
    const stop = startNoticeWatcher();
    const t = createTask({ title: "卡", kind: "code", status: "blocked", source: {} });
    updateTask(t.id, { progress: "x" });
    publish({ type: "tasks" });
    publish({ type: "tasks" });
    expect(notices()).toHaveLength(before);
    vi.advanceTimersByTime(500);
    expect(notices()).toHaveLength(before + 1);
    stop();
    publish({ type: "tasks" });
    vi.advanceTimersByTime(1000);
    expect(notices()).toHaveLength(before + 1);
  });
});
