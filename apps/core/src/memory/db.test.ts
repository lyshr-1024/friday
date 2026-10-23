import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { db, migrate } from "./db.js";
import { extNode, taskNode } from "./infer.js";
import { linkUp, neighbors, rejected } from "./links.js";
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

const SLACK_LINKS = OLD_LINKS
  .replace(/'project'\)\)/g, "'project', 'slack'))");

const CHANNEL_LINKS = OLD_LINKS
  .replace(/'project'\)\)/g, "'project', 'slack', 'channel'))");

describe("老库迁移", () => {
  const oldMessages = () => {
    const d = new DatabaseSync(join(mkdtempSync(join(tmpdir(), "friday-db-")), "todos.db"));
    d.exec(SCHEMA.replace(", 'notice'", ""));
    d.exec("ALTER TABLE messages ADD COLUMN task_ids TEXT");
    d.exec("INSERT INTO conversations (id, created_at, updated_at) VALUES ('c', 'a', 'a')");
    return d;
  };

  it("孤儿消息（会话已不在）迁移后原样保留，八列都在", () => {
    const d = oldMessages();
    d.exec("PRAGMA foreign_keys = OFF");
    d.exec("INSERT INTO messages (id, conversation_id, role, kind, content, payload, created_at, task_ids) VALUES ('o', 'gone', 'user', 'ask', 'hi', '{\"a\":1}', 'a', '[\"t\"]')");
    d.exec("PRAGMA foreign_keys = ON");
    migrate(d);
    expect(d.prepare("SELECT * FROM messages WHERE id = 'o'").get()).toMatchObject({ conversation_id: "gone", role: "user", kind: "ask", content: "hi", payload: '{"a":1}', created_at: "a", task_ids: '["t"]' });
    expect(d.prepare("PRAGMA foreign_keys").get()).toMatchObject({ foreign_keys: 1 });
  });

  it("迁移中途失败整体回滚：messages 还是旧表、数据都在、没有 messages_old", () => {
    const d = new DatabaseSync(join(mkdtempSync(join(tmpdir(), "friday-db-")), "todos.db"));
    d.exec(SCHEMA);
    d.exec("DROP TABLE messages");
    d.exec("CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL, payload TEXT, created_at TEXT NOT NULL, task_ids TEXT)");
    d.exec("INSERT INTO messages (id, conversation_id, role, kind, content, created_at) VALUES ('ok', 'c', 'user', 'ask', 'a', 'a'), ('bad', 'c', 'user', 'bogus', 'b', 'a')");
    expect(() => migrate(d)).toThrow();
    const names = (d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'messages%'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(names).toEqual(["messages"]);
    expect((d.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n).toBe(2);
    expect((d.prepare("SELECT sql FROM sqlite_master WHERE name = 'messages'").get() as { sql: string }).sql).not.toContain("'notice'");
    expect(d.prepare("PRAGMA foreign_keys").get()).toMatchObject({ foreign_keys: 1 });
  });

  it("messages 的 kind 约束补上 notice，旧消息原样搬过去", () => {
    const d = new DatabaseSync(join(mkdtempSync(join(tmpdir(), "friday-db-")), "todos.db"));
    d.exec(SCHEMA.replace(", 'notice'", ""));
    d.exec("ALTER TABLE messages ADD COLUMN task_ids TEXT");
    d.exec("INSERT INTO conversations (id, created_at, updated_at) VALUES ('c', 'a', 'a')");
    d.exec("INSERT INTO messages (id, conversation_id, role, kind, content, created_at, task_ids) VALUES ('m', 'c', 'user', 'ask', 'hi', 'a', '[\"t\"]')");
    migrate(d);
    d.exec("INSERT INTO messages (id, conversation_id, role, kind, content, created_at) VALUES ('n', 'c', 'assistant', 'notice', 'x', 'b')");
    expect(d.prepare("SELECT content, task_ids FROM messages WHERE id = 'm'").get()).toMatchObject({ content: "hi", task_ids: '["t"]' });
    expect(d.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'messages_conv'").get()).toBeTruthy();
  });

  it("补 seq 不撞已有号：空号接在 MAX 之后，同 created_at 按 rowid", () => {
    const d = new DatabaseSync(join(mkdtempSync(join(tmpdir(), "friday-db-")), "todos.db"));
    d.exec(SCHEMA);
    d.exec("ALTER TABLE tasks ADD COLUMN seq INTEGER");
    const add = (id: string, at: string, seq: number | null) => d.prepare("INSERT INTO tasks (id, title, kind, source, status, created_at, updated_at, seq) VALUES (?, ?, 'verbal', '{}', 'understood', ?, ?, ?)").run(id, id, at, at, seq);
    add("x", "2026-09-05T00:00:00Z", 7);
    add("p", "2026-09-02T00:00:00Z", null);
    add("q", "2026-09-02T00:00:00Z", null);
    add("o", "2026-09-01T00:00:00Z", null);
    migrate(d);
    const seqs = (d.prepare("SELECT id, seq FROM tasks ORDER BY seq").all() as Array<{ id: string; seq: number }>).map((r) => `${r.id}${r.seq}`);
    expect(seqs).toEqual(["x7", "o8", "p9", "q10"]);
  });

  it("老库里已有重复 seq：保留最早那行，其余重新取号，建唯一索引不抛", () => {
    const d = new DatabaseSync(join(mkdtempSync(join(tmpdir(), "friday-db-")), "todos.db"));
    d.exec(SCHEMA);
    d.exec("ALTER TABLE tasks ADD COLUMN seq INTEGER");
    const add = (id: string) => d.prepare("INSERT INTO tasks (id, title, kind, source, status, created_at, updated_at, seq) VALUES (?, ?, 'verbal', '{}', 'understood', 'a', 'a', 5)").run(id, id);
    add("m");
    add("n");
    expect(() => migrate(d)).not.toThrow();
    const seqs = (d.prepare("SELECT id, seq FROM tasks ORDER BY rowid").all() as Array<{ id: string; seq: number }>);
    expect(seqs[0]).toEqual({ id: "m", seq: 5 });
    expect(seqs[1]!.seq).not.toBe(5);
    expect(seqs[1]!.seq).toBeGreaterThan(5);
  });

  it("老库补 seq：按 created_at 回填，从 1 开始不重复", () => {
    const d = new DatabaseSync(join(mkdtempSync(join(tmpdir(), "friday-db-")), "todos.db"));
    d.exec(SCHEMA);
    const add = (id: string, at: string) => d.prepare("INSERT INTO tasks (id, title, kind, source, status, created_at, updated_at) VALUES (?, ?, 'verbal', '{}', 'understood', ?, ?)").run(id, id, at, at);
    add("c", "2026-09-03T00:00:00Z");
    add("a", "2026-09-01T00:00:00Z");
    add("b", "2026-09-02T00:00:00Z");
    migrate(d);
    const seqs = (d.prepare("SELECT id, seq FROM tasks ORDER BY seq").all() as Array<{ id: string; seq: number }>).map((r) => `${r.id}${r.seq}`);
    expect(seqs).toEqual(["a1", "b2", "c3"]);
  });

  it("老库 features 没有 corrected 列：迁移补上，默认 '[]'", () => {
    const d = new DatabaseSync(join(mkdtempSync(join(tmpdir(), "friday-db-")), "todos.db"));
    d.exec(SCHEMA);
    d.exec("ALTER TABLE features DROP COLUMN corrected");
    d.exec("INSERT INTO features (id, project, name, origin, created_at, updated_at) VALUES ('f-1', 'p', 'n', 'task', 't', 't')");
    migrate(d);
    expect((d.prepare("SELECT corrected FROM features WHERE id = 'f-1'").get() as { corrected: string }).corrected).toBe("[]");
  });

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

  it("旧版没有 tmux 会话的 running job 一次性收掉，对应任务写明需重新开工", () => {
    const d = new DatabaseSync(join(mkdtempSync(join(tmpdir(), "friday-db-")), "todos.db"));
    d.exec(SCHEMA);
    migrate(d);
    d.prepare("INSERT INTO tasks (id, title, kind, source, status, created_at, updated_at) VALUES ('t1', 't1', 'code', '{}', 'processing', ?, ?)").run("2026-09-28T00:00:00Z", "2026-09-28T00:00:00Z");
    const job = d.prepare("INSERT INTO jobs (id, project, dir, status, log_path, started_at, task_id, session_id) VALUES (?, 'p', '/tmp', 'running', '/tmp/x.log', ?, ?, ?)");
    job.run("old", "2026-09-28T00:00:00Z", "t1", null);
    job.run("new", "2026-09-29T00:00:00Z", null, "s1");
    migrate(d);

    const row = (id: string) => d.prepare("SELECT status, exit_code FROM jobs WHERE id = ?").get(id) as { status: string; exit_code: number | null };
    expect(row("old")).toMatchObject({ status: "done", exit_code: -1 });
    expect(row("new").status).toBe("running");
    expect((d.prepare("SELECT progress FROM tasks WHERE id = 't1'").get() as { progress: string }).progress).toBe("旧版终端已不可接回，需重新开工");
  });

  it("周报和手册卡不补阶段；之前被自动补上的清掉，手动拨过的不动", () => {
    const d = new DatabaseSync(join(mkdtempSync(join(tmpdir(), "friday-db-")), "todos.db"));
    d.exec(SCHEMA);
    migrate(d);
    const add = (id: string, kind: string, stage: string | null, by: string | null) =>
      d.prepare("INSERT INTO tasks (id, title, kind, source, status, stage, stage_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'review', ?, ?, ?, ?)")
        .run(id, id, kind, "{}", stage, by, "2026-09-25T00:00:00Z", "2026-09-25T00:00:00Z");
    add("okr-new", "okr_weekly", null, null);
    add("okr-auto", "okr_weekly", "testing", "auto");
    add("hb-auto", "handbook", "testing", "auto");
    add("okr-user", "okr_weekly", "testing", "user");
    add("dev", "meegle", null, null);
    migrate(d);

    const stageOf = (id: string) => d.prepare("SELECT stage, stage_by FROM tasks WHERE id = ?").get(id) as { stage: string | null; stage_by: string | null };
    expect(stageOf("okr-new")).toEqual({ stage: null, stage_by: null });
    expect(stageOf("okr-auto")).toEqual({ stage: null, stage_by: null });
    expect(stageOf("hb-auto")).toEqual({ stage: null, stage_by: null });
    expect(stageOf("okr-user")).toEqual({ stage: "testing", stage_by: "user" });
    expect(stageOf("dev")).toEqual({ stage: "testing", stage_by: "auto" });
  });

  it("没有 channel 的老 links 表一次收成 ext，旧边留着", () => {
    const d = new DatabaseSync(join(mkdtempSync(join(tmpdir(), "friday-db-")), "todos.db"));
    d.exec(OLD_LINKS);
    d.prepare("INSERT INTO links (id, from_kind, from_ref, to_kind, to_ref, source, why, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("old1", "task", "t1", "meegle", "24440539", "rule", "旧边", "2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z");
    d.exec(SCHEMA);
    migrate(d);

    d.prepare("INSERT INTO links (id, from_kind, from_ref, to_kind, to_ref, source, why, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("new1", "ext", "slack:channel:一起养牛", "task", "t1", "rule", "新边", "2026-09-21T00:00:00Z", "2026-09-21T00:00:00Z");
    expect((d.prepare("SELECT COUNT(*) AS n FROM links").get() as { n: number }).n).toBe(2);
    expect((d.prepare("SELECT why FROM links WHERE id = 'old1'").get() as { why: string }).why).toBe("旧边");
    expect((d.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'links_old'").get() as { n: number }).n).toBe(0);
  });

  it("已经加过 slack 的库同样收成 ext", () => {
    const d = new DatabaseSync(join(mkdtempSync(join(tmpdir(), "friday-db-")), "todos.db"));
    d.exec(SLACK_LINKS);
    d.prepare("INSERT INTO links (id, from_kind, from_ref, to_kind, to_ref, source, why, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("s1", "slack", "C1:1789000001.0", "task", "t1", "rule", "旧边", "2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z");
    d.exec(SCHEMA);
    migrate(d);

    d.prepare("INSERT INTO links (id, from_kind, from_ref, to_kind, to_ref, source, why, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("c1", "ext", "slack:channel:一起养牛", "task", "t1", "user", "手动登记", "2026-09-21T00:00:00Z", "2026-09-21T00:00:00Z");
    expect((d.prepare("SELECT COUNT(*) AS n FROM links").get() as { n: number }).n).toBe(2);
    expect((d.prepare("SELECT why FROM links WHERE id = 's1'").get() as { why: string }).why).toBe("旧边");
  });

  it("links 的 meegle / slack / thread / channel 端点收成 ext：方向重排、撞边留强的、否决照挡、重跑不变", () => {
    const d = db();
    d.exec("DROP TABLE links");
    d.exec(CHANNEL_LINKS);
    d.exec("CREATE UNIQUE INDEX links_edge ON links (from_kind, from_ref, to_kind, to_ref)");
    const ins = d.prepare("INSERT INTO links (id, from_kind, from_ref, to_kind, to_ref, source, why, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const at = (n: number) => `2026-09-0${n}T00:00:00Z`;
    // task < thread，换成 ext 后 ext < task，方向要翻
    ins.run("th", "task", "t1", "thread", "TH1", "rule", "线程", at(1), at(1));
    // 同一条边老数据里正反各存了一行：迁过去撞成一条，留 user
    ins.run("m-rule", "meegle", "123", "task", "t2", "rule", "推断", at(2), at(2));
    ins.run("m-user", "task", "t2", "meegle", "123", "user", "你指定的", at(1), at(1));
    // 同级留新的
    ins.run("c-old", "channel", "一起养牛", "task", "t5", "rule", "旧", at(1), at(1));
    ins.run("c-new", "task", "t5", "channel", "一起养牛", "rule", "新", at(3), at(3));
    // 否决：unlink(task t3, thread TH3) 老顺序 task < thread，! 记在 thread 那头
    ins.run("v-th", "task", "t3", "thread", "!TH3", "user", "不是一回事", at(1), at(1));
    // 否决：unlink(slack, task) 老顺序 slack < task，! 记在 task 那头
    ins.run("v-sl", "slack", "C1:1.0", "task", "!t4", "user", "不是这条", at(1), at(1));
    migrate(d);

    const rows = () => d.prepare("SELECT id, from_kind, from_ref, to_kind, to_ref, source, why FROM links ORDER BY id").all();
    const after = rows();
    expect(after).toHaveLength(5);
    expect(after).toContainEqual({ id: "th", from_kind: "ext", from_ref: "slack:thread:TH1", to_kind: "task", to_ref: "t1", source: "rule", why: "线程" });
    expect(after).toContainEqual({ id: "m-user", from_kind: "ext", from_ref: "meegle:work_item:123", to_kind: "task", to_ref: "t2", source: "user", why: "你指定的" });
    expect(after).toContainEqual({ id: "c-new", from_kind: "ext", from_ref: "slack:channel:一起养牛", to_kind: "task", to_ref: "t5", source: "rule", why: "新" });
    expect(after).toContainEqual({ id: "v-th", from_kind: "ext", from_ref: "slack:thread:TH3", to_kind: "task", to_ref: "!t3", source: "user", why: "不是一回事" });
    expect(after).toContainEqual({ id: "v-sl", from_kind: "ext", from_ref: "slack:conversation:C1:1.0", to_kind: "task", to_ref: "!t4", source: "user", why: "不是这条" });

    expect(neighbors(extNode("meegle", "work_item", "123"), "task")).toEqual([{ ref: "t2", source: "user", why: "你指定的" }]);
    expect(neighbors(extNode("slack", "thread", "TH1"), "task").map((n) => n.ref)).toEqual(["t1"]);
    expect(rejected(taskNode("t3"), extNode("slack", "thread", "TH3"))).toBe(true);
    expect(linkUp(taskNode("t3"), extNode("slack", "thread", "TH3"), "rule", "又推断了")).toBeUndefined();
    expect(linkUp(extNode("slack", "conversation", "C1:1.0"), taskNode("t4"), "guess", "又猜了")).toBeUndefined();
    expect((d.prepare("SELECT sql FROM sqlite_master WHERE name = 'links'").get() as { sql: string }).sql).not.toContain("'meegle'");
    expect((d.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'links_old'").get() as { n: number }).n).toBe(0);
    expect(d.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'links' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => (r as { name: string }).name)).toEqual(["links_edge", "links_from", "links_to"]);

    const before = rows();
    migrate(d);
    expect(rows()).toEqual(before);
  });

  it("links 迁移中途失败整体回滚：老表和老边都在", () => {
    const d = new DatabaseSync(join(mkdtempSync(join(tmpdir(), "friday-db-")), "todos.db"));
    d.exec(SCHEMA);
    d.exec("DROP TABLE links");
    d.exec(CHANNEL_LINKS.replace(/'channel'\)\)/g, "'channel', 'bogus'))"));
    const ins = d.prepare("INSERT INTO links (id, from_kind, from_ref, to_kind, to_ref, source, why, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    ins.run("ok", "meegle", "1", "task", "t", "rule", "x", "a", "a");
    ins.run("bad", "bogus", "1", "task", "t", "rule", "x", "a", "a");
    expect(() => migrate(d)).toThrow();
    const names = (d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'links%'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(names).toEqual(["links"]);
    expect(d.prepare("SELECT from_kind FROM links ORDER BY id").all()).toEqual([{ from_kind: "bogus" }, { from_kind: "meegle" }]);
  });

  it("四槽 docs 迁成数组：主任务和 merged 里的链接一条不丢，重复跑不变", () => {
    const d = new DatabaseSync(join(mkdtempSync(join(tmpdir(), "friday-db-")), "todos.db"));
    d.exec(SCHEMA);
    migrate(d);
    const src = { docs: { req: "https://a/req", tech: "https://a/tech", meegle: "https://a/mine" }, merged: [{ meegleId: "2", title: "二期", docs: { design: "https://a/ui" } }, { meegleId: "3", title: "无资料" }] };
    d.prepare("INSERT INTO tasks (id, title, kind, source, status, created_at, updated_at) VALUES ('t1', 't', 'meegle', ?, 'understood', 'x', 'x')").run(JSON.stringify(src));
    d.prepare("INSERT INTO tasks (id, title, kind, source, status, created_at, updated_at) VALUES ('t2', 't', 'verbal', ?, 'understood', 'x', 'x')").run(JSON.stringify({ docs: [{ url: "https://n/1", from: "user" }] }));
    migrate(d);
    migrate(d);
    const read = (id: string) => JSON.parse((d.prepare("SELECT source FROM tasks WHERE id = ?").get(id) as { source: string }).source);
    expect(read("t1").docs.slice(0, 3)).toEqual([{ url: "https://a/req", from: "sync" }, { url: "https://a/tech", from: "sync" }, { url: "https://a/mine", from: "user" }]);
    expect(read("t1").merged[0].docs).toEqual([{ url: "https://a/ui", from: "sync" }]);
    expect(read("t1").docs).toContainEqual({ url: "https://a/ui", from: "sync" });
    expect(read("t1").docs).toHaveLength(4);
    expect(read("t1").merged[1]).toEqual({ meegleId: "3", title: "无资料" });
    expect(read("t2").docs).toEqual([{ url: "https://n/1", from: "user" }]);
  });
});
