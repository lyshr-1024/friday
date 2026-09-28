import type { RunExit, RunKind, RunOutcome, RunRecord, RunsProjectSummary, RunsSummary, RunTrigger, UsageRange } from "@friday/shared";
import { db } from "./db.js";
import { rangeStart } from "./usage.js";

/**
 * 结果账本：Friday 每次替你干活，从开工的把握到最后你收没收下，一行记完。
 * 学习链路原来只学你说过的话，这张表是它学「自己干得怎么样」的那一半。
 */

interface Row {
  id: string;
  job_id: string;
  task_id: string;
  project: string;
  kind: RunKind;
  trigger: RunTrigger;
  intake_confidence: number | null;
  started_at: string;
  ended_at: string | null;
  exit: RunExit | null;
  branch: string | null;
  tip_sha: string | null;
  files_changed: number | null;
  insertions: number | null;
  deletions: number | null;
  cost_usd: number | null;
  model: string | null;
  outcome: RunOutcome;
  outcome_at: string | null;
  outcome_why: string | null;
}

const toRun = (r: Row): RunRecord => ({
  id: r.id,
  jobId: r.job_id,
  taskId: r.task_id,
  project: r.project,
  kind: r.kind,
  trigger: r.trigger,
  ...(r.intake_confidence !== null ? { intakeConfidence: r.intake_confidence } : {}),
  startedAt: r.started_at,
  ...(r.ended_at ? { endedAt: r.ended_at } : {}),
  ...(r.exit ? { exit: r.exit } : {}),
  ...(r.branch ? { branch: r.branch } : {}),
  ...(r.tip_sha ? { tipSha: r.tip_sha } : {}),
  ...(r.files_changed !== null ? { filesChanged: r.files_changed } : {}),
  ...(r.insertions !== null ? { insertions: r.insertions } : {}),
  ...(r.deletions !== null ? { deletions: r.deletions } : {}),
  ...(r.cost_usd !== null ? { costUsd: r.cost_usd } : {}),
  ...(r.model ? { model: r.model } : {}),
  outcome: r.outcome,
  ...(r.outcome_at ? { outcomeAt: r.outcome_at } : {}),
  ...(r.outcome_why ? { outcomeWhy: r.outcome_why } : {}),
});

const getRun = (id: string): RunRecord | undefined => {
  const r = db().prepare("SELECT * FROM runs WHERE id = ?").get(id) as unknown as Row | undefined;
  return r ? toRun(r) : undefined;
};

export function createRun(
  r: Pick<RunRecord, "id" | "jobId" | "taskId" | "project" | "kind" | "trigger"> & { intakeConfidence?: number; at?: string },
): RunRecord {
  db()
    .prepare("INSERT INTO runs (id, job_id, task_id, project, kind, trigger, intake_confidence, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(r.id, r.jobId, r.taskId, r.project, r.kind, r.trigger, r.intakeConfidence ?? null, r.at ?? new Date().toISOString());
  return getRun(r.id)!;
}

export function finishRun(
  id: string,
  patch: Pick<RunRecord, "exit"> & Partial<Pick<RunRecord, "branch" | "tipSha" | "filesChanged" | "insertions" | "deletions" | "costUsd" | "model">>,
): RunRecord | undefined {
  db()
    .prepare(
      `UPDATE runs SET ended_at = ?, exit = ?, branch = COALESCE(?, branch), tip_sha = COALESCE(?, tip_sha),
         files_changed = COALESCE(?, files_changed), insertions = COALESCE(?, insertions), deletions = COALESCE(?, deletions),
         cost_usd = COALESCE(?, cost_usd), model = COALESCE(?, model)
       WHERE id = ?`,
    )
    .run(
      new Date().toISOString(),
      patch.exit ?? null,
      patch.branch ?? null,
      patch.tipSha ?? null,
      patch.filesChanged ?? null,
      patch.insertions ?? null,
      patch.deletions ?? null,
      patch.costUsd ?? null,
      patch.model ?? null,
      id,
    );
  return getRun(id);
}

export function setRunOutcome(id: string, outcome: RunOutcome, why?: string): RunRecord | undefined {
  db().prepare("UPDATE runs SET outcome = ?, outcome_at = ?, outcome_why = ? WHERE id = ?").run(outcome, new Date().toISOString(), why ?? null, id);
  return getRun(id);
}

/** 一个 job 的主记录：自主任务和后台查询一个 job 一行；交互式每轮单独成行，不在这里取。 */
export function runByJob(jobId: string): RunRecord | undefined {
  const r = db().prepare("SELECT * FROM runs WHERE job_id = ? AND kind != 'interactive_round' ORDER BY started_at DESC LIMIT 1").get(jobId) as unknown as Row | undefined;
  return r ? toRun(r) : undefined;
}

/** 这个 job 之前几轮交互已经记过的成本合计，用来把累计值拆成每轮增量 */
export function roundCostSoFar(jobId: string): number {
  const r = db().prepare("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM runs WHERE job_id = ? AND kind = 'interactive_round'").get(jobId) as { s: number };
  return r.s;
}

/** 某个时间之后有了结局、而且结局是「没被原样收下」的：提炼规则时当候选 */
export function lessonsSince(since: string): RunRecord[] {
  return (db()
    .prepare("SELECT * FROM runs WHERE outcome IN ('rejected', 'merged_modified', 'reopened') AND outcome_at > ? ORDER BY outcome_at")
    .all(since) as unknown as Row[]).map(toRun);
}

export function runsForTask(taskId: string): RunRecord[] {
  return (db().prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY started_at").all(taskId) as unknown as Row[]).map(toRun);
}

export function pendingRunsForTask(taskId: string): RunRecord[] {
  return runsForTask(taskId).filter((r) => r.outcome === "pending" && r.kind !== "interactive_round");
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function runsSummary(range: UsageRange, now = new Date()): RunsSummary {
  const since = rangeStart(range, now);
  const rows = db().prepare("SELECT * FROM runs WHERE started_at >= ? ORDER BY started_at").all(since) as unknown as Row[];
  const groups = new Map<string, { base: RunsProjectSummary; minutes: number[] }>();
  for (const r of rows) {
    const key = `${r.project}\u0000${r.kind}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        base: { project: r.project, kind: r.kind, runs: 0, mergedAsIs: 0, mergedModified: 0, rejected: 0, abandoned: 0, reopened: 0, pending: 0, costUsd: 0, medianMinutes: 0 },
        minutes: [],
      };
      groups.set(key, g);
    }
    const b = g.base;
    b.runs++;
    b.costUsd += r.cost_usd ?? 0;
    if (r.outcome === "merged_as_is") b.mergedAsIs++;
    else if (r.outcome === "merged_modified") b.mergedModified++;
    else if (r.outcome === "rejected") b.rejected++;
    else if (r.outcome === "abandoned") b.abandoned++;
    else if (r.outcome === "reopened") b.reopened++;
    else b.pending++;
    if (r.ended_at) g.minutes.push((Date.parse(r.ended_at) - Date.parse(r.started_at)) / 60_000);
  }
  const byProject = [...groups.values()].map((g) => ({ ...g.base, medianMinutes: Math.round(median(g.minutes) * 10) / 10 }));
  byProject.sort((a, b) => b.runs - a.runs || a.project.localeCompare(b.project));
  return { range, since, byProject };
}
