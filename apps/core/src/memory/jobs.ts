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
  task_id: string | null;
  session_id: string | null;
  log_path: string | null;
  awaiting_delivery: number | null;
  nudged_at: string | null;
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
  ...(r.task_id ? { taskId: r.task_id } : {}),
  ...(r.session_id ? { sessionId: r.session_id } : {}),
  ...(r.awaiting_delivery ? { awaitingDelivery: true } : {}),
  ...(r.nudged_at ? { nudgedAt: r.nudged_at } : {}),
  startedAt: r.started_at,
  ...(r.finished_at ? { finishedAt: r.finished_at } : {}),
});

export function createJob(input: { id: string; project: string; dir: string; task?: string; conversationId?: string; logPath: string; terminal?: TerminalApp; taskId?: string; sessionId?: string }): Job {
  const startedAt = new Date().toISOString();
  db()
    .prepare("INSERT INTO jobs (id, project, dir, task, conversation_id, status, log_path, started_at, terminal, task_id, session_id) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)")
    .run(input.id, input.project, input.dir, input.task ?? null, input.conversationId ?? null, input.logPath, startedAt, input.terminal ?? userSettings().terminal, input.taskId ?? null, input.sessionId ?? null);
  return getJob(input.id)!;
}

export function setJobDir(id: string, dir: string): void {
  db().prepare("UPDATE jobs SET dir = ? WHERE id = ?").run(dir, id);
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

/** 所有开过的终端的第一句（Friday 写的任务描述），trim 过以便跟会话里的原话比对。 */
export function jobTasks(): Set<string> {
  const rows = db().prepare("SELECT DISTINCT task FROM jobs WHERE task IS NOT NULL AND task != ''").all() as { task: string }[];
  return new Set(rows.map((r) => r.task.trim()));
}

/** Friday 敲进终端的每一句。从 Claude Code 历史学的时候按它精确排除，不靠正则猜 */
export function recordTerminalInput(jobId: string, text: string): void {
  db().prepare("INSERT INTO terminal_inputs (job_id, text, at) VALUES (?, ?, ?)").run(jobId, text.trim(), new Date().toISOString());
}

/** hook 转发的 prompt 截过 4000 字，按前 500 字比 */
export function isFridayInput(jobId: string, prompt: string): boolean {
  const head = prompt.trim().slice(0, 500);
  const rows = db().prepare("SELECT text FROM terminal_inputs WHERE job_id = ? ORDER BY id DESC LIMIT 50").all(jobId) as { text: string }[];
  return rows.some((r) => r.text.slice(0, 500) === head);
}

export function markAwaiting(jobId: string): void {
  db().prepare("UPDATE jobs SET awaiting_delivery = 1, nudged_at = NULL WHERE id = ?").run(jobId);
}

export function clearAwaiting(jobId: string): void {
  db().prepare("UPDATE jobs SET awaiting_delivery = 0, nudged_at = NULL WHERE id = ?").run(jobId);
}

export function markNudged(jobId: string): void {
  db().prepare("UPDATE jobs SET nudged_at = ? WHERE id = ?").run(new Date().toISOString(), jobId);
}

/** 会话里眼下在跑的那次 claude（runInSession 起的新 job 不会改会话记着的 jobId） */
export function latestRunningJob(sessionId: string): string | undefined {
  const r = db().prepare("SELECT id FROM jobs WHERE session_id = ? AND status = 'running' ORDER BY started_at DESC, rowid DESC LIMIT 1").get(sessionId) as { id: string } | undefined;
  return r?.id;
}

export function terminalInputTexts(): Set<string> {
  const rows = db().prepare("SELECT DISTINCT text FROM terminal_inputs").all() as { text: string }[];
  return new Set(rows.map((r) => r.text));
}

/** Friday 自己拉起的 claude 会话：自主 -p 和后台查询。交互式终端里说话的是用户，不算。 */
export function fridaySessionIds(): Set<string> {
  const rows = db()
    .prepare(
      `SELECT j.claude_session_id AS sid FROM jobs j JOIN tasks t ON t.id = j.task_id
       WHERE j.claude_session_id IS NOT NULL
         AND (json_extract(t.source, '$.autonomous') = 1 OR json_extract(t.source, '$.headless') = 1)`,
    )
    .all() as { sid: string }[];
  return new Set(rows.map((r) => r.sid));
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

/** 重开终端：这条 job 又活了，清掉收尾信息。 */
export function reviveJob(id: string): Job | undefined {
  db()
    .prepare("UPDATE jobs SET status = 'running', exit_code = NULL, finished_at = NULL WHERE id = ?")
    .run(id);
  return getJob(id);
}

export function finishJob(id: string, exitCode: number): Job | undefined {
  db()
    .prepare("UPDATE jobs SET status = ?, exit_code = ?, finished_at = ? WHERE id = ? AND status = 'running'")
    .run(exitCode === 0 ? "done" : "failed", exitCode, new Date().toISOString(), id);
  return getJob(id);
}

/** 10 秒内同目录同任务的运行中记录，用来挡住重复启动。 */
export function recentDuplicate(dir: string, task: string | undefined, windowMs = 10_000): Job | undefined {
  const since = new Date(Date.now() - windowMs).toISOString();
  const row = db()
    .prepare("SELECT * FROM jobs WHERE status = 'running' AND dir = ? AND COALESCE(task, '') = ? AND started_at >= ? ORDER BY started_at DESC LIMIT 1")
    .get(dir, task ?? "", since) as unknown as Row | undefined;
  return row ? toJob(row) : undefined;
}
