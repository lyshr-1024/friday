import type { OkrWeeklyDraft } from "@friday/shared";
import { submit } from "../../connectors/okr.js";
import { record } from "../../memory/audit.js";

const LOCKED = new Set(["existing", "submitted"]);

export function mergeEdits(draft: OkrWeeklyDraft, edits: Array<{ objectId: number; content?: string; pct?: number; checked?: boolean }>): OkrWeeklyDraft {
  const by = new Map(edits.map((e) => [e.objectId, e]));
  return {
    ...draft,
    rows: draft.rows.map((r) => {
      const e = by.get(r.objectId);
      if (!e || LOCKED.has(r.state)) return r;
      return {
        ...r,
        ...(typeof e.content === "string" ? { content: e.content } : {}),
        ...(typeof e.pct === "number" && Number.isFinite(e.pct) ? { pct: Math.min(100, Math.max(0, e.pct)) } : {}),
        ...(typeof e.checked === "boolean" ? { checked: e.checked } : {}),
      };
    }),
  };
}

export async function submitRows(taskId: string, draft: OkrWeeklyDraft): Promise<{ draft: OkrWeeklyDraft; failed: number }> {
  const rows = [...draft.rows];
  const sent: Array<{ objectId: number; reportId: number }> = [];
  for (const [i, r] of rows.entries()) {
    if (!r.checked || LOCKED.has(r.state) || !r.content.trim()) continue;
    try {
      const reportId = await submit({ objectId: r.objectId, week: draft.week, quarter: draft.quarter, content: r.content.trim(), pct: r.pct });
      rows[i] = { ...r, state: "submitted", reportId, error: undefined };
      sent.push({ objectId: r.objectId, reportId });
    } catch (e) {
      rows[i] = { ...r, state: "failed", error: e instanceof Error ? e.message : String(e) };
    }
  }
  if (sent.length) {
    record({
      taskId,
      action: "okr_submit",
      why: "你审核通过",
      how: `提交了 ${draft.week} 的 ${sent.length} 条周报到 OKR 平台`,
      evidence: { week: draft.week, reports: sent },
      risk: "reversible",
      status: "approved",
      undo: { kind: "delete_okr_reports", ids: sent.map((s) => s.reportId) },
    });
  }
  return { draft: { ...draft, rows }, failed: rows.filter((r) => r.state === "failed").length };
}
