import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Feature, FeatureHistory, FeatureOrigin, FeatureOwners } from "@friday/shared";
import { config } from "../config.js";
import { db } from "./db.js";
import { handbookSlug } from "./handbooks.js";

export interface FeatureInput {
  name: string;
  aliases?: string[];
  where?: string;
  paths?: string[];
  routes?: string[];
  owners?: FeatureOwners;
  summary?: string;
}

export interface FeatureRow {
  id: string;
  project: string;
  name: string;
  aliases: string;
  where_: string;
  paths: string;
  routes: string;
  owners: string;
  summary: string;
  origin: FeatureOrigin;
  corrected?: string;
  created_at: string;
  updated_at: string;
}
export interface HistoryRow {
  id: number;
  feature_id: string;
  task_id: string | null;
  at: string;
  what: string;
  files: string;
}
export interface FeaturesSnapshot {
  features: FeatureRow[];
  added: string[];
  historyIds: number[];
  history?: HistoryRow[];
}

const KNOWLEDGE_DIR = "knowledge";
const knowledgeDir = (): string => join(config.dataDir, KNOWLEDGE_DIR);
const knowledgePath = (project: string): string => join(knowledgeDir(), `${handbookSlug(project)}.md`);

const norm = (s: string): string => s.replace(/\s+/g, "").toLowerCase();
const union = (a: string[], b: string[] = []): string[] => [...new Set([...a, ...b])];

