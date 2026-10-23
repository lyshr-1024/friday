import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliveryReport } from "@friday/shared";
import { publish } from "../bus.js";
import { db } from "../memory/db.js";
import { listMessages } from "../memory/conversations.js";
import { mainConversationId } from "../memory/mainConversation.js";
import { addPending, createTask, getTask, updateTask } from "../memory/tasks.js";
import { mainNeeds, noticeText, postNotices, presence, startNoticeWatcher } from "./notices.js";
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
    expect(last().payload).toEqual({ need: "blocked" });
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

  it("同一次卡住改 progress 不重发；离开再进入再发", async () => {
    postNotices();
    const t = createTask({ title: "卡", kind: "code", status: "processing", source: {} });
    updateTask(t.id, { status: "blocked", progress: "a" });
    expect(postNotices()).toBe(1);
    updateTask(t.id, { progress: "b" });
    expect(postNotices()).toBe(0);
    updateTask(t.id, { progress: "c" });
    expect(postNotices()).toBe(0);
    updateTask(t.id, { status: "processing" });
    postNotices();
    await new Promise((r) => setTimeout(r, 5));
    updateTask(t.id, { status: "blocked", progress: "d" });
    expect(postNotices()).toBe(1);
  });

  it("旧终端：attention=blocked 发卡住；attention=review 带报告的 processing 发待验收", () => {
    postNotices();
    const a = createTask({ title: "旧卡住", kind: "code", status: "processing", source: {} });
    updateTask(a.id, { attention: "blocked", progress: "缺权限" });
    expect(needOf(getTask(a.id)!)).toMatchObject({ kind: "blocked", key: "blocked-attn:缺权限", reason: "缺权限" });
    expect(postNotices()).toBe(1);
    const r = createTask({ title: "旧交付", kind: "code", status: "processing", source: {} });
    updateTask(r.id, { attention: "review", report: report("R9") });
    expect(needOf(getTask(r.id)!)).toMatchObject({ kind: "review", key: "review:R9", reason: "改好了" });
    expect(postNotices()).toBe(1);
    expect(last().content).toContain("· 待验收");
    expect(last().payload).toEqual({ need: "review" });
  });

  it("待验收按挂着的动作提示怎么收下", () => {
    const m = createTask({ title: "合", kind: "code", status: "review", source: {} });
    updateTask(m.id, { report: report("R1") });
    addPending(m.id, { type: "git_merge", label: "合并", detail: "d", payload: {} } as never);
    const mt = getTask(m.id)!;
    expect(noticeText(mt, needOf(mt)!)).toBe(`#${mt.seq} 合 · 待验收\n交付了：改好了\n测试结果：ok\n说「#${mt.seq} 合并吧」收下，或说哪里不对。`);
    const s = createTask({ title: "发", kind: "code", status: "review", source: {} });
    updateTask(s.id, { report: report("R1") });
    addPending(s.id, { type: "slack_reply", label: "回复", detail: "d", payload: {} } as never);
    const st = getTask(s.id)!;
    expect(noticeText(st, needOf(st)!)).toBe(`#${st.seq} 发 · 待验收\n交付了：改好了\n测试结果：ok\n说「#${st.seq} 发」发出去，或说怎么改。`);
  });

  it("方案待审的文案带开工提示", () => {
    postNotices();
    const t = createTask({ title: "方案", kind: "code", status: "review", plan: "先改 A 再改 B", source: {} });
    addPending(t.id, { type: "brief_approve", label: "批方案", detail: "d", payload: {} } as never);
    expect(postNotices()).toBe(1);
    expect(last().content).toContain("· 方案待审");
    expect(last().payload).toEqual({ need: "brief" });
    expect(last().content).toContain(`说「#${t.seq} 按这个做」开工`);
  });

  it("待验收带截图附件", () => {
    postNotices();
    const t = createTask({ title: "验收", kind: "code", status: "review", source: {} });
    updateTask(t.id, { report: report("R1", { screenshots: [{ name: "a.png", path: "/x/a.png" }] as never }) });
    postNotices();
    expect(last().content).toContain("· 待验收");
    expect((last().payload as { attachments: unknown[] }).attachments).toHaveLength(1);
    expect((last().payload as { need: string }).need).toBe("review");
  });

  it("noticeText 三种模板原样", () => {
    const b = createTask({ title: "方案", kind: "code", status: "review", plan: "先改 A", source: {} });
    addPending(b.id, { type: "brief_approve", label: "批方案", detail: "d", payload: {} } as never);
    const bt = getTask(b.id)!;
    expect(noticeText(bt, needOf(bt)!)).toBe(`#${bt.seq} 方案 · 方案待审\n先改 A\n说「#${bt.seq} 按这个做」开工，或说哪里要改。`);
    const r = createTask({ title: "验收", kind: "code", status: "review", source: {} });
    updateTask(r.id, { report: report("R1") });
    const rt = getTask(r.id)!;
    expect(noticeText(rt, needOf(rt)!)).toBe(`#${rt.seq} 验收 · 待验收\n交付了：改好了\n测试结果：ok`);
    const k = createTask({ title: "卡", kind: "code", status: "blocked", source: {} });
    updateTask(k.id, { progress: "没权限" });
    const kt = getTask(k.id)!;
    expect(noticeText(kt, needOf(kt)!)).toBe(`#${kt.seq} 卡 · 卡住\n没权限`);
  });
});

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

  it("启动时先跑一遍：存量只记不发，之后第一个 tasks 事件照常发", () => {
    vi.useFakeTimers();
    const t = createTask({ title: "旧验收", kind: "code", status: "review", source: {} });
    updateTask(t.id, { report: report() });
    const before = notices().length;
    const stop = startNoticeWatcher();
    expect(notices()).toHaveLength(before);
    updateTask(t.id, { status: "blocked", progress: "卡了" });
    publish({ type: "tasks" });
    vi.advanceTimersByTime(500);
    expect(notices()).toHaveLength(before + 1);
    expect(last().content).toContain("· 卡住");
    stop();
  });
});

