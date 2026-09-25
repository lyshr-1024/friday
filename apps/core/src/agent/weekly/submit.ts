import type { OkrRow, OkrWeeklyDraft } from "@friday/shared";
import { me, quarterReports, submit, type OkrReport } from "../../connectors/okr.js";
import { record } from "../../memory/audit.js";

const LOCKED = new Set(["existing", "submitted"]);
const eligible = (r: OkrRow) => r.checked && !LOCKED.has(r.state) && typeof r.content === "string" && r.content.trim().length > 0;
export const submittable = (d: OkrWeeklyDraft) => d.rows.filter(eligible).length;
export const OKR_SUBMIT_LABEL = (n: number) => `提交 ${n} 条到 OKR`;

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

export async function submitRows(taskId: string, draft: OkrWeeklyDraft): Promise<{ draft: OkrWeeklyDraft; failed: number; conflicts: number }> {
  const rows = [...draft.rows];
  const sent: Array<{ objectId: number; reportId: number }> = [];
  const attempted = rows.flatMap((r, i) => (eligible(r) ? [i] : []));
  if (!attempted.length && !rows.some((r) => r.state === "submitted")) throw new Error("没有要提交的条目：勾上至少一条再提交");

  // 每一轮提交前都查一遍平台：用户可能在别处已经填了这周，上一轮超时的也可能其实已经建成了。
  // 查不清楚就一条都不交——宁可让用户再点一次，也不在平台上留两条同一 KR 同一周的报告。
  let onPlatform = new Map<number, OkrReport>();
  if (attempted.length) {
    try {
      const mine = await me();
      const reports = await quarterReports(mine.id, draft.quarter, draft.week);
      onPlatform = new Map(reports.filter((r) => r.week === draft.week).map((r) => [r.objectId, r]));
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      for (const i of attempted) rows[i] = { ...rows[i]!, state: "failed", error };
      return { draft: { ...draft, rows }, failed: attempted.length, conflicts: 0 };
    }
  }

  let conflicts = 0;
  for (const i of attempted) {
    const r = rows[i]!;
    const hit = onPlatform.get(r.objectId);
    // 只有上一轮 Friday 自己交失败、平台上正文又一字不差的，才认成 Friday 交的（撤销会删它）；
    // 其余一律当用户自己填的：不覆盖、不重交、不进撤销
    if (hit && r.state === "failed" && hit.content.trim() === r.content.trim()) {
      rows[i] = { ...r, state: "submitted", reportId: hit.id, error: undefined };
      sent.push({ objectId: r.objectId, reportId: hit.id });
      continue;
    }
    if (hit) {
      rows[i] = { ...r, state: "existing", content: hit.content, pct: hit.pct, reportId: hit.id, checked: false, why: "平台上这周已经有了", error: undefined };
      conflicts++;
      continue;
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
  // 只数这一轮真的试过又失败的：跳过的行（没勾、清空了）留着旧的 failed 状态不该拦着任务完成
  const failed = attempted.filter((i) => rows[i]!.state === "failed").length;
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
  return { draft: nextDraft, failed, conflicts };
}
