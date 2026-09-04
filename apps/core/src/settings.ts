import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MODEL_OPTIONS, type ModelId, type SettingsUpdate } from "@friday/shared";
import { config } from "./config.js";

export type TerminalApp = "ghostty" | "terminal";

export interface UserSettings {
  terminal: TerminalApp;
  model: ModelId;
}

const DEFAULTS: UserSettings = { terminal: "ghostty", model: "" };
const MODEL_IDS = new Set<string>(MODEL_OPTIONS.map((m) => m.id));

const file = () => join(config.dataDir, "settings.json");

function readRaw(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(file(), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// 与壳共用 <dataDir>/settings.json；壳只读 hotkey，core 只读这里列出的字段，写回时保留其他键。
export function userSettings(): UserSettings {
  const raw = readRaw();
  return {
    terminal: raw.terminal === "terminal" ? "terminal" : DEFAULTS.terminal,
    model: typeof raw.model === "string" && MODEL_IDS.has(raw.model) ? (raw.model as ModelId) : DEFAULTS.model,
  };
}

export function updateSettings(patch: SettingsUpdate): UserSettings {
  const raw = readRaw();
  if (patch.terminal !== undefined) raw.terminal = patch.terminal;
  if (patch.model !== undefined) raw.model = patch.model;
  writeFileSync(`${file()}.tmp`, JSON.stringify(raw, null, 2));
  renameSync(`${file()}.tmp`, file());
  return userSettings();
}
