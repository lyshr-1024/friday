import { describe, expect, it } from "vitest";
import type { DeliveryReport, Task } from "@friday/shared";
import { addMessage, createConversation } from "../memory/conversations.js";
import { createTask, updateTask } from "../memory/tasks.js";
import { boardBlock, needOf } from "./needs.js";

const mk = (over: Partial<Task> = {}): Task =>
  ({ id: "t1", seq: 1, title: "t", kind: "code", status: "processing", priority: "normal", source: {}, createdAt: "2026-10-22T00:00:00Z", updatedAt: "2026-10-22T00:00:00Z", ...over }) as Task;
const report = (at = "2026-10-22T01:00:00Z"): DeliveryReport => ({ summary: "改好了", changes: [], testSteps: [], testResult: "ok", screenshots: [], verify: [], at }) as unknown as DeliveryReport;
const act = (id: string, type: string, label = "L", detail = "D") => ({ id, type, label, detail, payload: {} }) as never;

describe("needOf", () => {
  it("例行卡与收工的任务没有 need", () => {
    expect(needOf(mk({ kind: "okr_weekly", status: "review", report: report() }))).toBeUndefined();
    expect(needOf(mk({ kind: "handbook", status: "blocked" }))).toBeUndefined();
    expect(needOf(mk({ kind: "project", status: "blocked" }))).toBeUndefined();
    expect(needOf(mk({ status: "done", report: report() }))).toBeUndefined();
    expect(needOf(mk({ status: "ignored", attention: "question" }))).toBeUndefined();
  });

  it("挂着 brief_approve 是方案待审，reason 取 plan 前 120 字", () => {
    const n = needOf(mk({ status: "review", plan: "x".repeat(200), pending: [act("a", "brief_approve")], source: { brief: { at: "B1" } as never } }))!;
    expect(n).toEqual({ kind: "brief", key: "brief:B1", reason: "x".repeat(120) });
  });

  it("brief 没有 at 时 key 用任务 id，不同卡不撞", () => {
    const a = needOf(mk({ id: "ta", status: "review", pending: [act("a", "brief_approve")] }))!;
    const b = needOf(mk({ id: "tb", status: "review", pending: [act("a", "brief_approve")] }))!;
    expect(a.key).toBe("brief:ta");
    expect(b.key).not.toBe(a.key);
  });

  it("blocked 状态", () => {
    expect(needOf(mk({ status: "blocked", progress: "没权限", source: { blockedAt: "T1" } }))).toEqual({ kind: "blocked", key: "blocked:T1", reason: "没权限" });
    expect(needOf(mk({ id: "tx", status: "blocked", progress: "没权限" }))?.key).toBe("blocked:tx");
  });

  it("attention 是 question / intake", () => {
    expect(needOf(mk({ attention: "question", progress: "选哪个" }))).toEqual({ kind: "blocked", key: "question:选哪个", reason: "选哪个" });
    expect(needOf(mk({ attention: "intake", progress: "哪个项目" }))).toEqual({ kind: "blocked", key: "intake:哪个项目", reason: "哪个项目" });
  });

  it("挂着 reproject / discard_changes / start_job", () => {
    const n = needOf(mk({ status: "review", pending: [act("p1", "start_job", "开工审批", "d".repeat(200))] }))!;
    expect(n.kind).toBe("blocked");
    expect(n.key).toBe("decide:p1");
    expect(n.reason).toBe(`开工审批：${"d".repeat(120)}`);
    expect(needOf(mk({ pending: [act("p2", "reproject")] }))?.key).toBe("decide:p2");
    expect(needOf(mk({ pending: [act("p3", "discard_changes")] }))?.key).toBe("decide:p3");
  });

  it("review 有 report 才是待验收", () => {
    expect(needOf(mk({ status: "review", report: report("R1") }))).toEqual({ kind: "review", key: "review:R1", reason: "改好了" });
    expect(needOf(mk({ status: "review" }))).toBeUndefined();
  });

  it("其余没有", () => {
    expect(needOf(mk())).toBeUndefined();
  });
});

