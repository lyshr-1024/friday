import { beforeEach, describe, expect, it, vi } from "vitest";

const okr = vi.hoisted(() => ({
  me: vi.fn(async () => ({ id: 9, name: "me" })),
  myKRs: vi.fn(async () => [
    { id: 10, name: "出入金迁移", objective: "O1", quarter: "2026Q3" },
    { id: 11, name: "组件修复", objective: "O2", quarter: "2026Q3" },
    { id: 12, name: "已手填", objective: "O2", quarter: "2026Q3" },
  ]),
  quarterReports: vi.fn(async () => [
    { id: 1, objectId: 10, week: "2026W0914-0920", content: "上周 A", pct: 90 },
    { id: 2, objectId: 12, week: "2026W0921-0927", content: "我自己填的", pct: 50 },
  ]),
}));
vi.mock("../../connectors/okr.js", async (orig) => ({ ...(await orig<typeof import("../../connectors/okr.js")>()), ...okr }));
vi.mock("./collect.js", () => ({ collectMaterials: vi.fn(() => [{ id: "g1", text: "[whale-console] fix: 出金" }]) }));
const draft = vi.hoisted(() => ({ draftWithModel: vi.fn(async () => ({ items: [{ objectId: 10, content: "修了出金", pct: 90, why: "沿用", used: ["g1"] }], unmatched: [] })) }));
vi.mock("./draft.js", () => draft);

const { draftWeeklyOnce } = await import("./index.js");
const { getTask, updatePending, updateTask } = await import("../../memory/tasks.js");
const { state } = await import("../../scheduler/index.js");
const { parseWeek } = await import("./week.js");
const { getCursor } = await import("../../memory/inbox.js");
import type { OkrWeeklyDraft } from "@friday/shared";

const W = parseWeek("2026W0921-0927")!;
const draftOf = (id: string) => getTask(id)!.pending!.find((p) => p.type === "okr_submit")!.payload as unknown as OkrWeeklyDraft;

