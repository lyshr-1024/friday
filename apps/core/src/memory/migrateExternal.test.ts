import { existsSync, mkdtempSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync as Db } from "node:sqlite";
import { beforeAll, describe, expect, it } from "vitest";
import { seedBuiltins } from "../connectors/builtin.js";
import * as rules from "../connectors/meegle/rules.js";
import { contextFor } from "../agent/bridge.js";
import { briefPrompt } from "../agent/briefJob.js";
import { syncWorkItemsOnce } from "../agent/workItems.js";
import { db, migrate } from "./db.js";
import { LEGACY_KEYS } from "./externalRef.js";
import { addInboxItems } from "./inbox.js";
import { extNode, taskNode } from "./infer.js";
import { neighbors } from "./links.js";
import { MIGRATION_KEY, migrateExternalRefs } from "./migrateExternal.js";
import type { Project } from "./projects.js";
import { createTask, deleteTask, getTask, listTasks, restoreTask } from "./tasks.js";
import { SCHEMA } from "./schema.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

beforeAll(() => seedBuiltins());

const OLD_LINKS = `CREATE TABLE links (
  id TEXT PRIMARY KEY,
  from_kind TEXT NOT NULL CHECK (from_kind IN ('task', 'meegle', 'thread', 'branch', 'url', 'project', 'slack', 'channel')),
  from_ref TEXT NOT NULL,
  to_kind TEXT NOT NULL CHECK (to_kind IN ('task', 'meegle', 'thread', 'branch', 'url', 'project', 'slack', 'channel')),
  to_ref TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('user', 'rule', 'guess')),
  why TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

const AT = "2026-10-01T00:00:00Z";
const addTask = (d: Db, id: string, kind: string, source: unknown, pending?: unknown) =>
  d
    .prepare("INSERT INTO tasks (id, title, kind, source, status, pending, created_at, updated_at) VALUES (?, ?, ?, ?, 'understood', ?, ?, ?)")
    .run(id, `标题 ${id}`, kind, typeof source === "string" ? source : JSON.stringify(source), pending ? JSON.stringify(pending) : null, AT, AT);
const addRun = (d: Db, id: string, trigger: string) =>
  d.prepare("INSERT INTO runs (id, job_id, task_id, project, kind, trigger, started_at) VALUES (?, ?, 't', 'p', 'autonomous', ?, ?)").run(id, id, trigger, AT);
const raw = (d: Db, id: string) => d.prepare("SELECT kind, source, pending FROM tasks WHERE id = ?").get(id) as { kind: string; source: string; pending: string | null };
const marker = (d: Db) => (d.prepare("SELECT cursor FROM sync_state WHERE source = ?").get(MIGRATION_KEY) as { cursor: string } | undefined)?.cursor;
const backups = (dir: string) => (existsSync(join(dir, "backups")) ? readdirSync(join(dir, "backups")) : []);
const legacyIn = (src: Record<string, unknown>) => LEGACY_KEYS.filter((k) => k in src);

const replyPending = [{ id: "p1", type: "slack_reply", label: "回复", detail: "好的", payload: { channel: "C3", threadTs: "3.0", userName: "拂晓", text: "好的" }, at: AT }];

function oldDb(withOldLinks = false) {
  const dir = mkdtempSync(join(tmpdir(), "friday-mig-"));
  const d = new DatabaseSync(join(dir, "todos.db"));
  if (withOldLinks) d.exec(OLD_LINKS);
  d.exec(SCHEMA);
  addTask(d, "m1", "meegle", { meegleId: "24440539", meegleType: "issue", statusKey: "OPEN", linkedStoryId: "1", linkedStoryName: "需求", nodeKey: "n1", nodeName: "开发", conversation: "C1:1.0", mergedMeegleIds: ["2"], merged: [{ meegleId: "2", title: "二期" }], storyContainer: true, url: "https://x/1" });
  addTask(d, "s1", "slack", { conversation: "C2:2.0", channelId: "C2", threadTs: "2.0", userName: "拂晓", headless: true });
  addTask(d, "r1", "slack", { threadId: "TH1" }, replyPending);
  addRun(d, "run1", "slack");
  addRun(d, "run2", "autostart");
  return { d, dir };
}

describe("外部引用库迁移", () => {
  it("老形状的任务、待审、结果账本一次迁成新形状；带备份和标记，再跑是 no-op", () => {
    const { d, dir } = oldDb();
    migrate(d);

    const m1 = JSON.parse(raw(d, "m1").source);
    expect(raw(d, "m1").kind).toBe("work_item");
    expect(m1.external).toMatchObject({ tool: "meegle", type: "work_item", id: "24440539", kind: "defect", state: { key: "OPEN" }, parent: { id: "1", name: "需求" }, step: { key: "n1", name: "开发" } });
    expect(m1).toMatchObject({ mergedIds: ["2"], container: true, merged: [{ id: "2", title: "二期" }], url: "https://x/1" });
    expect(m1.merged[0].meegleId).toBeUndefined();
    const s1 = JSON.parse(raw(d, "s1").source);
    expect(raw(d, "s1").kind).toBe("conversation");
    expect(s1.external).toMatchObject({ tool: "slack", type: "conversation", id: "C2:2.0", author: "拂晓", attrs: { channelId: "C2", threadTs: "2.0" } });
    expect(JSON.parse(raw(d, "r1").source).external).toMatchObject({ id: "TH1", attrs: { legacy: "thread" } });
    const pending = JSON.parse(raw(d, "r1").pending!);
    expect(pending[0]).toMatchObject({ type: "chat_reply", payload: { to: { tool: "slack", type: "conversation", id: "C3:3.0" }, text: "好的" } });
    for (const id of ["m1", "s1", "r1"]) expect(legacyIn(JSON.parse(raw(d, id).source))).toEqual([]);
    expect(d.prepare("SELECT id, trigger FROM runs ORDER BY id").all()).toEqual([{ id: "run1", trigger: "chat" }, { id: "run2", trigger: "autostart" }]);

    // 工单号和对话键都有：对话键成了一条 rule 边
    const edge = d.prepare("SELECT from_kind, from_ref, to_kind, to_ref, source, why FROM links").all();
    expect(edge).toEqual([{ from_kind: "ext", from_ref: "slack:conversation:C1:1.0", to_kind: "task", to_ref: "m1", source: "rule", why: "迁移：任务同时带工单号和对话键" }]);

    const path = marker(d)!;
    expect(path).toBe(join(realpathSync(dir), "backups", backups(dir)[0]!));
    const copy = new DatabaseSync(path, { readOnly: true });
    expect(copy.prepare("SELECT kind FROM tasks WHERE id = 'm1'").get()).toEqual({ kind: "meegle" });
    copy.close();

    expect(migrateExternalRefs(d)).toBeUndefined();
    const before = d.prepare("SELECT * FROM tasks ORDER BY id").all();
    migrate(d);
    expect(d.prepare("SELECT * FROM tasks ORDER BY id").all()).toEqual(before);
    expect(backups(dir)).toHaveLength(1);
    expect((d.prepare("SELECT COUNT(*) AS n FROM links").get() as { n: number }).n).toBe(1);
    // 老 thread 任务从来不补阶段；threadId 迁走之后也不能被补上
    expect(d.prepare("SELECT stage FROM tasks WHERE id = 'r1'").get()).toEqual({ stage: null });
  });

  it("备份在 links 迁移之前：老 links 表和老任务都在备份里，只备份一次", () => {
    const { d, dir } = oldDb(true);
    d.prepare("INSERT INTO links (id, from_kind, from_ref, to_kind, to_ref, source, why, created_at, updated_at) VALUES ('l1', 'meegle', '24440539', 'task', 'm1', 'rule', '旧边', ?, ?)").run(AT, AT);
    migrate(d);

    expect(backups(dir)).toHaveLength(1);
    const copy = new DatabaseSync(marker(d)!, { readOnly: true });
    expect(copy.prepare("SELECT from_kind FROM links").all()).toEqual([{ from_kind: "meegle" }]);
    expect((copy.prepare("SELECT sql FROM sqlite_master WHERE name = 'links'").get() as { sql: string }).sql).toContain("'meegle'");
    expect(JSON.parse((copy.prepare("SELECT source FROM tasks WHERE id = 'm1'").get() as { source: string }).source).meegleId).toBe("24440539");
    copy.close();
    expect(d.prepare("SELECT from_ref FROM links WHERE id = 'l1'").get()).toEqual({ from_ref: "meegle:work_item:24440539" });

    migrate(d);
    expect(backups(dir)).toHaveLength(1);
  });

  it("全新空库：直接写标记，不建备份目录；之后的启动也不备份", () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-mig-"));
    const d = new DatabaseSync(join(dir, "todos.db"));
    d.exec(SCHEMA);
    migrate(d);
    expect(marker(d)).toBe("");
    expect(existsSync(join(dir, "backups"))).toBe(false);
    migrate(d);
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });

  it("连续四次迁移失败：备份只留最新 3 份，别的文件不碰", () => {
    const { d, dir } = oldDb();
    addTask(d, "bad", "verbal", "{not json");
    d.exec("ALTER TABLE tasks ADD COLUMN stage TEXT");
    d.exec("ALTER TABLE tasks ADD COLUMN stage_by TEXT");
    d.prepare("UPDATE tasks SET stage = 'todo', stage_by = 'auto' WHERE id = 'bad'").run();
    const seen: string[][] = [];
    for (let i = 0; i < 4; i++) {
      const before = new Set(backups(dir));
      migrate(d);
      seen.push(backups(dir).filter((f) => !before.has(f)));
    }
    expect(marker(d)).toBeUndefined();
    expect(seen.map((s) => s.length)).toEqual([1, 1, 1, 1]);
    const left = backups(dir).filter((f) => f.startsWith("todos-"));
    expect(left).toHaveLength(3);
    expect(left).not.toContain(seen[0]![0]);
    for (const s of seen.slice(1)) expect(left).toContain(s[0]);
  });

  it("有一行 source 是坏 JSON：整体回滚、不写标记、启动照常；好行读出来仍是新形状", () => {
    const d = db();
    d.prepare("DELETE FROM sync_state WHERE source = ?").run(MIGRATION_KEY);
    addTask(d, "good", "meegle", { meegleId: "777", meegleType: "story" });
    addTask(d, "bad", "verbal", "{not json");
    // 真实库里老行早被补过阶段；补阶段那条 SQL 会 json_extract 没阶段的行
    d.prepare("UPDATE tasks SET stage = 'todo', stage_by = 'auto' WHERE id = 'bad'").run();
    addRun(d, "run-bad", "slack");

    expect(() => migrate(d)).not.toThrow();
    expect(marker(d)).toBeUndefined();
    expect(raw(d, "good").kind).toBe("meegle");
    expect(JSON.parse(raw(d, "good").source)).toEqual({ meegleId: "777", meegleType: "story" });
    expect(d.prepare("SELECT trigger FROM runs WHERE id = 'run-bad'").get()).toEqual({ trigger: "slack" });

    d.prepare("DELETE FROM tasks WHERE id = 'bad'").run();
    const good = listTasks().find((t) => t.id === "good")!;
    expect(good).toMatchObject({ kind: "work_item", source: { external: { tool: "meegle", type: "work_item", id: "777", kind: "story" } } });

    migrate(d);
    expect(marker(d)).toBeTruthy();
    expect(legacyIn(JSON.parse(raw(d, "good").source))).toEqual([]);
  });

  it("撤销删除时快照是老形状：放回去是新形状，同步同一工单不新建", async () => {
    const t = createTask({ title: "老需求", kind: "work_item", source: { external: { tool: "meegle", type: "work_item", id: "88001", kind: "story" } }, status: "understood" });
    const snap = deleteTask(t.id)!;
    snap.kind = "meegle";
    snap.source = JSON.stringify({ meegleId: "88001", meegleType: "story", url: "https://x/88001" });
    snap.pending = JSON.stringify(replyPending);
    expect(restoreTask(snap)).toBe(true);

    const back = getTask(t.id)!;
    expect(back).toMatchObject({ kind: "work_item", source: { external: { tool: "meegle", type: "work_item", id: "88001", kind: "story" } } });
    expect(back.pending![0]).toMatchObject({ type: "chat_reply", payload: { to: { id: "C3:3.0" } } });
    expect(raw(db(), t.id).kind).toBe("work_item");
    expect(legacyIn(JSON.parse(raw(db(), t.id).source))).toEqual([]);
    expect(raw(db(), t.id).pending).toContain('"chat_reply"');

    const item = { id: "88001", name: "老需求", typeName: "Story", typeKey: "story", links: [], status: "Open", projectName: "demo", url: "https://x/88001", createdAt: AT, kind: "story", state: "open" };
    const res = await syncWorkItemsOnce({ ...rules, listMine: async () => [item] } as never);
    expect(res.added).toBe(0);
    expect(listTasks(undefined, 1000).filter((x) => x.source.external?.id === "88001").map((x) => x.id)).toEqual([t.id]);
  });

  it("迁移给同时带工单号和对话键的任务补的边：理解卡提示词和终端背景都还带着这段对话", () => {
    const d = db();
    d.prepare("DELETE FROM sync_state WHERE source = ?").run(MIGRATION_KEY);
    addTask(d, "both", "meegle", { meegleId: "99001", meegleType: "story", conversation: "C9:9.0" });
    addInboxItems([{ id: "C9:9.0", kind: "mention", channelId: "C9", channelName: "proj-导出", userId: "U9", userName: "佳成", text: "导出的日期筛选不对", permalink: "https://slack/x", ts: "9.0" }]);
    migrate(d);

    expect(neighbors(taskNode("both"), "ext")).toEqual([{ ref: extNode("slack", "conversation", "C9:9.0").ref, source: "rule", why: "迁移：任务同时带工单号和对话键" }]);
    const t = getTask("both")!;
    expect(t.source.external).toMatchObject({ tool: "meegle", id: "99001" });
    const p: Project = { name: "p-mig", dir: "/tmp/p-mig", aliases: [], channels: [], urls: [], envs: [], protected: [], extra: {} };
    expect(briefPrompt(t, p)).toContain("导出的日期筛选不对");
    expect(contextFor(t)).toContain("导出的日期筛选不对");
  });
});
