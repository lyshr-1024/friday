import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "../config.js";
import { GLOBAL } from "../memory/handbooks.js";
import { loadProjects, type Project } from "../memory/projects.js";

/** Claude Code 把每个工作目录的会话记在 ~/.claude/projects/<编码过的路径>/<sessionId>.jsonl 里 */
export const historyDir = (): string => join(homedir(), ".claude", "projects");

/** 冷启动扫多久。再往前的约定多半已经废弃，学进来反而是负担。 */
export const BOOTSTRAP_DAYS = 30;

/**
 * 预筛：用户在纠正、立规矩、定口径时几乎一定会出现的词。
 * 只用来把两千多条原话缩到几百条，判断「这算不算可复用的约定」交给模型——
 * 正则判不了「改成 No photo yet」是一次性文案还是长期口径。
 */
const CUE =
  /不对|不要|不能|别再|应该|改成|改为|统一|以后|必须|注意|错了|漏了|记一下|记录一下|规范|约定|默认|优先|禁止|一律|全部用|为什么/;

const MIN_LEN = 12;
const MAX_LEN = 1200;

export interface HistoryMessage {
  at: string;
  cwd: string;
  project?: string;
  text: string;
  session: string;
}

/** 一行 jsonl 里能用的用户原话。拿不到就返回空串。 */
export function userText(row: Record<string, unknown>): string {
  if (row.type !== "user" || row.isMeta === true || row.isSidechain === true) return "";
  const message = row.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: string; text: string } => typeof b === "object" && b !== null && (b as { type?: string }).type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/**
 * 不是用户说的话，或者说了也学不到东西的。
 * 尖括号开头的是各种系统注入（system-reminder、command-name、local-command-stdout），
 * 斜杠开头的是 slash 命令回显，中括号开头的是图片和中断占位。
 */
export function isNoise(text: string): boolean {
  if (text.length < MIN_LEN || text.length > MAX_LEN) return true;
  if (/^[<[/]/.test(text)) return true;
  if (text.startsWith("Caveat:")) return true;
  return /<(system-reminder|command-name|local-command-stdout|untrusted)/.test(text);
}

/** 值得送去提炼的：带纠正/约定信号的那些。 */
export function isCandidate(text: string): boolean {
  return !isNoise(text) && CUE.test(text);
}

/**
 * 这条消息属于哪个项目。用 jsonl 自带的 cwd 对 projects.md 的目录做前缀匹配——
 * 目录名反解不了（whale-console 和 fe-wealth-admin 里的连字符跟路径分隔符编码后长一样）。
 * 仓库内的 worktree 在项目目录底下，前缀匹配天然覆盖；多个项目嵌套时取最深的那个。
 *
 * 前缀不中再看路径段：orca 把 worktree 放在 ~/orca/workspaces/<仓库名>/<分支> 这种跟项目
 * 目录完全无关的地方，只能靠路径里那一段仓库名认回来。项目名够特异，不会误伤。
 */
export function projectForCwd(cwd: string, projects: Pick<Project, "name" | "dir">[]): string | undefined {
  const trim = (p: string) => p.replace(/\/+$/, "");
  const here = trim(cwd);
  let best: { name: string; depth: number } | undefined;
  for (const p of projects) {
    const dir = trim(p.dir);
    if (!dir) continue;
    if (here === dir || here.startsWith(`${dir}/`)) {
      if (!best || dir.length > best.depth) best = { name: p.name, depth: dir.length };
    }
  }
  if (best) return best.name;
  const segments = new Set(here.split("/").filter(Boolean));
  return projects.find((p) => segments.has(p.name) || segments.has(p.dir.slice(p.dir.lastIndexOf("/") + 1)))?.name;
}

/** 这条会话是不是 Friday 自己跟 Claude 的对话（cwd 就是记忆库目录）。 */
export function isOwnPrompt(cwd: string): boolean {
  const data = config.dataDir.replace(/\/+$/, "");
  const here = cwd.replace(/\/+$/, "");
  return Boolean(here) && (here === data || here.startsWith(`${data}/`));
}

function jsonlFiles(root: string, sinceMs: number): string[] {
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const d of dirs) {
    let names: string[];
    try {
      names = readdirSync(join(root, d));
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith(".jsonl")) continue;
      const file = join(root, d, n);
      try {
        if (statSync(file).mtimeMs >= sinceMs) out.push(file);
      } catch {
        /* 会话可能正在被写或已删，跳过 */
      }
    }
  }
  return out;
}

export function readSession(file: string, projects: Pick<Project, "name" | "dir">[], sinceIso?: string): HistoryMessage[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const session = file.slice(file.lastIndexOf("/") + 1, -".jsonl".length);
  const out: HistoryMessage[] = [];
  for (const line of raw.split("\n")) {
    if (!line || !line.includes('"user"')) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const text = userText(row);
    if (!text || !isCandidate(text)) continue;
    const at = typeof row.timestamp === "string" ? row.timestamp : "";
    if (!at || (sinceIso && at <= sinceIso)) continue;
    const cwd = typeof row.cwd === "string" ? row.cwd : "";
    // 记忆库目录下的会话是 Friday 自己调 Claude（情境卡、intake、提炼），那些"用户消息"是
    // Friday 自己写的提示词。学回来等于自己教自己，是回音室。
    if (isOwnPrompt(cwd)) continue;
    const project = cwd ? projectForCwd(cwd, projects) : undefined;
    out.push({ at, cwd, ...(project ? { project } : {}), text, session });
  }
  return out;
}

/**
 * 扫历史，取出带纠正/约定信号的用户原话。
 * sinceIso 是上次学到哪儿的水位；没有就按 BOOTSTRAP_DAYS 冷启动。
 */
export function scanHistory(sinceIso?: string, now = Date.now()): HistoryMessage[] {
  const projects = loadProjects();
  const floorMs = sinceIso ? Date.parse(sinceIso) : now - BOOTSTRAP_DAYS * 86_400_000;
  const files = jsonlFiles(historyDir(), floorMs);
  const all = files.flatMap((f) => readSession(f, projects, sinceIso));
  // 同一句话（"统一用 dayjs"）在多个会话里重复说过，只留最早那次，原话证据也更接近它第一次定下来的现场
  const seen = new Map<string, HistoryMessage>();
  for (const m of all.sort((a, b) => a.at.localeCompare(b.at))) {
    const key = `${m.project ?? ""}::${m.text}`;
    if (!seen.has(key)) seen.set(key, m);
  }
  return [...seen.values()];
}

/** 按项目分组送去提炼。认不出项目的归 GLOBAL——跨项目的工作习惯多半就长这样。 */
export { GLOBAL };

export function groupByProject(messages: HistoryMessage[]): Map<string, HistoryMessage[]> {
  const groups = new Map<string, HistoryMessage[]>();
  for (const m of messages) {
    const key = m.project ?? GLOBAL;
    const list = groups.get(key);
    if (list) list.push(m);
    else groups.set(key, [m]);
  }
  return groups;
}
