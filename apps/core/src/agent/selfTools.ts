import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { SettingsUpdate } from "@friday/shared";
import { settingsShape } from "../api/settings.js";
import { publish } from "../bus.js";
import { listMessages } from "../memory/conversations.js";
import { record } from "../memory/audit.js";
import { existsSync, statSync } from "node:fs";
import type { Feature } from "@friday/shared";
import { expandHome, loadProjects, projectSection, resolveProject, setProjectField, type ProjectFieldKey } from "../memory/projects.js";
import { correctFeature, deleteFeature, findFeatureByName, getFeature, getFeatureHistory, mergeFeatures, moveHistory, snapshotFeatures, writeKnowledge } from "../memory/features.js";
import { readMemoryFile, writeMemoryFile } from "../memory/files.js";
import { activeRules, editRule, getRule, snapshotRules } from "../memory/rules.js";
import { updateSettings, userSettings } from "../settings.js";

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

export const SETTINGS_KEYS = ["autonomous", "autonomousConcurrency", "autonomousMinConfidence", "model", "skills", "skillList", "okrWeekly", "learnHistory", "meegleDefects", "name", "theme"] as const;
type SettingsKey = (typeof SETTINGS_KEYS)[number];

const settingsPatch = z.object(Object.fromEntries(SETTINGS_KEYS.map((k) => [k, settingsShape[k]])) as Pick<typeof settingsShape, SettingsKey>).strict();

const show = (v: unknown) => (typeof v === "object" && v !== null ? JSON.stringify(v) : String(v));

export function saidLast(conversationId?: string): string {
  if (!conversationId) return "";
  return (listMessages(conversationId).filter((m) => m.role === "user").at(-1)?.content ?? "").trim();
}

const PROJECT_FIELDS = ["目录", "别名", "说明", "保护分支", "方案送审", "环境", "频道"] as const satisfies readonly ProjectFieldKey[];
const REVIEW_LEVELS = ["全部", "大的", "不用"];

const featurePatch = z
  .object({
    name: z.string().min(1).optional(),
    aliases: z.array(z.string()).optional(),
    where: z.string().optional(),
    paths: z.array(z.string()).optional(),
    owners: z.object({ frontend: z.string(), backend: z.string(), pm: z.string(), qa: z.string() }).partial().strict().optional(),
    summary: z.string().optional(),
  })
  .strict();

function resolveFeature(ref: string): Feature | string {
  const r = ref.trim();
  const byId = getFeature(r);
  if (byId) return byId;
  const i = r.search(/[:：]/);
  if (i > 0) {
    const key = r.slice(0, i).trim().toLowerCase();
    const project = loadProjects().find((p) => p.name.toLowerCase() === key);
    if (!project) return `没有项目「${r.slice(0, i)}」。`;
    const f = findFeatureByName(project.name, r.slice(i + 1));
    if (f) return f;
  }
  return `没找到这个功能：${ref}（要功能 id，或「项目:功能名」）`;
}

