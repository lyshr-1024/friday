import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const NAMES: Record<string, string> = { chinese: "中文", zh: "中文", "zh-cn": "中文", english: "English", en: "English", japanese: "日本語", ja: "日本語" };

/** 你在 Claude Code 里设的回复语言（~/.claude/settings.json 的 language）。每次现读：你改了设置，下一个终端就跟上 */
export function userLanguage(file = process.env.FRIDAY_CLAUDE_SETTINGS || join(homedir(), ".claude", "settings.json")): string | undefined {
  try {
    const raw = (JSON.parse(readFileSync(file, "utf8")) as { language?: unknown }).language;
    if (typeof raw !== "string" || !raw.trim()) return undefined;
    return NAMES[raw.trim().toLowerCase()] ?? raw.trim();
  } catch {
    return undefined;
  }
}

/** 跟用户说话用哪种语言。模型调完工具之后最容易回落到英文，所以这句要在那个时刻再说一遍 */
export function replyLanguageLine(): string {
  const lang = userLanguage();
  return lang ? `跟用户说话一律用${lang}（代码、命令、标识符保持原文）` : "回复跟随用户说话用的语言（代码、命令、标识符保持原文）";
}
