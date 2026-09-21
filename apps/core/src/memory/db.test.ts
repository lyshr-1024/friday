import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrate } from "./db.js";
import { SCHEMA } from "./schema.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

const OLD_LINKS = `CREATE TABLE links (
  id TEXT PRIMARY KEY,
  from_kind TEXT NOT NULL CHECK (from_kind IN ('task', 'meegle', 'thread', 'branch', 'url', 'project')),
  from_ref TEXT NOT NULL,
  to_kind TEXT NOT NULL CHECK (to_kind IN ('task', 'meegle', 'thread', 'branch', 'url', 'project')),
  to_ref TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('user', 'rule', 'guess')),
  why TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

describe("老库迁移", () => {
  it("线程、经验、阈值三张表清掉，inbox 补 prior 列", () => {
    const d = new DatabaseSync(join(mkdtempSync(join(tmpdir(), "friday-db-")), "todos.db"));
    d.exec(SCHEMA);
    d.exec("CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY)");
    d.exec("CREATE TABLE IF NOT EXISTS lessons (id TEXT PRIMARY KEY)");
    d.exec("CREATE TABLE IF NOT EXISTS thresholds (category TEXT PRIMARY KEY)");
    migrate(d);
    for (const t of ["threads", "lessons", "thresholds"]) {
      expect((d.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = ?").get(t) as { n: number }).n).toBe(0);
    }
    const cols = (d.prepare("PRAGMA table_info(inbox)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("prior");
  });

  it("只挂着开工提案的工单放回待办，带真待审动作的留在「待我决定」", () => {
    const d = new DatabaseSync(join(mkdtempSync(join(tmpdir(), "friday-db-")), "todos.db"));
    d.exec(SCHEMA);
    const add = (id: string, pending: string) =>
      d.prepare("INSERT INTO tasks (id, title, kind, source, status, pending, created_at, updated_at) VALUES (?, ?, ?, ?, 'review', ?, ?, ?)")
        .run(id, id, "meegle", "{}", pending, "2026-09-16T00:00:00Z", "2026-09-16T00:00:00Z");
    add("only-start", JSON.stringify([{ id: "a", type: "start_job", label: "开工", payload: {} }]));
    add("has-reply", JSON.stringify([{ id: "b", type: "start_job", label: "开工", payload: {} }, { id: "c", type: "slack_reply", label: "回复", payload: {} }]));
    add("has-merge", JSON.stringify([{ id: "d", type: "git_merge", label: "合并", payload: {} }]));
    migrate(d);

    const statusOf = (id: string) => (d.prepare("SELECT status FROM tasks WHERE id = ?").get(id) as { status: string }).status;
    expect(statusOf("only-start")).toBe("understood");
    expect(statusOf("has-reply")).toBe("review");
    expect(statusOf("has-merge")).toBe("review");
  });

  it("links 表加 slack 节点类型，旧边留着", () => {
    const d = new DatabaseSync(join(mkdtempSync(join(tmpdir(), "friday-db-")), "todos.db"));
    d.exec(OLD_LINKS);
    d.prepare("INSERT INTO links (id, from_kind, from_ref, to_kind, to_ref, source, why, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("old1", "task", "t1", "meegle", "24440539", "rule", "旧边", "2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z");
    d.exec(SCHEMA);
    migrate(d);

    d.prepare("INSERT INTO links (id, from_kind, from_ref, to_kind, to_ref, source, why, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("new1", "slack", "C1:1789000001.0", "task", "t1", "rule", "新边", "2026-09-21T00:00:00Z", "2026-09-21T00:00:00Z");
    expect((d.prepare("SELECT COUNT(*) AS n FROM links").get() as { n: number }).n).toBe(2);
    expect((d.prepare("SELECT why FROM links WHERE id = 'old1'").get() as { why: string }).why).toBe("旧边");
    expect((d.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'links_old'").get() as { n: number }).n).toBe(0);
  });
});
