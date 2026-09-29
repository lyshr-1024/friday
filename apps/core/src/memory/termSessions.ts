import type { TermSession, TermSessionKind, TermSessionStatus } from "@friday/shared";
import { db } from "./db.js";

interface Row {
  id: string;
  project: string;
  repo_dir: string;
  tmux_name: string;
  kind: TermSessionKind;
  status: TermSessionStatus;
  job_id: string | null;
  worktree: string | null;
  branch: string | null;
  last_input_at: string | null;
  last_stop_at: string | null;
  seen_at: string | null;
  created_at: string;
  updated_at: string;
}

const toSession = (r: Row): TermSession => ({
  id: r.id,
  project: r.project,
  repoDir: r.repo_dir,
  tmuxName: r.tmux_name,
  kind: r.kind,
  status: r.status,
  ...(r.job_id ? { jobId: r.job_id } : {}),
  ...(r.worktree ? { worktree: r.worktree } : {}),
  ...(r.branch ? { branch: r.branch } : {}),
  ...(r.last_input_at ? { lastInputAt: r.last_input_at } : {}),
  ...(r.last_stop_at ? { lastStopAt: r.last_stop_at } : {}),
  ...(r.seen_at ? { seenAt: r.seen_at } : {}),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const now = () => new Date().toISOString();

export function createTermSession(input: { id: string; project: string; repoDir: string; tmuxName: string; kind: TermSessionKind; jobId: string }): TermSession {
  const t = now();
  const status: TermSessionStatus = input.kind === "query" ? "running" : "preparing";
  db()
    .prepare(
      `INSERT INTO term_sessions (id, project, repo_dir, tmux_name, kind, status, job_id, last_input_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET project = excluded.project, repo_dir = excluded.repo_dir, tmux_name = excluded.tmux_name,
         kind = excluded.kind, status = excluded.status, job_id = excluded.job_id, worktree = NULL, branch = NULL,
         last_input_at = excluded.last_input_at, last_stop_at = NULL, seen_at = NULL, created_at = excluded.created_at, updated_at = excluded.updated_at`,
    )
    .run(input.id, input.project, input.repoDir, input.tmuxName, input.kind, status, input.jobId, t, t, t);
  return getTermSession(input.id)!;
}

export function getTermSession(id: string): TermSession | undefined {
  const r = db().prepare("SELECT * FROM term_sessions WHERE id = ?").get(id) as unknown as Row | undefined;
  return r ? toSession(r) : undefined;
}

export function termSessionByJob(jobId: string): TermSession | undefined {
  const r = db().prepare("SELECT * FROM term_sessions WHERE job_id = ?").get(jobId) as unknown as Row | undefined;
  return r ? toSession(r) : undefined;
}

export function openTermSessions(): TermSession[] {
  return (db().prepare("SELECT * FROM term_sessions WHERE status != 'closed' ORDER BY updated_at DESC").all() as unknown as Row[]).map(toSession);
}

export function otherOpenSessionUsing(id: string, col: "worktree" | "branch", value: string, repoDir: string): TermSession | undefined {
  const scope = col === "branch" ? "AND repo_dir = ?" : "";
  const r = db().prepare(`SELECT * FROM term_sessions WHERE id != ? AND status != 'closed' AND ${col} = ? ${scope} LIMIT 1`).get(id, value, ...(scope ? [repoDir] : [])) as unknown as Row | undefined;
  return r ? toSession(r) : undefined;
}

const COLS: Record<string, string> = { status: "status", jobId: "job_id", worktree: "worktree", branch: "branch", tmuxName: "tmux_name", kind: "kind" };

export function updateTermSession(id: string, patch: Partial<Pick<TermSession, "status" | "jobId" | "worktree" | "branch" | "tmuxName" | "kind">>): TermSession | undefined {
  const keys = Object.keys(patch).filter((k) => k in COLS) as Array<keyof typeof patch>;
  if (keys.length) {
    db()
      .prepare(`UPDATE term_sessions SET ${keys.map((k) => `${COLS[k]} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((k) => (patch[k] ?? null) as string | null), now(), id);
  }
  return getTermSession(id);
}

const stamp = (col: "last_input_at" | "last_stop_at" | "seen_at") => (id: string) => {
  const t = now();
  db().prepare(`UPDATE term_sessions SET ${col} = ?, updated_at = ? WHERE id = ?`).run(t, t, id);
};

export const markInput = stamp("last_input_at");
export const markStop = stamp("last_stop_at");
export const markSeen = stamp("seen_at");
