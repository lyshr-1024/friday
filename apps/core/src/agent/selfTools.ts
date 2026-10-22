import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { SettingsUpdate } from "@friday/shared";
import { settingsShape } from "../api/settings.js";
import { publish } from "../bus.js";
import { listMessages } from "../memory/conversations.js";
import { record } from "../memory/audit.js";
import { existsSync, statSync } from "node:fs";
import { expandHome, loadProjects, projectSection, resolveProject, setProjectField, type ProjectFieldKey } from "../memory/projects.js";
import { readMemoryFile, writeMemoryFile } from "../memory/files.js";
import { updateSettings, userSettings } from "../settings.js";

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

export const SETTINGS_KEYS = ["autonomous", "autonomousConcurrency", "autonomousMinConfidence", "model", "skills", "skillList", "okrWeekly", "learnHistory", "meegleDefects", "name", "theme"] as const;
type SettingsKey = (typeof SETTINGS_KEYS)[number];

const settingsPatch = z.object(Object.fromEntries(SETTINGS_KEYS.map((k) => [k, settingsShape[k]])) as Pick<typeof settingsShape, SettingsKey>).strict();

const show = (v: unknown) => (Array.isArray(v) ? JSON.stringify(v) : String(v));

export function saidLast(conversationId?: string): string {
  if (!conversationId) return "";
  return (listMessages(conversationId).filter((m) => m.role === "user").at(-1)?.content ?? "").trim();
}

const PROJECT_FIELDS = ["目录", "别名", "说明", "保护分支", "方案送审", "环境", "频道"] as const satisfies readonly ProjectFieldKey[];
const REVIEW_LEVELS = ["全部", "大的", "不用"];

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
];