describe("presence", () => {
  let T0 = Date.now();
  const min = (n: number) => T0 + n * 60_000;
  beforeEach(() => {
    T0 += 3 * 3600_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    db().exec("DELETE FROM sync_state WHERE source = 'main:away'");
    postNotices();
  });

  it("离开 20 分钟期间来了 notice：聚焦发汇总，并带上还在干的", () => {
    presence(false, T0);
    vi.setSystemTime(T0 + 1000);
    const b = createTask({ title: "卡住的", kind: "code", status: "blocked", source: {} });
    updateTask(b.id, { progress: "没权限" });
    const w = createTask({ title: "自主在跑", kind: "code", status: "processing", source: { autonomous: true } });
    postNotices();
    const m = presence(true, min(20))!;
    expect(m.kind).toBe("notice");
    expect(m.content.split("\n")[0]).toBe("离开这 20 分钟，1 件要你：");
    expect(m.content).toContain(`【卡住】#${getTask(b.id)!.seq} 卡住的 · 没权限`);
    expect(m.content).toContain(`还在干：#${getTask(w.id)!.seq} 自主在跑`);
    expect(m.taskIds).toEqual([b.id]);
    expect(m.payload).toEqual({ digest: true });
    expect(presence(true, min(21))).toBeUndefined();
  });

  it("连续两次失焦不覆盖第一次的离开时间", () => {
    presence(false, T0);
    presence(false, min(10));
    vi.setSystemTime(T0 + 1000);
    const b = createTask({ title: "卡", kind: "code", status: "blocked", source: {} });
    updateTask(b.id, { progress: "x" });
    postNotices();
    expect(presence(true, min(20))?.kind).toBe("notice");
  });

  it("要你的条数为 0（只有在干的）不发汇总，但清掉离开标记", () => {
    presence(false, T0);
    vi.setSystemTime(T0 + 1000);
    const b = createTask({ title: "卡", kind: "code", status: "blocked", source: {} });
    updateTask(b.id, { progress: "x" });
    postNotices();
    updateTask(b.id, { status: "processing" });
    expect(presence(true, min(20))).toBeUndefined();
    expect(presence(true, min(40))).toBeUndefined();
  });

  it("没有新 notice 不发；不足 15 分钟不发；没记离开不发", () => {
    presence(false, T0);
    expect(presence(true, min(20))).toBeUndefined();
    presence(false, T0);
    vi.setSystemTime(T0 + 1000);
    const b = createTask({ title: "卡", kind: "code", status: "blocked", source: {} });
    updateTask(b.id, { progress: "x" });
    postNotices();
    expect(presence(true, T0 + 10 * 60_000)).toBeUndefined();
    expect(presence(true, min(30))).toBeUndefined();
  });
});

