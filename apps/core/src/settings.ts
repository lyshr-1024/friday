import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SKILL_LIST, DEFAULT_SUMMON_SETTINGS, MODEL_OPTIONS, THEME_OPTIONS, type ModelId, type SettingsUpdate, type SummonSettings, type ThemeId } from "@friday/shared";
import { config } from "./config.js";

export type TerminalApp = "ghostty" | "terminal";

export interface UserSettings {
  terminal: TerminalApp;
  model: ModelId;
  skills: boolean;
  /** Skill 模式放行哪些 skill；"all" 全放，会把每个 skill 的描述都塞进上下文 */
  skillList: string[] | "all";
  name: string;
  theme: ThemeId;
  /** 背景图的本地绝对路径，空串 = 不用 */
  background: string;
  /** 盖在图上那层底色的不透明度 0-100 */
  backgroundOpacity: number;
  /** 每周从 Claude Code 历史提炼项目手册 */
  learnHistory: boolean;
  /** 分派给我的 Meegle 缺陷拉不拉进待办。关掉只停拉新的，已经在列表里的留着 */
  meegleDefects: boolean;
  summon: SummonSettings;
}

/**
 * 白名单是并集不是覆盖：存过一次之后，代码里新加的默认域名就再也进不来了
 * （larksuite 就是这么漏掉的，工单页的 URL 被裁成光域名，动作全没了）。
 */
function mergeSummon(raw: unknown): SummonSettings {
  const saved = typeof raw === "object" && raw !== null ? (raw as Partial<SummonSettings>) : {};
  return {
    ...DEFAULT_SUMMON_SETTINGS,
    ...saved,
    urlAllowlist: [...new Set([...DEFAULT_SUMMON_SETTINGS.urlAllowlist, ...(saved.urlAllowlist ?? [])])],
  };
}

const DEFAULTS: UserSettings = { terminal: "ghostty", model: "", skills: true, skillList: [...DEFAULT_SKILL_LIST], name: "", theme: "graphite", background: "", backgroundOpacity: 82, learnHistory: true, meegleDefects: true, summon: DEFAULT_SUMMON_SETTINGS };

/** 存的是 "all" 就全放，存了数组就按数组（空数组当没配，回默认），没存过用默认清单 */
function readSkillList(raw: unknown): string[] | "all" {
  if (raw === "all") return "all";
  if (Array.isArray(raw)) {
    const names = raw.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim());
    if (names.length) return names;
  }
  return [...DEFAULT_SKILL_LIST];
}
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
    skillList: readSkillList(raw.skillList),
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : defaultName(),
    theme: typeof raw.theme === "string" && THEME_IDS.has(raw.theme) ? (raw.theme as ThemeId) : DEFAULTS.theme,
    background: typeof raw.background === "string" ? raw.background.trim() : DEFAULTS.background,
    backgroundOpacity: typeof raw.backgroundOpacity === "number" && Number.isFinite(raw.backgroundOpacity)
      ? Math.min(100, Math.max(0, Math.round(raw.backgroundOpacity)))
      : DEFAULTS.backgroundOpacity,
    learnHistory: typeof raw.learnHistory === "boolean" ? raw.learnHistory : DEFAULTS.learnHistory,
    meegleDefects: typeof raw.meegleDefects === "boolean" ? raw.meegleDefects : DEFAULTS.meegleDefects,
    summon: mergeSummon(raw.summon),
  };
}

export function updateSettings(patch: SettingsUpdate): UserSettings {
  const raw = readRaw();
  if (patch.terminal !== undefined) raw.terminal = patch.terminal;
  if (patch.model !== undefined) raw.model = patch.model;
  if (patch.skills !== undefined) raw.skills = patch.skills;
  if (patch.skillList !== undefined) raw.skillList = patch.skillList;
  if (patch.name !== undefined) raw.name = patch.name;
  if (patch.theme !== undefined) raw.theme = patch.theme;
  if (patch.background !== undefined) raw.background = patch.background;
  if (patch.backgroundOpacity !== undefined) raw.backgroundOpacity = patch.backgroundOpacity;
  if (patch.learnHistory !== undefined) raw.learnHistory = patch.learnHistory;
  if (patch.meegleDefects !== undefined) raw.meegleDefects = patch.meegleDefects;
  if (patch.summon !== undefined) raw.summon = { ...mergeSummon(raw.summon), ...patch.summon };
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
