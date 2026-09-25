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
const { getTask, updatePending } = await import("../../memory/tasks.js");
const { state } = await import("../../scheduler/index.js");
const { parseWeek } = await import("./week.js");
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
    expect(r).toEqual({ skipped: "平台上这周的周报已经都填过了" });
  });
});
