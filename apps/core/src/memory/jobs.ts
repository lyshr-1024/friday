import type { Job, JobStatus, TerminalApp } from "@friday/shared";
import { db } from "./db.js";
import { userSettings } from "../settings.js";

interface Row {
  id: string;
  project: string;
  dir: string;
  task: string | null;
  conversation_id: string | null;
  status: JobStatus;
  exit_code: number | null;
  last_message: string | null;
  claude_session_id: string | null;
  terminal: TerminalApp | null;
  ghostty_id: string | null;
  log_path: string | null;
  started_at: string;
  finished_at: string | null;
}

const toJob = (r: Row): Job => ({
  id: r.id,
  project: r.project,
  dir: r.dir,
  ...(r.task ? { task: r.task } : {}),
  ...(r.conversation_id ? { conversationId: r.conversation_id } : {}),
  status: r.status,
  ...(r.exit_code !== null ? { exitCode: r.exit_code } : {}),
  ...(r.last_message ? { lastMessage: r.last_message } : {}),
  ...(r.claude_session_id ? { claudeSessionId: r.claude_session_id } : {}),
  ...(r.terminal ? { terminal: r.terminal } : {}),
  ...(r.ghostty_id ? { ghosttyId: r.ghostty_id } : {}),
  startedAt: r.started_at,
  ...(r.finished_at ? { finishedAt: r.finished_at } : {}),
});

export function createJob(input: { id: string; project: string; dir: string; task?: string; conversationId?: string; logPath: string; terminal?: TerminalApp }): Job {
  const startedAt = new Date().toISOString();
  db()
    .prepare("INSERT INTO jobs (id, project, dir, task, conversation_id, status, log_path, started_at, terminal) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)")
    .run(input.id, input.project, input.dir, input.task ?? null, input.conversationId ?? null, input.logPath, startedAt, input.terminal ?? userSettings().terminal);
  return getJob(input.id)!;
}

/** 开完 Ghostty 窗口把 terminal id 记下来，之后 say / focus / close 都认它。 */
export function setGhosttyId(id: string, ghosttyId: string): void {
  db().prepare("UPDATE jobs SET ghostty_id = ? WHERE id = ?").run(ghosttyId, id);
}

export function getJob(id: string): Job | undefined {
  const row = db().prepare("SELECT * FROM jobs WHERE id = ?").get(id) as unknown as Row | undefined;
  return row ? toJob(row) : undefined;
}

export function jobLogPath(id: string): string | undefined {
  const row = db().prepare("SELECT log_path FROM jobs WHERE id = ?").get(id) as { log_path: string | null } | undefined;
  return row?.log_path ?? undefined;
}

export function listJobs(limit = 30): Job[] {
  const rows = db().prepare("SELECT * FROM jobs ORDER BY started_at DESC LIMIT ?").all(limit) as unknown as Row[];
  return rows.map(toJob);
}

export function runningJobs(): Job[] {
  const rows = db().prepare("SELECT * FROM jobs WHERE status = 'running' ORDER BY started_at DESC").all() as unknown as Row[];
  return rows.map(toJob);
}

export function setJobSession(id: string, sessionId: string): boolean {
  return db().prepare("UPDATE jobs SET claude_session_id = ? WHERE id = ?").run(sessionId, id).changes > 0;
}

export function setJobMessage(id: string, text: string): boolean {
  return db().prepare("UPDATE jobs SET last_message = ? WHERE id = ?").run(text.slice(0, 4000), id).changes > 0;
}

export function finishJob(id: string, exitCode: number): Job | undefined {
  db()
    .prepare("UPDATE jobs SET status = ?, exit_code = ?, finished_at = ? WHERE id = ? AND status = 'running'")
    .run(exitCode === 0 ? "done" : "failed", exitCode, new Date().toISOString(), id);
  return getJob(id);
}

/** 启动时收尸：PTY 只活在 sidecar 内存里，进程重启后还标着 running 的
    必然已经死了，留着会让「N 个终端在跑」越攒越多。 */
export function reapStaleJobs(): number {
  const rows = db().prepare("SELECT id FROM jobs WHERE status = 'running'").all() as unknown as { id: string }[];
  if (!rows.length) return 0;
  db()
    .prepare("UPDATE jobs SET status = 'done', exit_code = -1, finished_at = ? WHERE status = 'running'")
    .run(new Date().toISOString());
  return rows.length;
}

/** 10 秒内同目录同任务的运行中记录，用来挡住重复启动。 */
export function recentDuplicate(dir: string, task: string | undefined, windowMs = 10_000): Job | undefined {
  const since = new Date(Date.now() - windowMs).toISOString();
  const row = db()
    .prepare("SELECT * FROM jobs WHERE status = 'running' AND dir = ? AND COALESCE(task, '') = ? AND started_at >= ? ORDER BY started_at DESC LIMIT 1")
    .get(dir, task ?? "", since) as unknown as Row | undefined;
  return row ? toJob(row) : undefined;
}