describe("起草一轮", () => {
  beforeEach(() => { state.notices.splice(0); });

  it("有素材的出草稿并勾上，没素材的默认不勾，平台已有的标 existing 不覆盖", async () => {
    const r = await draftWeeklyOnce({ week: W, manual: true });
    if (!("taskId" in r)) throw new Error(r.skipped);
    const t = getTask(r.taskId)!;
    expect(t.kind).toBe("okr_weekly");
    expect(t.status).toBe("review");
    const rows = draftOf(t.id).rows;
    expect(rows.find((x) => x.objectId === 10)).toMatchObject({ state: "draft", checked: true, content: "修了出金", prevPct: 90, used: [{ id: "g1", text: "[whale-console] fix: 出金" }] });
    expect(rows.find((x) => x.objectId === 11)).toMatchObject({ state: "empty", checked: false, content: "" });
    expect(rows.find((x) => x.objectId === 12)).toMatchObject({ state: "existing", checked: false, content: "我自己填的", reportId: 2 });
    expect(state.notices.some((n) => n.taskId === t.id && n.title.includes("2026W0921-0927"))).toBe(true);
  });

  it("重跑同一周：覆盖草稿但保留已提交的行，不另建卡", async () => {
    const first = (await draftWeeklyOnce({ week: W, manual: true })) as { taskId: string };
    const t = getTask(first.taskId)!;
    const action = t.pending!.find((p) => p.type === "okr_submit")!;
    const d = draftOf(t.id);
    d.rows = d.rows.map((x) => (x.objectId === 10 ? { ...x, state: "submitted", reportId: 500, content: "已交的" } : x));
    updatePending(t.id, action.id, { payload: d as unknown as Record<string, unknown> });
    const again = (await draftWeeklyOnce({ week: W, manual: true })) as { taskId: string };
    expect(again.taskId).toBe(t.id);
    expect(draftOf(t.id).rows.find((x) => x.objectId === 10)).toMatchObject({ state: "submitted", reportId: 500, content: "已交的" });
  });

  it("已经交完的卡手动重跑：交过的行从平台读回成 existing，不会再交一次", async () => {
    const w = parseWeek("2026W0810-0816")!;
    const first = (await draftWeeklyOnce({ week: w, manual: true })) as { taskId: string };
    updateTask(first.taskId, { status: "done", pending: [] });
    okr.quarterReports.mockResolvedValueOnce([{ id: 700, objectId: 10, week: w.id, content: "修了出金", pct: 90 }]);
    const again = (await draftWeeklyOnce({ week: w, manual: true })) as { taskId: string };
    expect(again.taskId).toBe(first.taskId);
    const t = getTask(again.taskId)!;
    expect(t.status).toBe("review");
    expect(draftOf(t.id).rows.find((x) => x.objectId === 10)).toMatchObject({ state: "existing", checked: false, reportId: 700 });
    expect(t.pending!.find((p) => p.type === "okr_submit")!.label).toBe("提交 0 条到 OKR…");
  });

  it("连不上 OKR 平台：照样建卡，卡住并写明原因", async () => {
    const { OkrError } = await import("../../connectors/okr.js");
    okr.myKRs.mockRejectedValueOnce(new OkrError("~/.claude.json 里没有 mcpServers.okr"));
    const r = (await draftWeeklyOnce({ week: parseWeek("2026W0907-0913")!, manual: true })) as { taskId: string };
    const t = getTask(r.taskId)!;
    expect(t.status).toBe("blocked");
    expect(t.progress).toContain("连不上 OKR 平台");
    expect(t.progress).toContain("mcpServers.okr");
  });

  it("自动模式：平台上这周所有 KR 都已经填过了就不建卡", async () => {
    okr.quarterReports.mockResolvedValueOnce([10, 11, 12].map((o, i) => ({ id: 100 + i, objectId: o, week: "2026W0831-0906", content: "x", pct: 1 })));
    const r = await draftWeeklyOnce({ week: parseWeek("2026W0831-0906")!, manual: false });
    expect(r).toEqual({ skipped: "平台上这周已经有你填的周报了" });
  });

  it("自动模式：平台上这周只要有一条自己填的就跳过，并记下跑过，不再每半小时查一遍", async () => {
    const w = parseWeek("2026W0803-0809")!;
    okr.quarterReports.mockResolvedValueOnce([{ id: 300, objectId: 11, week: w.id, content: "手填", pct: 10 }]);
    const r = await draftWeeklyOnce({ week: w, manual: false });
    expect(r).toEqual({ skipped: "平台上这周已经有你填的周报了" });
    expect(getCursor(`okr:drafted:${w.id}`)).toBeTruthy();
  });

  it("手动模式：平台上有一条也照样起草，剩下的 KR 出草稿", async () => {
    const w = parseWeek("2026W0727-0802")!;
    okr.quarterReports.mockResolvedValueOnce([{ id: 301, objectId: 11, week: w.id, content: "手填", pct: 10 }]);
    const r = await draftWeeklyOnce({ week: w, manual: true });
    if (!("taskId" in r)) throw new Error(r.skipped);
    const rows = draftOf(r.taskId).rows;
    expect(rows.find((x) => x.objectId === 11)).toMatchObject({ state: "existing" });
    expect(rows.find((x) => x.objectId === 10)).toMatchObject({ state: "draft" });
  });
});

describe("自动起草", () => {
  it("开关关掉不跑；跑过一次同一周不再跑", async () => {
    const { autoDraftTick } = await import("./index.js");
    const { updateSettings } = await import("../../settings.js");
    const friday = new Date(2026, 7, 28, 17, 0); // 2026-08-28 周五 17:00 → 2026W0824-0830
    draft.draftWithModel.mockClear();
    updateSettings({ okrWeekly: false });
    await autoDraftTick(friday);
    expect(draft.draftWithModel).toHaveBeenCalledTimes(0);
    updateSettings({ okrWeekly: true });
    await autoDraftTick(friday);
    await autoDraftTick(friday);
    expect(draft.draftWithModel).toHaveBeenCalledTimes(1);
  });
});
