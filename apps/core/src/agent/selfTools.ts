import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { SettingsUpdate } from "@friday/shared";
import { settingsShape } from "../api/settings.js";
import { publish } from "../bus.js";
import { listMessages } from "../memory/conversations.js";
import { record } from "../memory/audit.js";
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
];
