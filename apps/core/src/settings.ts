import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

export type TerminalApp = "ghostty" | "terminal";

export interface UserSettings {
  terminal: TerminalApp;
}

const DEFAULTS: UserSettings = { terminal: "ghostty" };

// 与壳共用 <dataDir>/settings.json；壳只读 hotkey，core 只读这里列出的字段。
export function userSettings(): UserSettings {
  try {
    const raw = JSON.parse(readFileSync(join(config.dataDir, "settings.json"), "utf8")) as Partial<UserSettings>;
    return { terminal: raw.terminal === "terminal" ? "terminal" : DEFAULTS.terminal };
  } catch {
    return DEFAULTS;
  }
}
