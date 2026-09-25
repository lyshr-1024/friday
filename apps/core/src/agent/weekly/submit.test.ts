import { describe, expect, it, vi } from "vitest";
import type { OkrWeeklyDraft } from "@friday/shared";

const okr = vi.hoisted(() => ({ submit: vi.fn(), remove: vi.fn(async (_id: number) => {}) }));
vi.mock("../../connectors/okr.js", async (orig) => ({ ...(await orig<typeof import("../../connectors/okr.js")>()), ...okr }));

const { app } = await import("../../api/index.js");
const { createTask, addPending, getTask } = await import("../../memory/tasks.js");
const { listAudit } = await import("../../memory/audit.js");
const { mergeEdits } = await import("./submit.js");

const row = (objectId: number, over: Partial<OkrWeeklyDraft["rows"][number]> = {}) => ({ objectId, kr: `KR${objectId}`, objective: "O", content: `正文${objectId}`, pct: 50, prevPct: 40, why: "", used: [], checked: true, state: "draft" as const, ...over });

function card(rows: OkrWeeklyDraft["rows"]) {
  const t = createTask({ title: "OKR 周报 · 2026W0921-0927", kind: "okr_weekly", source: { okrWeek: "2026W0921-0927" }, status: "review" });
  const draft: OkrWeeklyDraft = { week: "2026W0921-0927", quarter: "2026Q3", rows, unmatched: [] };
  const withAction = addPending(t.id, { type: "okr_submit", label: "提交", detail: "", payload: draft as unknown as Record<string, unknown> })!;
  return { id: t.id, actionId: withAction.pending![0]!.id };
}
const payloadOf = (id: string) => getTask(id)!.pending!.find((p) => p.type === "okr_submit")!.payload as unknown as OkrWeeklyDraft;

describe("提交 OKR 周报", () => {
  it("只交勾上的草稿；existing 和空正文不交；全成功任务完成，记账可撤销", async () => {
    okr.submit.mockReset().mockResolvedValueOnce(501).mockResolvedValueOnce(502);
    const { id, actionId } = card([row(1), row(2), row(3, { checked: false }), row(4, { state: "existing", reportId: 9 }), row(5, { content: "  " })]);
    const res = await app.request(`/tasks/${id}/approve/${actionId}`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(okr.submit.mock.calls.map((c) => c[0].objectId)).toEqual([1, 2]);
    expect(getTask(id)!.status).toBe("done");
    const ev = listAudit({ taskId: id }).find((e) => e.action === "okr_submit")!;
    expect(ev.reversible).toBe(true);
    const undo = await app.request(`/audit/${ev.id}/undo`, { method: "POST" });
    expect(undo.status).toBe(200);
    expect(okr.remove.mock.calls.map((c) => c[0])).toEqual([501, 502]);
  });

  it("部分失败：成功的记下 reportId 不重交，失败的留在卡上，按钮变重试", async () => {
    okr.submit.mockReset().mockResolvedValueOnce(601).mockRejectedValueOnce(new Error("INVALID_ARGUMENT"));
    const { id, actionId } = card([row(1), row(2)]);
    await app.request(`/tasks/${id}/approve/${actionId}`, { method: "POST" });
    const t = getTask(id)!;
    expect(t.status).toBe("review");
    const d = payloadOf(id);
    expect(d.rows[0]).toMatchObject({ state: "submitted", reportId: 601 });
    expect(d.rows[1]).toMatchObject({ state: "failed", error: "INVALID_ARGUMENT" });
    expect(t.pending!.find((p) => p.type === "okr_submit")!.label).toBe("重试剩下的 1 条");

    okr.submit.mockReset().mockResolvedValueOnce(602);
    const retry = getTask(id)!.pending!.find((p) => p.type === "okr_submit")!;
    await app.request(`/tasks/${id}/approve/${retry.id}`, { method: "POST" });
    expect(okr.submit.mock.calls.map((c) => c[0].objectId)).toEqual([2]);
    expect(getTask(id)!.status).toBe("done");
  });

  it("PUT okr-draft 逐字段合并，进度钳在 0–100，重算按钮文案", async () => {
    const { id } = card([row(1), row(2)]);
    const res = await app.request(`/tasks/${id}/okr-draft`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ rows: [{ objectId: 1, content: "改过的" }, { objectId: 2, checked: false, pct: 130 }] }) });
    expect(res.status).toBe(200);
    const d = payloadOf(id);
    expect(d.rows[0]).toMatchObject({ content: "改过的", pct: 50, checked: true });
    expect(d.rows[1]).toMatchObject({ checked: false, pct: 100 });
    expect(getTask(id)!.pending![0]!.label).toBe("提交 1 条到 OKR…");
  });

  it("mergeEdits 不让改 existing / submitted 的行", () => {
    const d: OkrWeeklyDraft = { week: "w", quarter: "q", rows: [row(1, { state: "submitted", reportId: 1 }), row(2, { state: "existing" })], unmatched: [] };
    const out = mergeEdits(d, [{ objectId: 1, content: "x", checked: true }, { objectId: 2, content: "y", checked: true }]);
    expect(out.rows.map((r) => r.content)).toEqual(["正文1", "正文2"]);
  });
});
