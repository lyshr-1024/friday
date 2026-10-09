import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { config } from "../config.js";

const dir = () => join(config.dataDir, "research");

/** 读一份研究笔记全文（记忆库相对路径）。历史任务卡展开笔记、会话 memory_read research:<文件名> 都走它。 */
export function readResearchNote(rel: string): string {
  try {
    return readFileSync(join(config.dataDir, rel), "utf8");
  } catch {
    return "";
  }
}

export function listResearchNotes(): string[] {
  if (!existsSync(dir())) return [];
  return readdirSync(dir()).filter((f) => f.endsWith(".md")).sort().reverse();
}

/** 按文件名读，只认 research/ 下的 .md，挡掉 ../ 之类的路径 */
export function readResearchByName(name: string): string {
  const file = basename(name.endsWith(".md") ? name : `${name}.md`);
  return readResearchNote(join("research", file));
}

const slug = (title: string) =>
  title.replace(/[\\/:*?"<>|#\s]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "笔记";

/** 存一份笔记到 research/<上海日期>-<标题>.md，重名加序号。返回记忆库相对路径 */
export function saveResearchNote(title: string, body: string, url?: string, now = new Date()): string {
  const day = now.toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
  mkdirSync(dir(), { recursive: true });
  const base = `${day}-${slug(title)}`;
  let file = `${base}.md`;
  for (let i = 2; existsSync(join(dir(), file)); i++) file = `${base}-${i}.md`;
  const head = [`# ${title}`, "", ...(url ? [`- 来源：${url}`] : []), `- 存于：${day}`, ""];
  writeFileSync(join(dir(), file), `${head.join("\n")}\n${body.trim()}\n`);
  return join("research", file);
}

export function deleteResearchNote(rel: string): boolean {
  const path = join(dir(), basename(rel));
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}
