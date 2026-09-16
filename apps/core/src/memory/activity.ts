import { randomUUID } from "node:crypto";
import { db } from "./db.js";

const KEEP = 200;

export interface ShellActivity {
  cwd: string;
  branch?: string;
  cmd?: string;
  exitCode?: number;
}

interface Row {
  id: string;
  ts: string;
  kind: "shell";
  cwd: string;
  branch: string | null;
  cmd: string | null;
  exit_code: number | null;
}

const toActivity = (r: Row): ShellActivity & { ts: string } => ({
  ts: r.ts,
  cwd: r.cwd,
  ...(r.branch ? { branch: r.branch } : {}),
  ...(r.cmd ? { cmd: r.cmd } : {}),
  ...(r.exit_code !== null ? { exitCode: r.exit_code } : {}),
});

export function addShellActivity(a: ShellActivity): void {
  const d = db();
  d.prepare("INSERT INTO activity (id, ts, kind, cwd, branch, cmd, exit_code) VALUES (?, ?, 'shell', ?, ?, ?, ?)").run(
    randomUUID(),
    new Date().toISOString(),
    a.cwd,
    a.branch ?? null,
    a.cmd ?? null,
    a.exitCode ?? null,
  );
  // 只留最近 KEEP 条，钩子每条命令都上报，不清理会无限增长
  d.prepare("DELETE FROM activity WHERE id NOT IN (SELECT id FROM activity ORDER BY ts DESC LIMIT ?)").run(KEEP);
}

/** cwd 前缀命中的最新一条 shell 活动。呼出模式判断用户此刻在哪个终端目录下干活，比窗口标题解析可靠。 */
export function latestShellActivityFor(cwd: string): (ShellActivity & { ts: string }) | undefined {
  const row = db()
    .prepare("SELECT * FROM activity WHERE kind = 'shell' AND (cwd = ? OR cwd LIKE ?) ORDER BY ts DESC LIMIT 1")
    .get(cwd, `${cwd}/%`) as unknown as Row | undefined;
  return row ? toActivity(row) : undefined;
}

export function latestShellActivity(): (ShellActivity & { ts: string }) | undefined {
  const row = db().prepare("SELECT * FROM activity WHERE kind = 'shell' ORDER BY ts DESC LIMIT 1").get() as unknown as Row | undefined;
  return row ? toActivity(row) : undefined;
}
