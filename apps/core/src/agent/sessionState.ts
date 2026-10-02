import { SESSION_STATE_LABEL, isFridayRun } from "@friday/shared";
import type { SessionState, Task, TaskSession, TermSession } from "@friday/shared";
import { findTaskBySource } from "../memory/tasks.js";
import { getTermSession, termSessionByJob } from "../memory/termSessions.js";
import { runByJob } from "../memory/runs.js";
import { liveRootId } from "./sessions.js";

export function sessionState(t: Pick<Task, "attention" | "pending" | "status">, s?: TermSession): SessionState {
  const alive = s?.status === "running" || s?.status === "preparing";
  if (alive && t.attention === "question") return "asking";
  if (s?.status === "preparing") return "preparing";
  if (alive && s!.lastInputAt && (!s!.lastStopAt || s!.lastInputAt > s!.lastStopAt)) return "working";
  if (alive && s!.lastStopAt && (!s!.seenAt || s!.lastStopAt > s!.seenAt)) return "awaiting";
  if (t.pending?.length) return "deciding";
  if (t.status === "blocked") return "blocked";
  if (s?.status === "exited") return "exited";
  return alive ? "idle" : "none";
}

export function taskSession(t: Task): TaskSession {
  const s = getTermSession(liveRootId(t) ?? t.id);
  const own = s && s.id === t.id && s.status !== "closed" ? s : undefined;
  const state = sessionState(t, own);
  const waitingSince = (t.pending ?? []).map((p) => p.at).filter((x): x is string => Boolean(x)).sort()[0];
  const run = t.source.jobId ? runByJob(t.source.jobId) : undefined;
  const minutes = run?.endedAt ? Math.max(1, Math.round((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 60000)) : undefined;
  return {
    state,
    ...(own?.lastStopAt ? { lastStopAt: own.lastStopAt } : {}),
    ...(state === "deciding" && waitingSince ? { waitingSince } : {}),
    ...(own ? { name: own.tmuxName, status: own.status, kind: own.kind, ...(own.worktree ? { worktree: own.worktree } : {}), ...(own.branch ? { branch: own.branch } : {}) } : {}),
    ...(isFridayRun(t.source) && run
      ? { delivery: { ...(run.filesChanged !== undefined ? { files: run.filesChanged } : {}), ...(run.insertions !== undefined ? { insertions: run.insertions } : {}), ...(run.deletions !== undefined ? { deletions: run.deletions } : {}), ...(run.diffFiles ? { perFile: run.diffFiles } : {}), ...(run.diffBase ? { base: run.diffBase } : {}), ...(run.costUsd !== undefined ? { costUsd: run.costUsd } : {}), ...(minutes ? { minutes } : {}), ...(run.model ? { model: run.model } : {}) } }
      : {}),
  };
}

export function jobStateLabel(jobId: string): string {
  const s = termSessionByJob(jobId);
  const state = sessionState(findTaskBySource((src) => src.jobId === jobId, true) ?? { status: "processing" }, s);
  return SESSION_STATE_LABEL[state] || (state === "idle" ? "会话开着，空闲" : "没有会话");
}