describe("挂着待审的 tool_call", () => {
  it("处理中的任务也进等你栏、发主动消息，带放行说法", () => {
    postNotices();
    const t = createTask({ title: "调外部", kind: "code", status: "processing", source: {} });
    addPending(t.id, { type: "tool_call", label: "执行 slack.post", detail: "{}", payload: { tool: "slack", op: "post" } }, { keepStatus: true });
    expect(getTask(t.id)!.status).toBe("processing");
    expect(mainNeeds().blocked.map((x) => x.id)).toContain(t.id);
    expect(postNotices()).toBe(1);
    // 别的用例用假时钟写过更晚的消息，按 taskIds 找这条
    const n = notices().find((m) => m.taskIds?.includes(t.id))!;
    expect(n.content).toContain("执行 slack.post");
    expect(n.content).toContain(`「#${getTask(t.id)!.seq} 执行」`);
  });
});

describe("mainNeeds", () => {
  it("按类分组，working 只含自主在跑的", () => {
    const b = createTask({ title: "卡", kind: "code", status: "blocked", source: {} });
    updateTask(b.id, { progress: "x" });
    const w = createTask({ title: "手动", kind: "code", status: "processing", source: {} });
    const a = createTask({ title: "自主", kind: "code", status: "processing", source: { autonomous: true } });
    const n = mainNeeds();
    expect(n.blocked.map((x) => x.id)).toEqual([b.id]);
    expect(n.blocked[0]?.reason).toBe("x");
    expect(n.working.map((x) => x.id)).toEqual([a.id]);
    expect(n.working.some((x) => x.id === w.id)).toBe(false);
    expect(n.brief).toEqual([]);
    expect(n.queued).toEqual([]);
  });

  it("挂在需求下的缺陷不单独占一行：收进需求那一行，需求落在名下最急的那一组", () => {
    const story = createTask({ title: "清结算需求", kind: "meegle", status: "understood", source: { meegleType: "story", meegleId: "fold-1" } });
    const report = { at: "R", summary: "修好了", changes: [], testSteps: [], testResult: "过", screenshots: [], verify: [] };
    const a = createTask({ title: "缺陷 A", kind: "meegle", status: "review", source: { meegleType: "issue", rootId: story.id, handedAt: "x" } });
    updateTask(a.id, { report } as never);
    const b = createTask({ title: "缺陷 B", kind: "meegle", status: "review", source: { meegleType: "issue", linkedStoryId: "fold-1", handedAt: "x" } });
    updateTask(b.id, { report } as never);
    const c = createTask({ title: "缺陷 C", kind: "meegle", status: "processing", source: { meegleType: "issue", rootId: story.id, handedAt: "x", autonomous: true } });
    const n = mainNeeds();
    const all = Object.values(n).flat().map((x) => x.id);
    for (const d of [a, b, c]) expect(all).not.toContain(d.id);
    const row = n.review.find((x) => x.id === story.id)!;
    expect(row.reason).toContain("名下缺陷：2 条修完待核验、1 条在修");
  });

  it("没挂需求、或需求已经收工的缺陷照旧单独一行", () => {
    const done = createTask({ title: "收工的需求", kind: "meegle", status: "done", source: { meegleType: "story", meegleId: "fold-2" } });
    const d = createTask({ title: "孤缺陷", kind: "code", status: "blocked", source: { meegleType: "issue", rootId: done.id } });
    expect(mainNeeds().blocked.map((x) => x.id)).toContain(d.id);
  });
});
