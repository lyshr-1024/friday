import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { isQueryTask, type Feature, type FeatureOwners, type Task } from "@friday/shared";
import { config } from "../config.js";
import { record } from "../memory/audit.js";
import { addFeatureHistory, createFeature, findFeatureByName, getFeature, listFeatures, mergeFeature, snapshotFeatures, withoutCorrected, writeKnowledge, type FeatureInput, type FeaturesSnapshot } from "../memory/features.js";
import { loadProjects } from "../memory/projects.js";
import { askStream, SONNET_MODEL } from "./claude.js";
import { UNTRUSTED_NOTE, untrusted } from "./fence.js";
import { diffStatSync } from "./git.js";

export interface LearnItem extends FeatureInput {
  match?: string;
  what: string;
}

const MAX_ITEMS = 5;
const MAX_FILES = 50;
const OWNER_KEYS = ["backend", "pm", "design", "qa"] as const;

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()) : []);

export function cleanInput(raw: unknown, repoDir: string): FeatureInput | undefined {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name.trim() : "";
  if (name.length < 1 || name.length > 40) return undefined;
  const paths = strings(o.paths)
    .map((p) => p.replace(/^(\.\/)+/, ""))
    .filter((p) => p && !isAbsolute(p) && !normalize(p).startsWith("..") && existsSync(join(repoDir, p)));
  const owners: FeatureOwners = {};
  const rawOwners = (o.owners && typeof o.owners === "object" ? o.owners : {}) as Record<string, unknown>;
  for (const k of OWNER_KEYS) {
    const v = rawOwners[k];
    if (typeof v === "string" && v.trim()) owners[k] = v.trim();
  }
  return {
    name,
    aliases: strings(o.aliases),
    where: typeof o.where === "string" ? o.where.trim() : "",
    paths: [...new Set(paths)],
    routes: strings(o.routes),
    owners,
    summary: typeof o.summary === "string" ? o.summary.trim() : "",
  };
}

export function learnPrompt(task: Task, files: string[], candidates: Feature[]): { system: string; prompt: string } {
  const system = [
    "你在给一个项目的功能知识库记账：根据刚收工的任务，判断它动了哪些产品功能。",
    '只输出 JSON：{ "features": [ { "match"?: string, "name": string, "aliases": string[], "where": string, "paths": string[], "routes": string[], "owners": { "backend"?, "pm"?, "design"?, "qa"? }, "summary": string, "what": string } ] }，最多 5 条。',
    "一个功能 = 用户在界面上能叫出名字的东西（页面、弹窗、一条规则、一个流程），不是文件或函数。",
    "match 只能填下面候选里的 id，表示这次动的是已有的那个功能；不在候选里就不要填 match。",
    "paths 写相对主仓的目录或文件；what 一句话写这次改了它什么。拿不准的不要写，宁缺毋滥。",
    UNTRUSTED_NOTE,
  ].join("\n");
  const r = task.report;
  const body = [
    `标题：${task.title}`,
    task.understanding && `理解：${task.understanding}`,
    r?.summary && `交付概要：${r.summary}`,
    r?.changes.length && `改动：\n${r.changes.join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n");
  const cand = candidates.length ? candidates.map((f) => `${f.id} · ${f.name} · ${f.aliases.join("/")} · ${f.paths.join("、")}`).join("\n") : "（还没有）";
  const prompt = [untrusted("task", body), `改动文件：\n${untrusted("files", files.join("\n") || "（无）")}`, `候选功能：\n${untrusted("knowledge", cand)}`].join("\n\n");
  return { system, prompt };
}

export function parseLearn(text: string, candidates: Feature[], repoDir: string): LearnItem[] {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return [];
  let raw: { features?: unknown };
  try {
    raw = JSON.parse(m[0]);
  } catch {
    return [];
  }
  const ids = new Set(candidates.map((c) => c.id));
  const out: LearnItem[] = [];
  for (const it of Array.isArray(raw.features) ? raw.features : []) {
    const o = it as Record<string, unknown>;
    const input = cleanInput(o, repoDir);
    const what = typeof o.what === "string" ? o.what.trim() : "";
    if (!input || !what) continue;
    if (o.match !== undefined && o.match !== null && o.match !== "") {
      if (typeof o.match !== "string" || !ids.has(o.match)) continue;
      out.push({ ...input, match: o.match, what });
    } else out.push({ ...input, what });
  }
  return out.slice(0, MAX_ITEMS);
}

export function changedFiles(task: Task): string[] {
  const wt = task.source.worktree;
  if (wt && existsSync(wt) && statSync(wt).isDirectory()) {
    const d = diffStatSync(wt);
    if (d) return d.diffFiles.map((f) => f.path).slice(0, MAX_FILES);
  }
  return (task.report?.changes ?? [])
    .map((l) => l.split(" — ")[0]!.trim())
    .filter(Boolean)
    .slice(0, MAX_FILES);
}

export function applyLearn(project: string, taskId: string, items: LearnItem[], files: string[], at = new Date().toISOString()): FeaturesSnapshot {
  const targets = items.map((i) => i.match ?? findFeatureByName(project, i.name)?.id);
  const snap = snapshotFeatures([...new Set(targets.filter((t): t is string => !!t))]);
  items.forEach(({ match, what, ...input }, n) => {
    const target = targets[n];
    let id: string;
    if (target) {
      const cur = getFeature(target)!;
      const renamed = input.name !== cur.name ? [input.name] : [];
      id = mergeFeature(target, withoutCorrected(cur, { ...input, name: cur.name, aliases: [...(input.aliases ?? []), ...renamed] }), at).id;
    } else {
      id = createFeature(project, input, "task", at).id;
      snap.added.push(id);
    }
    snap.historyIds.push(addFeatureHistory({ featureId: id, taskId, at, what, files }));
  });
  writeKnowledge(project);
  return snap;
}

async function defaultAsk(system: string, prompt: string): Promise<string> {
  let text = "";
  for await (const ev of askStream(prompt, { systemPrompt: system, cwd: config.dataDir, model: SONNET_MODEL, oneShot: true, label: "knowledge" })) {
    if (ev.type === "delta") text += ev.text;
    if (ev.type === "reset") text = "";
    if (ev.type === "error") throw new Error(ev.message);
  }
  return text;
}

export async function learnFromTask(task: Task, ask = defaultAsk): Promise<FeaturesSnapshot | undefined> {
  if (task.status !== "done" || !task.project || task.kind === "project" || isQueryTask(task.source)) return undefined;
  const project = loadProjects().find((p) => p.name === task.project);
  if (!project || !(task.source.branch || task.report)) return undefined;
  const files = changedFiles(task);
  const candidates = listFeatures(project.name);
  const { system, prompt } = learnPrompt(task, files, candidates);
  const items = parseLearn(await ask(system, prompt), candidates, project.dir);
  if (!items.length) return undefined;
  const snapshot = applyLearn(project.name, task.id, items, files);
  record({
    taskId: task.id,
    action: "knowledge_updated",
    why: "任务收工，记下这次动了哪些功能",
    how: `${items.length} 条：${items.map((i) => i.name).join("、")}`,
    evidence: { features: [...snapshot.added, ...snapshot.features.map((f) => f.id)] },
    risk: "reversible",
    undo: { kind: "restore_features", snapshot },
  });
  return snapshot;
}

export function onTaskDone(before: Task, after: Task): void {
  if (before.status === "done" || after.status !== "done") return;
  void learnFromTask(after).catch((e) => console.warn("[knowledge]", e));
}
