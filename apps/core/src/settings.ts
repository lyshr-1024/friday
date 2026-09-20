import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SUMMON_SETTINGS, MODEL_OPTIONS, THEME_OPTIONS, type ModelId, type SettingsUpdate, type SummonSettings, type ThemeId } from "@friday/shared";
import { config } from "./config.js";

export type TerminalApp = "ghostty" | "terminal";

export interface UserSettings {
  terminal: TerminalApp;
  model: ModelId;
  skills: boolean;
  name: string;
  theme: ThemeId;
  /** 每天复盘一次人工处理：看用户怎么处置草稿，重写经验手册 */
  /** 每周从 Claude Code 历史提炼项目手册 */
  learnHistory: boolean;
  summon: SummonSettings;
}

const DEFAULTS: UserSettings = { terminal: "ghostty", model: "", skills: true, name: "", theme: "graphite", learnHistory: true, summon: DEFAULT_SUMMON_SETTINGS };
const MODEL_IDS = new Set<string>(MODEL_OPTIONS.map((m) => m.id));
const THEME_IDS = new Set<string>(THEME_OPTIONS.map((t) => t.id));

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
    // 旧配置里可能还存着 "embedded"（已移除），落到默认的 ghostty
    terminal: raw.terminal === "terminal" || raw.terminal === "ghostty" ? raw.terminal : DEFAULTS.terminal,
    model: typeof raw.model === "string" && MODEL_IDS.has(raw.model) ? (raw.model as ModelId) : DEFAULTS.model,
    skills: typeof raw.skills === "boolean" ? raw.skills : DEFAULTS.skills,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : defaultName(),
    theme: typeof raw.theme === "string" && THEME_IDS.has(raw.theme) ? (raw.theme as ThemeId) : DEFAULTS.theme,
    learnHistory: typeof raw.learnHistory === "boolean" ? raw.learnHistory : DEFAULTS.learnHistory,
    summon: { ...DEFAULT_SUMMON_SETTINGS, ...(typeof raw.summon === "object" && raw.summon !== null ? (raw.summon as Partial<SummonSettings>) : {}) },
  };
}

export function updateSettings(patch: SettingsUpdate): UserSettings {
  const raw = readRaw();
  if (patch.terminal !== undefined) raw.terminal = patch.terminal;
  if (patch.model !== undefined) raw.model = patch.model;
  if (patch.skills !== undefined) raw.skills = patch.skills;
  if (patch.name !== undefined) raw.name = patch.name;
  if (patch.theme !== undefined) raw.theme = patch.theme;
  if (patch.learnHistory !== undefined) raw.learnHistory = patch.learnHistory;
  if (patch.summon !== undefined) raw.summon = { ...DEFAULT_SUMMON_SETTINGS, ...(typeof raw.summon === "object" && raw.summon !== null ? (raw.summon as Partial<SummonSettings>) : {}), ...patch.summon };
  writeFileSync(`${file()}.tmp`, JSON.stringify(raw, null, 2));
  renameSync(`${file()}.tmp`, file());
  return userSettings();
}

import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";

let cachedName: string | undefined;
/** 没配名字时用 macOS 账户的全名（id -F），再退到登录名。 */
function defaultName(): string {
  if (cachedName !== undefined) return cachedName;
  try {
    cachedName = execFileSync("/usr/bin/id", ["-F"], { encoding: "utf8" }).trim() || userInfo().username;
  } catch {
    cachedName = userInfo().username;
  }
  return cachedName;
}