export const selfToolList = (conversationId?: string) => [
  tool(
    "settings_get",
    `读 Friday 的设置（可通过对话改的那部分）：${SETTINGS_KEYS.join("、")}。`,
    {},
    async () => {
      const cur = userSettings();
      return text(SETTINGS_KEYS.map((k) => `${k}：${show(cur[k])}`).join("\n"));
    },
  ),
  tool(
    "settings_update",
    `改 Friday 的设置，只能改这些键：${SETTINGS_KEYS.join("、")}。可撤销、会记账。用户明确要改才调；改完把「键：旧 → 新」告诉他。`,
    { patch: settingsPatch },
    async (args) => {
      const parsed = settingsPatch.safeParse(args.patch);
      if (!parsed.success) return text(`不能改：${parsed.error.issues.map((i) => `${i.path.join(".") || "patch"} ${i.message}`).join("；")}。能改的键只有 ${SETTINGS_KEYS.join("、")}。`);
      const next = parsed.data as SettingsUpdate;
      const keys = Object.keys(next) as SettingsKey[];
      if (!keys.length) return text("没有要改的键。");
      const cur = userSettings();
      const before = Object.fromEntries(keys.map((k) => [k, cur[k]])) as SettingsUpdate;
      const after = updateSettings(next);
      const afterPicked = Object.fromEntries(keys.map((k) => [k, after[k]]));
      const how = keys.map((k) => `${k}：${show(cur[k])} → ${show(after[k])}`).join("；");
      record({
        action: "settings_changed",
        why: "你在对话里让 Friday 改设置",
        how,
        evidence: { quote: saidLast(conversationId), before, after: afterPicked },
        risk: "reversible",
        undo: { kind: "restore_settings", before },
      });
      if (keys.includes("theme")) publish({ type: "settings" });
      return text(`改好了：${how}（可在操作记录里撤销）`);
    },
  ),
  tool(
    "project_update",
    `按字段改 projects.md 里的项目登记，可新建项目（create: true，必须给目录）。字段：${PROJECT_FIELDS.join("、")}；值为空串表示删掉这个字段；方案送审只认 全部 / 大的 / 不用。可撤销、会记账。用户明确要改才调。`,
    {
      project: z.string().min(1),
      fields: z.object(Object.fromEntries(PROJECT_FIELDS.map((k) => [k, z.string().optional()]))).strict(),
      create: z.boolean().optional(),
    },
    async ({ project, fields, create }) => {
      const entries = Object.entries(fields).filter(([, v]) => v !== undefined) as [ProjectFieldKey, string][];
      if (!entries.length && !create) return text("没有要改的字段。");
      if (create) {
        const n = project.trim();
        if (!n || /[\r\n]/.test(n) || n.startsWith("#")) return text("项目名不能为空、不能换行、不能以 # 开头。");
      }
      if (fields.目录 !== undefined && !fields.目录.trim()) return text("目录不能清空，项目会从注册表里消失。");
      const res = resolveProject(project);
      let name: string;
      if (res.kind === "match") name = res.project.name;
      else if (res.kind === "ambiguous") return text(`「${project}」对上了好几个项目：${res.candidates.map((c) => c.name).join("、")}，说清是哪个。`);
      else if (create) {
        name = project.trim();
        if (!fields.目录?.trim()) return text("新建项目必须给目录。");
      } else return text(`找不到项目「${project}」；要新建的话带 create: true 并给目录。`);
      const dir = fields.目录?.trim();
      if (dir) {
        const p = expandHome(dir);
        if (!existsSync(p) || !statSync(p).isDirectory()) return text(`目录不存在：${p}`);
      }
      const level = fields.方案送审?.trim();
      if (level && !REVIEW_LEVELS.includes(level)) return text(`方案送审只认：${REVIEW_LEVELS.join(" / ")}。`);
      const snapshot = { decisions: readMemoryFile("decisions"), people: readMemoryFile("people"), projects: readMemoryFile("projects") };
      let next = snapshot.projects;
      try {
        for (const [k, v] of entries) next = setProjectField(next, name, k, v);
      } catch (e) {
        return text(e instanceof Error ? e.message : String(e));
      }
      writeMemoryFile("projects", next);
      record({
        action: "project_updated",
        why: "你在对话里让 Friday 改项目登记",
        how: `${name}：${entries.map(([k, v]) => `${k}=${v || "（删除）"}`).join("；")}`,
        evidence: { quote: saidLast(conversationId), project: name, fields },
        risk: "reversible",
        undo: { kind: "restore_memory", snapshot },
      });
      return text(`改好了（可在操作记录里撤销）：\n${projectSection(next, name) ?? ""}`);
    },
  ),
  tool(
    "rules_list",
    "列手册规则（还在生效的），每条 `id · 段落 · 文本`，按项目分组，_global 在前。不给 project 就列全部。",
    { project: z.string().optional() },
    async ({ project }) => {
      const rules = activeRules(project?.trim() || undefined);
      if (!rules.length) return text("还没有规则");
      const names = [...new Set(rules.map((r) => r.project))].sort((a, b) => (a === "_global" ? -1 : b === "_global" ? 1 : a.localeCompare(b)));
      return text(names.map((n) => `【${n}】\n${rules.filter((r) => r.project === n).map((r) => `${r.id} · ${r.section} · ${r.text}`).join("\n")}`).join("\n\n"));
    },
  ),
  tool(
    "rule_update",
    "改一条手册规则的文字（1–120 字），改完算手改、之后自动提炼不会再动它。可撤销、会记账。用户明确要改才调；先用 rules_list 拿 id。",
    { id: z.string().min(1), text: z.string().min(1).max(120) },
    async ({ id, text: t }) => {
      const before = getRule(id);
      if (!before) return text("没有这条规则");
      if (before.status === "retired") return text("这条已经退役了");
      const snapshot = snapshotRules([id]);
      let after;
      try {
        after = editRule(id, { text: t });
      } catch (e) {
        return text(e instanceof Error ? e.message : String(e));
      }
      record({
        action: "rule_changed",
        why: "你在对话里让 Friday 改手册规则",
        how: `${before.project} · ${id}：${before.text} → ${after.text}`,
        evidence: { quote: saidLast(conversationId), before: before.text, after: after.text },
        risk: "reversible",
        undo: { kind: "restore_rules", snapshot },
      });
      return text(`改好了：${before.text} → ${after.text}（可在操作记录里撤销）`);
    },
  ),
  tool(
    "rule_retire",
    "退役一条手册规则，必须写一句原因 why。可撤销、会记账。用户明确要删 / 不要这条才调；先用 rules_list 拿 id。",
    { id: z.string().min(1), why: z.string().min(1).max(200) },
    async ({ id, why }) => {
      const before = getRule(id);
      if (!before) return text("没有这条规则");
      if (before.status === "retired") return text("这条已经退役了");
      const snapshot = snapshotRules([id]);
      try {
        editRule(id, { retire: why });
      } catch (e) {
        return text(e instanceof Error ? e.message : String(e));
      }
      record({
        action: "rule_retired",
        why: "你在对话里让 Friday 退役手册规则",
        how: `${before.project} · ${id}：${before.text}（${why.trim()}）`,
        evidence: { quote: saidLast(conversationId), before: before.text, after: `已退役：${why.trim()}` },
        risk: "reversible",
        undo: { kind: "restore_rules", snapshot },
      });
      return text(`已退役：${before.text}（可在操作记录里撤销）`);
    },
  ),
  tool(
    "knowledge_update",
    "纠正项目知识库（功能条目）。op: edit（id + patch，可改 name/aliases/where/paths/owners/summary，改过的字段之后收工学习不会再覆盖）、merge（keep + drop，同一项目，drop 的历史和名字并进 keep）、move（historyId + to，把一条历史挪到另一个功能）、delete（id，连历史一起删）。id / keep / drop / to 接功能 id 或「项目:功能名」。可撤销、会记账。用户明确要改才调。",
    {
      op: z.enum(["edit", "merge", "move", "delete"]),
      id: z.string().optional(),
      patch: featurePatch.optional(),
      keep: z.string().optional(),
      drop: z.string().optional(),
      historyId: z.number().int().optional(),
      to: z.string().optional(),
    },
    async (a) => {
      const need = (v: string | undefined, name: string): string | undefined => (v?.trim() ? undefined : `${a.op} 需要 ${name}。`);
      const pick = (v: string): Feature | string => resolveFeature(v);
      let involved: Feature[];
      let how: string;
      let run: () => void;
      if (a.op === "edit") {
        const miss = need(a.id, "id");
        if (miss) return text(miss);
        const parsed = featurePatch.safeParse(a.patch ?? {});
        if (!parsed.success) return text(`不能改：${parsed.error.issues.map((i) => `${i.path.join(".") || "patch"} ${i.message}`).join("；")}。能改的字段：name、aliases、where、paths、owners、summary。`);
        const keys = Object.keys(parsed.data);
        if (!keys.length) return text("没有要改的字段。");
        const f = pick(a.id!);
        if (typeof f === "string") return text(f);
        involved = [f];
        const changes = (keys as (keyof typeof f)[]).map((k) => `${k}：${show(f[k])} → ${show((parsed.data as Record<string, unknown>)[k])}`);
        how = `${f.project} · ${f.name}：${changes.join("；")}`;
        run = () => void correctFeature(f.id, parsed.data);
      } else if (a.op === "merge") {
        const miss = need(a.keep, "keep") ?? need(a.drop, "drop");
        if (miss) return text(miss);
        const keep = pick(a.keep!);
        if (typeof keep === "string") return text(keep);
        const drop = pick(a.drop!);
        if (typeof drop === "string") return text(drop);
        if (keep.id === drop.id) return text("keep 和 drop 是同一个功能。");
        if (keep.project !== drop.project) return text(`两个功能不在同一个项目（${keep.project} / ${drop.project}），不能合并。`);
        involved = [keep, drop];
        how = `${keep.project} · ${drop.name} 并入 ${keep.name}`;
        run = () => void mergeFeatures(keep.id, drop.id);
      } else if (a.op === "move") {
        const miss = need(a.to, "to");
        if (miss) return text(miss);
        if (a.historyId === undefined) return text("move 需要 historyId。");
        const h = getFeatureHistory(a.historyId);
        if (!h) return text(`没有这条历史：${a.historyId}`);
        const to = pick(a.to!);
        if (typeof to === "string") return text(to);
        const from = getFeature(h.featureId);
        if (!from) return text("这条历史挂着的功能已不在。");
        if (from.id === to.id) return text("已经在这个功能上了。");
        if (from.project !== to.project) return text(`两个功能不在同一个项目（${from.project} / ${to.project}），不能挪。`);
        involved = [from, to];
        how = `${from.project} · 历史 #${h.id}（${h.what}）：${from.name} → ${to.name}`;
        const hid = h.id;
        run = () => moveHistory(hid, to.id);
      } else {
        const miss = need(a.id, "id");
        if (miss) return text(miss);
        const f = pick(a.id!);
        if (typeof f === "string") return text(f);
        involved = [f];
        how = `${f.project} · 删掉 ${f.name}`;
        run = () => void deleteFeature(f.id);
      }
      const snapshot = snapshotFeatures(involved.map((f) => f.id), { withHistory: a.op !== "edit" });
      try {
        run();
      } catch (e) {
        return text(`${how}：没改成：${e instanceof Error ? e.message : String(e)}`);
      }
      try {
        record({
          action: "knowledge_corrected",
          why: "你在对话里让 Friday 纠正知识库",
          how,
          evidence: { quote: saidLast(conversationId), op: a.op, features: involved.map((f) => f.id) },
          risk: "reversible",
          undo: { kind: "restore_features", snapshot },
        });
      } catch (e) {
        return text(`${how}：改了但没记上账，没法撤销：${e instanceof Error ? e.message : String(e)}`);
      }
      try {
        for (const p of new Set(involved.map((f) => f.project))) writeKnowledge(p);
      } catch (e) {
        return text(`${how}：已改并记账，但知识库文件没重新生成：${e instanceof Error ? e.message : String(e)}（可在操作记录里撤销）`);
      }
      return text(`改好了：${how}（可在操作记录里撤销）`);
    },
  ),
];
