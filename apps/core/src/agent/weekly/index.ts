import type { OkrRow, OkrWeeklyDraft, Task } from "@friday/shared";
import { OkrError, me, myKRs, quarterReports } from "../../connectors/okr.js";
import { record } from "../../memory/audit.js";
import { getCursor, setCursor } from "../../memory/inbox.js";
import { addPending, createTask, findTaskBySource, updatePending, updateTask } from "../../memory/tasks.js";
import { state } from "../../scheduler/index.js";
import { userSettings } from "../../settings.js";
import { collectMaterials } from "./collect.js";
import { draftWithModel, type KrContext } from "./draft.js";
import { OKR_SUBMIT_LABEL, submittable } from "./submit.js";
import { targetWeek, type Week } from "./week.js";

export type WeeklyResult = { taskId: string; drafted: number; empty: number } | { skipped: string };

const ranKey = (w: Week) => `okr:drafted:${w.id}`;

function cardFor(week: Week): Task | undefined {
  return findTaskBySource((s) => s.okrWeek === week.id, true);
}

function upsertCard(week: Week, patch: Parameters<typeof updateTask>[1]): Task {
  const cur = cardFor(week);
  if (cur) return updateTask(cur.id, patch)!;
  const t = createTask({ title: `OKR 周报 · ${week.id}`, kind: "okr_weekly", source: { okrWeek: week.id }, status: "review" });
  return updateTask(t.id, patch)!;
}

export async function draftWeeklyOnce(opts: { week?: Week; manual: boolean }): Promise<WeeklyResult> {
  const week = opts.week ?? targetWeek(new Date());
  const existingCard = cardFor(week);
  if (existingCard?.status === "done" && !opts.manual) return { skipped: "这周已经提交过了" };
  let krs, mine, reports;
  try {
    [krs, mine] = await Promise.all([myKRs(), me()]);
    reports = krs.length ? await quarterReports(mine.id, krs[0]!.quarter) : [];
  } catch (e) {
    if (!(e instanceof OkrError)) throw e;
    const t = upsertCard(week, { status: "blocked", progress: `连不上 OKR 平台：${e.message}`, pending: [] });
    setCursor(ranKey(week), new Date().toISOString());
    return { taskId: t.id, drafted: 0, empty: 0 };
  }
  const quarter = krs[0]?.quarter ?? "";
  const existing = new Map(reports.filter((r) => r.week === week.id).map((r) => [r.objectId, r]));
  // 自动模式只在平台上这周一条都没有时才起草：有一条就说明用户已经在别处动手填了
  if (!opts.manual && existing.size > 0) {
    setCursor(ranKey(week), new Date().toISOString());
    return { skipped: "平台上这周已经有你填的周报了" };
  }
  const prev = (id: number) => reports.filter((r) => r.objectId === id && r.week < week.id).sort((a, b) => b.week.localeCompare(a.week))[0];
  const ctx: KrContext[] = krs.filter((k) => !existing.has(k.id)).map((k) => ({ kr: k, prevContent: prev(k.id)?.content ?? null, prevPct: prev(k.id)?.pct ?? null }));

  const materials = await collectMaterials(week);
  const text = new Map(materials.map((m) => [m.id, m.text]));
  let drafted = { items: [] as Awaited<ReturnType<typeof draftWithModel>>["items"], unmatched: [] as string[] };
  try {
    if (materials.length && ctx.length) drafted = await draftWithModel(ctx, materials);
  } catch (e) {
    const t = upsertCard(week, { status: "blocked", progress: e instanceof Error ? e.message : String(e), pending: [] });
    setCursor(ranKey(week), new Date().toISOString());
    return { taskId: t.id, drafted: 0, empty: 0 };
  }

  const old = existingCard?.pending?.find((p) => p.type === "okr_submit")?.payload as unknown as OkrWeeklyDraft | undefined;
  const kept = new Map((old?.rows ?? []).filter((r) => r.state === "submitted").map((r) => [r.objectId, r]));
  const byKr = new Map(drafted.items.map((i) => [i.objectId, i]));
  const rows: OkrRow[] = krs.map((k) => {
    const base = { objectId: k.id, kr: k.name, objective: k.objective, prevPct: prev(k.id)?.pct ?? null };
    const done = kept.get(k.id);
    if (done) return done;
    const ex = existing.get(k.id);
    if (ex) return { ...base, content: ex.content, pct: ex.pct, why: "平台上这周已经有了", used: [], checked: false, state: "existing", reportId: ex.id };
    const d = byKr.get(k.id);
    if (d) return { ...base, content: d.content, pct: d.pct, why: d.why, used: d.used.map((id) => ({ id, text: text.get(id) ?? "" })), checked: true, state: "draft" };
    return { ...base, content: "", pct: base.prevPct ?? 0, why: "", used: [], checked: false, state: "empty" };
  });
  const draft: OkrWeeklyDraft = { week: week.id, quarter, rows, unmatched: drafted.unmatched.map((id) => ({ id, text: text.get(id) ?? "" })) };
  const nDraft = rows.filter((r) => r.state === "draft").length;
  const nEmpty = rows.filter((r) => r.state === "empty").length;
  const understanding = materials.length
    ? `用本周 ${materials.length} 条素材（git 提交和任务）起草了 ${nDraft} 条，${nEmpty} 条没找到相关工作。`
    : "这周没找到你的 commit 和任务，没调模型；要交的话在下面手写。";

  const t = upsertCard(week, { status: "review", understanding, progress: undefined });
  const action = t.pending?.find((p) => p.type === "okr_submit");
  const payload = draft as unknown as Record<string, unknown>;
  if (action) updatePending(t.id, action.id, { payload, label: OKR_SUBMIT_LABEL(submittable(draft)) });
  else addPending(t.id, { type: "okr_submit", label: OKR_SUBMIT_LABEL(submittable(draft)), detail: `提交 ${week.id} 的 OKR 周报`, payload });
  record({ taskId: t.id, action: "okr_weekly_drafted", why: opts.manual ? "你让 Friday 起草周报" : "每周自动起草", how: understanding, evidence: { week: week.id, materials: materials.length, drafted: nDraft, empty: nEmpty }, risk: "read" });
  setCursor(ranKey(week), new Date().toISOString());
  state.notices.push({ title: `OKR 周报草稿好了 · ${week.id}`, body: understanding, taskId: t.id });
  return { taskId: t.id, drafted: nDraft, empty: nEmpty };
}

export async function autoDraftTick(now = new Date()): Promise<void> {
  if (!userSettings().okrWeekly) return;
  const week = targetWeek(now);
  if (getCursor(ranKey(week)) || cardFor(week)) return;
  await draftWeeklyOnce({ week, manual: false });
}
