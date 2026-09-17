import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrate } from "./db.js";
import { SCHEMA } from "./schema.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

const OLD_LESSONS = `CREATE TABLE lessons (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  category TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('approved','edited_approved','rejected','auto_undone')),
  draft TEXT,
  final TEXT,
  feedback TEXT,
  confidence INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
)`;

describe("老库迁移", () => {
  it("lessons 的 kind 取值重建，旧数据留着，新类别能写进去", () => {
    const d = new DatabaseSync(join(mkdtempSync(join(tmpdir(), "friday-db-")), "todos.db"));
    d.exec(OLD_LESSONS);
    d.prepare("INSERT INTO lessons (id, category, kind, confidence, created_at) VALUES (?, ?, ?, ?, ?)").run("old1", "question", "approved", 90, "2026-09-01T00:00:00Z");
    d.exec(SCHEMA);
    migrate(d);

    d.prepare("INSERT INTO lessons (id, category, kind, confidence, created_at) VALUES (?, ?, ?, ?, ?)").run("new1", "other", "ignored", 50, "2026-09-16T00:00:00Z");
    d.prepare("INSERT INTO lessons (id, category, kind, confidence, created_at) VALUES (?, ?, ?, ?, ?)").run("new2", "other", "done_without_reply", 50, "2026-09-16T00:00:00Z");
    d.prepare("INSERT INTO lessons (id, category, kind, confidence, created_at) VALUES (?, ?, ?, ?, ?)").run("new3", "relay", "relayed_direct", 0, "2026-09-17T00:00:00Z");
    expect((d.prepare("SELECT COUNT(*) AS n FROM lessons").get() as { n: number }).n).toBe(4);
    expect((d.prepare("SELECT kind FROM lessons WHERE id = 'old1'").get() as { kind: string }).kind).toBe("approved");
    expect((d.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'lessons_old'").get() as { n: number }).n).toBe(0);
  });
});
