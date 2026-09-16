import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";

/**
 * 项目手册：从 Claude Code 历史里提炼出来的「在这个项目里怎么干活」。
 * 跟 playbooks/ 分开——那边是 Slack 回复类别（ReplyCategory），语义不同，类型也不该被撑开。
 */
export const HANDBOOK_DIR = "handbooks";

/** 跨项目的通用习惯放这一份，跟具体项目的手册分开。 */
export const GLOBAL = "_global";

export const handbookDir = (): string => join(config.dataDir, HANDBOOK_DIR);

/** 项目名直接当文件名，但得挡住路径穿越和分隔符。 */
export function handbookSlug(project: string): string {
  return project.replace(/[/\\]/g, "-").replace(/^\.+/, "").trim() || "_unknown";
}

export const handbookPath = (project: string): string => join(handbookDir(), `${handbookSlug(project)}.md`);

export function readHandbook(project: string): string {
  try {
    return readFileSync(handbookPath(project), "utf8");
  } catch {
    return "";
  }
}

export function writeHandbook(project: string, content: string): void {
  mkdirSync(handbookDir(), { recursive: true });
  const path = handbookPath(project);
  writeFileSync(`${path}.tmp`, content);
  renameSync(`${path}.tmp`, path);
}

export function listHandbooks(): string[] {
  try {
    return readdirSync(handbookDir())
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -".md".length))
      .sort();
  } catch {
    return [];
  }
}

export function handbookExists(project: string): boolean {
  return existsSync(handbookPath(project));
}

/**
 * 派去终端干活的 Claude 要吃到的那段：这个项目的手册 + 通用习惯。
 * 提示词里塞太多会挤掉任务本身，各截 1500 字。
 */
export function handbookBlock(project: string, limit = 1500): string {
  const cut = (s: string) => (s.length > limit ? `${s.slice(0, limit)}\n…（略）` : s);
  const parts = [readHandbook(project), readHandbook(GLOBAL)].filter((s) => s.trim());
  return parts.length ? parts.map(cut).join("\n\n") : "";
}
