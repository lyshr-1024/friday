import type { OkrRow, OkrWeeklyDraft } from "@friday/shared";
import { me, quarterReports, submit } from "../../connectors/okr.js";
import { record } from "../../memory/audit.js";

const LOCKED = new Set(["existing", "submitted"]);
const eligible = (r: OkrRow) => r.checked && !LOCKED.has(r.state) && typeof r.content === "string" && r.content.trim().length > 0;

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

/** submitRows 内部记账失败时抛出：带着已经提交成功的最新 draft，调用方拿它放回待审动作，不能用没更新过的旧 payload。 */
export class SubmitPartialError extends Error {
  constructor(public draft: OkrWeeklyDraft, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

export async function submitRows(taskId: string, draft: OkrWeeklyDraft): Promise<{ draft: OkrWeeklyDraft; failed: number }> {
  const rows = [...draft.rows];
  const sent: Array<{ objectId: number; reportId: number }> = [];
  const attempted = new Set<number>();

  // 上一轮失败的行重试前先查一遍平台：submit() 超时或提交后查 id 失败都可能是平台其实已经建成了报告，
  // 不查清楚就重交会在平台上留下两条同一 KR 同一周的报告，违反「绝不重交」。
  let platformReportId: Map<number, number> | undefined;
  let precheckError: string | undefined;
  if (rows.some((r) => eligible(r) && r.state === "failed")) {
    try {
      const mine = await me();
      const reports = await quarterReports(mine.id, draft.quarter, draft.week);
      platformReportId = new Map(reports.filter((r) => r.week === draft.week).map((r) => [r.objectId, r.id]));
    } catch (e) {
      precheckError = e instanceof Error ? e.message : String(e);
    }
  }

  for (const [i, r] of rows.entries()) {
    if (!eligible(r)) continue;
    attempted.add(i);
    if (r.state === "failed") {
      const already = platformReportId?.get(r.objectId);
      if (already !== undefined) {
        rows[i] = { ...r, state: "submitted", reportId: already, error: undefined };
        sent.push({ objectId: r.objectId, reportId: already });
        continue;
      }
      if (precheckError) {
        rows[i] = { ...r, state: "failed", error: precheckError };
        continue;
      }
    }
    try {
      const reportId = await submit({ objectId: r.objectId, week: draft.week, quarter: draft.quarter, content: r.content.trim(), pct: r.pct });
      rows[i] = { ...r, state: "submitted", reportId, error: undefined };
      sent.push({ objectId: r.objectId, reportId });
    } catch (e) {
      rows[i] = { ...r, state: "failed", error: e instanceof Error ? e.message : String(e) };
    }
  }

  const nextDraft = { ...draft, rows };
  // 只数这一轮真的试过（提交或靠预查对上）又失败的：跳过的行（没勾、清空了）留着旧的 failed 状态不该拦着任务完成
  const failed = [...attempted].filter((i) => rows[i]!.state === "failed").length;
  if (sent.length) {
    try {
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
    } catch (e) {
      // 已经提交成功的行不能因为记账失败就被当成没交：把更新过的 draft 带出去
      throw new SubmitPartialError(nextDraft, e);
    }
  }
  return { draft: nextDraft, failed };
}