describe("boardBlock", () => {
  it("每条开着的任务一行，状态取 need / 在干", () => {
    const conv = createConversation().id;
    const a = createTask({ title: "改 segment", kind: "code", project: "demo", status: "processing", stage: "dev", source: {} });
    const b = createTask({ title: "验收这个", kind: "code", project: "demo", status: "review", source: {} });
    updateTask(b.id, { report: report() });
    const out = boardBlock(conv);
    expect(out).toContain(`#${a.seq} · demo · 改 segment`);
    expect(out).toContain("在干");
    expect(out).toMatch(new RegExp(`#${b.seq} · demo · 验收这个 · 待验收`));
  });

  it("最近 3 条消息碰过的任务给完整块", () => {
    const conv = createConversation().id;
    const t = createTask({ title: "知许：改 segment", kind: "slack", status: "processing", understanding: "过期饲料罐提交逻辑要改", plan: "variant_mode 改 exclusive", source: {} });
    const other = createTask({ title: "没碰过的", kind: "slack", status: "processing", understanding: "不该出现的理解", source: {} });
    addMessage(conv, { role: "assistant", kind: "note", content: "好", taskIds: [t.id] });
    const out = boardBlock(conv);
    expect(out).toContain("variant_mode 改 exclusive");
    expect(out).not.toContain("不该出现的理解");
    expect(other.seq).toBeGreaterThan(0);
  });

  it("Friday 自己问的归属问题不说成终端在问", () => {
    const conv = createConversation().id;
    const t = createTask({ title: "开户详情页", kind: "meegle", status: "understood", source: {} });
    updateTask(t.id, { attention: "intake", progress: "这条工单是财富后台还是新BO项目的？" });
    addMessage(conv, { role: "assistant", kind: "note", content: "问", taskIds: [t.id] });
    const out = boardBlock(conv);
    expect(out).toContain("这条工单是财富后台");
    expect(out).not.toContain("终端正停在");
    expect(out).not.toContain("terminal_say");
    expect(out).toContain("task_update");
  });

  it("终端在问：完整块说明终端停在提问上，让用户选而不是自己选", () => {
    const conv = createConversation().id;
    const t = createTask({ title: "改弹窗", kind: "code", status: "processing", source: {} });
    updateTask(t.id, { attention: "question", progress: "用 A 还是 B？" });
    addMessage(conv, { role: "assistant", kind: "note", content: "问", taskIds: [t.id] });
    const out = boardBlock(conv);
    expect(out).toContain("终端正停在一个交互式提问上等用户回答（用 A 还是 B？）");
    expect(out).toContain("terminal_say");
  });

  it("完整块带最近一次交付，验证点确认进度写在后面", () => {
    const conv = createConversation().id;
    const t = createTask({ title: "改列宽", kind: "code", status: "review", source: {} });
    updateTask(t.id, { report: { ...report(), verify: ["看列宽", "看表头"], checked: [true, false] } as never });
    addMessage(conv, { role: "assistant", kind: "note", content: "好", taskIds: [t.id] });
    expect(boardBlock(conv)).toContain("最近一次交付：改好了（测试：ok）；验证点用户已确认 1/2");
  });

  it("标题里有换行不会把一行拆成多行", () => {
    const conv = createConversation().id;
    const t = createTask({ title: "第一行\n  第二行\r\n第三行", kind: "code", project: "demo", status: "processing", source: {} });
    const line = boardBlock(conv).split("\n").find((l) => l.startsWith(`#${t.seq} `))!;
    expect(line).toContain("第一行 第二行 第三行 ·");
  });

  it("完整块也算进 6000：单块超长被截断并带标记，三块都超长也不爆", () => {
    const conv = createConversation().id;
    const ids = [1, 2, 3].map((i) => createTask({ title: `大任务${i}`, kind: "slack", status: "processing", understanding: `理解${i}\n` + "长".repeat(10_000), source: {} }));
    addMessage(conv, { role: "assistant", kind: "note", content: "a", taskIds: [ids[0]!.id] });
    const one = boardBlock(conv);
    expect(one.length).toBeLessThanOrEqual(6000);
    expect(one).toContain(`#${ids[0]!.seq}`);
    expect(one).toContain(`task_get #${ids[0]!.seq} 看全文`);
    addMessage(conv, { role: "assistant", kind: "note", content: "b", taskIds: ids.map((t) => t.id) });
    const all = boardBlock(conv);
    expect(all.length).toBeLessThanOrEqual(6000);
    expect(all).toContain("看全文");
  });

  it("300 条任务不超 6000 字，待验收的还在", () => {
    const conv = createConversation().id;
    for (let i = 0; i < 300; i++) createTask({ title: `任务${i} ${"长".repeat(40)}`, kind: "code", project: "demo", status: "understood", source: {} });
    const r = createTask({ title: "要验收的那条", kind: "code", project: "demo", status: "review", source: {} });
    updateTask(r.id, { report: report() });
    const out = boardBlock(conv);
    expect(out.length).toBeLessThanOrEqual(6000);
    expect(out).toContain(`#${r.seq} · demo · 要验收的那条`);
  });
});