const toFeature = (r: FeatureRow): Feature => ({
  id: r.id,
  project: r.project,
  name: r.name,
  aliases: JSON.parse(r.aliases),
  where: r.where_,
  paths: JSON.parse(r.paths),
  routes: JSON.parse(r.routes),
  owners: JSON.parse(r.owners),
  summary: r.summary,
  origin: r.origin,
  corrected: JSON.parse(r.corrected ?? "[]"),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toHistory = (r: HistoryRow): FeatureHistory => ({
  id: r.id,
  featureId: r.feature_id,
  ...(r.task_id ? { taskId: r.task_id } : {}),
  at: r.at,
  what: r.what,
  files: JSON.parse(r.files),
});

export function getFeature(id: string): Feature | undefined {
  const r = db().prepare("SELECT * FROM features WHERE id = ?").get(id) as unknown as FeatureRow | undefined;
  return r && toFeature(r);
}

export function listFeatures(project: string): Feature[] {
  const rows = db().prepare("SELECT * FROM features WHERE project = ? ORDER BY updated_at DESC, rowid DESC").all(project) as unknown as FeatureRow[];
  return rows.map(toFeature);
}

export function createFeature(project: string, input: FeatureInput, origin: FeatureOrigin, at = new Date().toISOString()): Feature {
  const id = `f-${randomBytes(4).toString("hex")}`;
  db()
    .prepare("INSERT INTO features (id, project, name, aliases, where_, paths, routes, owners, summary, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      id,
      project,
      input.name,
      JSON.stringify(input.aliases ?? []),
      input.where ?? "",
      JSON.stringify(input.paths ?? []),
      JSON.stringify(input.routes ?? []),
      JSON.stringify(input.owners ?? {}),
      input.summary ?? "",
      origin,
      at,
      at,
    );
  return getFeature(id)!;
}

export function mergeFeature(id: string, input: Partial<FeatureInput>, at = new Date().toISOString()): Feature {
  const cur = getFeature(id)!;
  db()
    .prepare("UPDATE features SET name = ?, aliases = ?, where_ = ?, paths = ?, routes = ?, owners = ?, summary = ?, updated_at = ? WHERE id = ?")
    .run(
      input.name || cur.name,
      JSON.stringify(union(cur.aliases, input.aliases)),
      input.where || cur.where,
      JSON.stringify(union(cur.paths, input.paths)),
      JSON.stringify(union(cur.routes, input.routes)),
      JSON.stringify({ ...cur.owners, ...input.owners }),
      input.summary || cur.summary,
      at,
      id,
    );
  return getFeature(id)!;
}

type Correctable = "name" | "aliases" | "where" | "paths" | "owners" | "summary";
export const CORRECTABLE: readonly Correctable[] = ["name", "aliases", "where", "paths", "owners", "summary"];

export function correctFeature(id: string, patch: Partial<Pick<FeatureInput, Correctable>>, at = new Date().toISOString()): Feature {
  const cur = getFeature(id)!;
  const keys = CORRECTABLE.filter((k) => patch[k] !== undefined);
  const next = {
    name: patch.name ?? cur.name,
    aliases: patch.aliases ?? cur.aliases,
    where: patch.where ?? cur.where,
    paths: patch.paths ?? cur.paths,
    owners: patch.owners ?? cur.owners,
    summary: patch.summary ?? cur.summary,
  };
  db()
    .prepare("UPDATE features SET name = ?, aliases = ?, where_ = ?, paths = ?, owners = ?, summary = ?, corrected = ?, updated_at = ? WHERE id = ?")
    .run(next.name, JSON.stringify(next.aliases), next.where, JSON.stringify(next.paths), JSON.stringify(next.owners), next.summary, JSON.stringify(union(cur.corrected ?? [], keys)), at, id);
  return getFeature(id)!;
}

export function withoutCorrected(cur: Feature, input: Partial<FeatureInput>): Partial<FeatureInput> {
  const out = { ...input };
  for (const k of cur.corrected ?? []) delete out[k as keyof FeatureInput];
  return out;
}

export function mergeFeatures(keepId: string, dropId: string, at = new Date().toISOString()): Feature {
  const keep = getFeature(keepId)!;
  const drop = getFeature(dropId)!;
  const d = db();
  d.exec("BEGIN");
  try {
    d.prepare("UPDATE feature_history SET feature_id = ? WHERE feature_id = ?").run(keepId, dropId);
    d.prepare("DELETE FROM features WHERE id = ?").run(dropId);
    d.prepare("UPDATE features SET aliases = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(union(keep.aliases, [drop.name, ...drop.aliases].filter((n) => norm(n) !== norm(keep.name)))), at, keepId);
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
  return getFeature(keepId)!;
}

export function getFeatureHistory(historyId: number): FeatureHistory | undefined {
  const r = db().prepare("SELECT * FROM feature_history WHERE id = ?").get(historyId) as unknown as HistoryRow | undefined;
  return r && toHistory(r);
}

export function moveHistory(historyId: number, toFeatureId: string): void {
  db().prepare("UPDATE feature_history SET feature_id = ? WHERE id = ?").run(toFeatureId, historyId);
}

export function findFeatureByName(project: string, name: string): Feature | undefined {
  const key = norm(name);
  return listFeatures(project).find((f) => norm(f.name) === key || f.aliases.some((a) => norm(a) === key));
}

export function deleteFeature(id: string): boolean {
  db().prepare("DELETE FROM feature_history WHERE feature_id = ?").run(id);
  return Number(db().prepare("DELETE FROM features WHERE id = ?").run(id).changes) > 0;
}

export function addFeatureHistory(h: Omit<FeatureHistory, "id">): number {
  const r = db().prepare("INSERT INTO feature_history (feature_id, task_id, at, what, files) VALUES (?, ?, ?, ?, ?)").run(h.featureId, h.taskId ?? null, h.at, h.what, JSON.stringify(h.files));
  return Number(r.lastInsertRowid);
}

export function featureHistory(featureId: string): FeatureHistory[] {
  const rows = db().prepare("SELECT * FROM feature_history WHERE feature_id = ? ORDER BY at DESC, id DESC").all(featureId) as unknown as HistoryRow[];
  return rows.map(toHistory);
}

export function hasHistoryFor(featureId: string, taskId: string): boolean {
  return !!db().prepare("SELECT 1 FROM feature_history WHERE feature_id = ? AND task_id = ?").get(featureId, taskId);
}

export function snapshotFeatures(ids: string[], opts: { withHistory?: boolean } = {}): FeaturesSnapshot {
  const marks = ids.map(() => "?").join(",");
  const features = ids.length ? (db().prepare(`SELECT * FROM features WHERE id IN (${marks})`).all(...ids) as unknown as FeatureRow[]) : [];
  const snap: FeaturesSnapshot = { features, added: [], historyIds: [] };
  if (opts.withHistory) snap.history = ids.length ? (db().prepare(`SELECT * FROM feature_history WHERE feature_id IN (${marks})`).all(...ids) as unknown as HistoryRow[]) : [];
  return snap;
}

export function restoreFeatures(s: FeaturesSnapshot): string[] {
  const d = db();
  const projects = new Set<string>(s.features.map((f) => f.project));
  for (const id of s.added) {
    const cur = getFeature(id);
    if (cur) projects.add(cur.project);
  }
  d.exec("BEGIN");
  try {
    for (const id of s.historyIds) d.prepare("DELETE FROM feature_history WHERE id = ?").run(id);
    // 之后别的任务往这个功能上记过历史，功能就留着
    for (const id of s.added) d.prepare("DELETE FROM features WHERE id = ? AND NOT EXISTS (SELECT 1 FROM feature_history WHERE feature_id = ?)").run(id, id);
    const up = d.prepare("INSERT OR REPLACE INTO features (id, project, name, aliases, where_, paths, routes, owners, summary, origin, corrected, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const f of s.features) up.run(f.id, f.project, f.name, f.aliases, f.where_, f.paths, f.routes, f.owners, f.summary, f.origin, f.corrected ?? "[]", f.created_at, f.updated_at);
    const hist = d.prepare("INSERT OR REPLACE INTO feature_history (id, feature_id, task_id, at, what, files) VALUES (?, ?, ?, ?, ?, ?)");
    for (const h of s.history ?? []) hist.run(h.id, h.feature_id, h.task_id, h.at, h.what, h.files);
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
  return [...projects];
}

const bigrams = (s: string): string[] => {
  const t = norm(s);
  return [...new Set(Array.from({ length: Math.max(0, t.length - 1) }, (_, i) => t.slice(i, i + 2)))];
};

export function matchFeatures(project: string, text: string, limit = 5): Feature[] {
  const t = norm(text);
  const hit = (s: string) => {
    const k = norm(s);
    return k.length >= 2 && t.includes(k);
  };
  return listFeatures(project)
    .map((f) => {
      const base = hit(f.name) ? 10 : f.aliases.some(hit) ? 8 : 0;
      if (!base) return { f, score: 0 };
      return { f, score: base + bigrams(`${f.where} ${f.summary}`).filter((g) => t.includes(g)).length };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.f.updatedAt.localeCompare(a.f.updatedAt))
    .slice(0, limit)
    .map((x) => x.f);
}

export function renderKnowledge(project: string): string {
  const parts = [`# ${project} 知识库\n`, "<!-- Friday 生成，改这个文件会被覆盖；要改去 Friday 里的项目知识库 -->\n"];
  for (const f of listFeatures(project)) {
    const hist = featureHistory(f.id);
    const last = hist[0];
    const owners = Object.entries(f.owners)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k} ${v}`)
      .join(" / ");
    const lines = [
      f.aliases.length && `- 别名：${f.aliases.join("、")}`,
      f.where && `- 在哪：${f.where}`,
      f.paths.length && `- 目录：${f.paths.join("、")}`,
      f.routes.length && `- 路由：${f.routes.join("、")}`,
      owners && `- 负责人：${owners}`,
      f.summary && `- 说明：${f.summary}`,
      last && `- 动过 ${hist.length} 次（最近：${last.what}）`,
    ].filter((l): l is string => !!l);
    parts.push(`## ${f.name} <!-- ${f.id} -->`, ...lines, "");
  }
  return parts.join("\n");
}

export function writeKnowledge(project: string): void {
  const path = knowledgePath(project);
  if (!listFeatures(project).length) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(knowledgeDir(), { recursive: true });
  writeFileSync(`${path}.tmp`, renderKnowledge(project));
  renameSync(`${path}.tmp`, path);
}

export function readKnowledge(project: string): string {
  try {
    return readFileSync(knowledgePath(project), "utf8");
  } catch {
    return "";
  }
}

export function listKnowledge(): string[] {
  if (!existsSync(knowledgeDir())) return [];
  return readdirSync(knowledgeDir())
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -".md".length))
    .sort();
}

export function knowledgeBlock(project: string, text: string, limit = 1500): string {
  const head = `项目 ${project} 里跟这件事相关的功能（Friday 的知识库，可能不全；memory_read knowledge:${project} 看整份）：`;
  const lines: string[] = [];
  let used = head.length + 1;
  for (const f of matchFeatures(project, text)) {
    const line = `- ${[f.name, f.where, f.paths.join("、")].filter(Boolean).join(" — ")}`;
    if (used + line.length + 1 > limit) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.length ? [head, ...lines].join("\n") : "";
}
