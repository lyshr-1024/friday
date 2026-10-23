// 外部引用迁移演练：tsx scripts/migrate-dry-run.ts <源库> [工作目录]
// 源库只读打开、VACUUM INTO 拷到工作目录，迁移只跑在副本上
import { mkdirSync, mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [src, out] = process.argv.slice(2);
if (!src) {
  console.error("用法：tsx scripts/migrate-dry-run.ts <源库> [工作目录]");
  process.exit(1);
}
const work = out ? resolve(out) : mkdtempSync(join(tmpdir(), "friday-dry-"));
mkdirSync(work, { recursive: true });
// 任何按 config.dataDir 落地的东西都只落在工作目录里
process.env.FRIDAY_DATA_DIR = work;
process.env.FRIDAY_NO_SCHEDULER = "1";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const copyPath = join(work, "todos.db");
const source = new DatabaseSync(resolve(src), { readOnly: true });
source.exec(`VACUUM INTO '${copyPath.replace(/'/g, "''")}'`);
source.close();

const { migrate } = await import("../src/memory/db.js");
const { EXTRA_CONVERSATION_WHY, LEGACY_KEYS } = await import("../src/memory/externalRef.js");
const { MIGRATION_KEY } = await import("../src/memory/migrateExternal.js");

const d = new DatabaseSync(copyPath);
const tables = () =>
  Object.fromEntries(
    (d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(({ name }) => [
      name,
      (d.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n,
    ]),
  );
const leftovers = () => {
  let keys = 0;
  let bad = 0;
  for (const r of d.prepare("SELECT source FROM tasks").all() as Array<{ source: string }>) {
    try {
      const s = JSON.parse(r.source) as Record<string, unknown>;
      const merged = Array.isArray(s.merged) && (s.merged as Array<Record<string, unknown>>).some((m) => "meegleId" in m);
      if (LEGACY_KEYS.some((k) => k in s) || merged) keys++;
    } catch {
      bad++;
    }
  }
  const one = (sql: string) => (d.prepare(sql).get() as { n: number }).n;
  return {
    带老键的任务: keys,
    source解析失败: bad,
    "kind 还是 meegle/slack": one("SELECT COUNT(*) AS n FROM tasks WHERE kind IN ('meegle', 'slack')"),
    "待审还有 slack_reply": one(`SELECT COUNT(*) AS n FROM tasks WHERE pending LIKE '%"slack_reply"%'`),
    "runs.trigger 还是 slack": one("SELECT COUNT(*) AS n FROM runs WHERE trigger = 'slack'"),
    "links 老端点": one("SELECT COUNT(*) AS n FROM links WHERE from_kind IN ('meegle', 'slack', 'thread', 'channel') OR to_kind IN ('meegle', 'slack', 'thread', 'channel')"),
  };
};

const before = tables();
const legacyBefore = leftovers();
migrate(d);
const after = tables();
const legacyAfter = leftovers();
const marker = (d.prepare("SELECT cursor FROM sync_state WHERE source = ?").get(MIGRATION_KEY) as { cursor: string } | undefined)?.cursor;
const extra = (d.prepare("SELECT COUNT(*) AS n FROM links WHERE why = ?").get(EXTRA_CONVERSATION_WHY) as { n: number }).n;

console.log(`\n副本：${copyPath}`);
console.log(`标记 ${MIGRATION_KEY}：${marker === undefined ? "（没写，迁移失败已回滚）" : marker || "（空）"}`);
console.log("\n各表行数（迁移前 → 后）：");
for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
  const [a, b] = [before[name], after[name]];
  console.log(`  ${name}: ${a ?? "-"} → ${b ?? "-"}${a !== b ? "  ←" : ""}`);
}
console.log("\n老形状残留（迁移前 → 后，后面应全为 0）：");
for (const k of Object.keys(legacyAfter) as Array<keyof typeof legacyAfter>) console.log(`  ${k}: ${legacyBefore[k]} → ${legacyAfter[k]}`);
console.log(`\n额外建的边（工单号 + 对话键）：${extra}`);

console.log("\n随机 20 条任务：");
for (const r of d.prepare("SELECT id, kind, source, title FROM tasks ORDER BY random() LIMIT 20").all() as Array<{ id: string; kind: string; source: string; title: string }>) {
  const e = (JSON.parse(r.source) as { external?: { tool: string; type: string; id: string } }).external;
  console.log(`  ${r.id.slice(0, 8)} · ${r.kind} · ${e ? `${e.tool}/${e.type}/${e.id}` : "-"} · ${r.title.slice(0, 40)}`);
}
d.close();
