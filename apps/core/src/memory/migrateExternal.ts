import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { PendingAction } from "@friday/shared";
import { EXTRA_CONVERSATION_WHY, LEGACY_KEYS, extraConversationOf, migrateKind, migratePending, normalizeSource, stripLegacy } from "./externalRef.js";
import { extNode, order, veto } from "./links.js";

export const MIGRATION_KEY = "migration:external-refs";

const pad = (n: number) => String(n).padStart(2, "0");

/** 迁移前整库拷一份。只能 VACUUM INTO：WAL 没落盘时 cp 出来的库是旧的 */
export function backupDb(d: DatabaseSync, dir: string): string {
  const folder = join(dir, "backups");
  mkdirSync(folder, { recursive: true });
  const t = new Date();
  const stamp = `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}`;
  let path = join(folder, `todos-${stamp}.db`);
  for (let n = 2; existsSync(path); n++) path = join(folder, `todos-${stamp}-${n}.db`);
  d.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
  return path;
}

export function externalRefsMigrated(d: DatabaseSync): boolean {
  return Boolean(d.prepare("SELECT 1 FROM sync_state WHERE source = ?").get(MIGRATION_KEY));
}

const count = (d: DatabaseSync, table: string) => (d.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

function verify(d: DatabaseSync, before: { tasks: number; runs: number }): void {
  const after = { tasks: count(d, "tasks"), runs: count(d, "runs") };
  if (after.tasks !== before.tasks || after.runs !== before.runs) throw new Error(`行数对不上：迁移前 ${JSON.stringify(before)}，迁移后 ${JSON.stringify(after)}`);
  for (const r of d.prepare("SELECT id, kind, source, pending FROM tasks").all() as Array<{ id: string; kind: string; source: string; pending: string | null }>) {
    const src = JSON.parse(r.source) as Record<string, unknown>;
    const left = LEGACY_KEYS.filter((k) => k in src);
    if (Array.isArray(src.merged) && (src.merged as Array<Record<string, unknown>>).some((m) => "meegleId" in m)) left.push("merged[].meegleId");
    if (left.length) throw new Error(`任务 ${r.id} 还有老键：${left.join("、")}`);
    if (r.kind === "meegle" || r.kind === "slack") throw new Error(`任务 ${r.id} 的 kind 还是 ${r.kind}`);
    if (r.pending?.includes('"slack_reply"')) throw new Error(`任务 ${r.id} 还挂着 slack_reply`);
  }
  if (count(d, "runs WHERE trigger = 'slack'")) throw new Error("runs 里还有 trigger = slack");
}

/**
 * 任务来源、kind、待审动作、结果账本的 trigger 一次迁成新形状，整体一个事务，核对不过整体回滚。
 * 审计表不动（只读的账）。备份由调用方先做，backup 是备份路径，记进标记。
 */
export function migrateExternalRefs(d: DatabaseSync, backup = ""): { tasks: number; runs: number; extraLinks: number } | undefined {
  if (externalRefsMigrated(d)) return undefined;
  const before = { tasks: count(d, "tasks"), runs: count(d, "runs") };
  const rows = d.prepare("SELECT id, kind, source, pending FROM tasks").all() as Array<{ id: string; kind: string; source: string; pending: string | null }>;
  const upd = d.prepare("UPDATE tasks SET kind = ?, source = ?, pending = ? WHERE id = ?");
  const edge = d.prepare("INSERT OR IGNORE INTO links (id, from_kind, from_ref, to_kind, to_ref, source, why, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'rule', ?, ?, ?)");
  const vetoed = d.prepare("SELECT 1 FROM links WHERE from_kind = ? AND from_ref = ? AND to_kind = ? AND to_ref = ? AND source = 'user'");
  const at = new Date().toISOString();
  let extraLinks = 0;
  d.exec("BEGIN");
  try {
    for (const r of rows) {
      const old = JSON.parse(r.source) as Record<string, unknown>;
      const pending = r.pending ? JSON.stringify(migratePending(JSON.parse(r.pending) as PendingAction[])) : null;
      upd.run(migrateKind(r.kind), JSON.stringify(stripLegacy(normalizeSource(old))), pending, r.id);
      const conv = extraConversationOf(old);
      if (!conv) continue;
      const [from, to] = order({ kind: "task", ref: r.id }, extNode("slack", "conversation", conv));
      // 你否决过这一对的，迁移不替你连回去
      const [vf, vt] = order(from, veto(to));
      if (vetoed.get(vf.kind, vf.ref, vt.kind, vt.ref)) continue;
      extraLinks += Number(edge.run(randomUUID(), from.kind, from.ref, to.kind, to.ref, EXTRA_CONVERSATION_WHY, at, at).changes);
    }
    const runs = Number(d.prepare("UPDATE runs SET trigger = 'chat' WHERE trigger = 'slack'").run().changes);
    verify(d, before);
    d.prepare("INSERT INTO sync_state (source, last_synced_at, cursor) VALUES (?, ?, ?)").run(MIGRATION_KEY, at, backup);
    d.exec("COMMIT");
    return { tasks: rows.length, runs, extraLinks };
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}
