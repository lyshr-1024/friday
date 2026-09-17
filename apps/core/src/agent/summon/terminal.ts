import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import type { Snapshot, Task } from "@friday/shared";
import { latestShellActivity } from "../../memory/activity.js";
import type { Project } from "../../memory/projects.js";
import { listTasks } from "../../memory/tasks.js";
import { projectByCwd } from "./match.js";

const GIT_TIMEOUT_MS = 1500;

/**
 * 从终端窗口标题里尽力解析出目录名。常见格式：
 * - Ghostty 跑 Claude Code 时标题被设成任务描述，解析不出目录，返回 undefined
 * - iTerm2 / Terminal 常见 "user@host: /path" 或就是 "目录名"
 * - "目录名 — 命令" 这种 zsh 默认标题
 * 解析不出就返回 undefined，调用方另想办法（活动上报表）。
 */
export function parseTerminalTitle(title: string): string | undefined {
  const t = title.trim();
  if (!t) return undefined;
  const afterColon = /:\s*(\S+)\s*$/.exec(t);
  if (afterColon) return afterColon[1];
  // 分隔符前后都要有空格才算——目录名自己带横线（whale-console）不能被当成分隔符切断
  const beforeDash = /^(\S+)\s+[—-]\s+\S/.exec(t);
  if (beforeDash) return beforeDash[1];
  if (!/[\s。！？，,.!?]/.test(t) && t.length < 80) return t;
  return undefined;
}

/** 标题里往往只有目录的最后一段（"whale-console"），不是完整路径，按最后一段匹配项目名/别名。 */
export function projectByDirName(name: string, projects: Project[]): Project | undefined {
  const lower = name.toLowerCase();
  return projects.find((p) => basename(p.dir).toLowerCase() === lower || p.name.toLowerCase() === lower || p.aliases.some((a) => a.toLowerCase() === lower));
}

function gitStatusShort(dir: string): string[] {
  try {
    const out = execFileSync("git", ["-C", dir, "status", "--short"], { encoding: "utf8", timeout: GIT_TIMEOUT_MS });
    return out.trim() ? out.trim().split("\n").slice(0, 10) : [];
  } catch {
    return [];
  }
}

function recentCommitTitles(dir: string, limit = 3): string[] {
  try {
    const out = execFileSync("git", ["-C", dir, "log", `-n`, String(limit), "--format=%s"], { encoding: "utf8", timeout: GIT_TIMEOUT_MS });
    return out.trim() ? out.trim().split("\n") : [];
  } catch {
    return [];
  }
}

function branchOf(dir: string): string {
  try {
    return execFileSync("git", ["-C", dir, "branch", "--show-current"], { encoding: "utf8", timeout: GIT_TIMEOUT_MS }).trim();
  } catch {
    return "";
  }
}

function openTasksFor(project: string): Task[] {
  return listTasks(["collected", "understood", "processing", "review", "blocked"], 300).filter((t) => t.project === project);
}

/**
 * 终端场景的一段上下文文本：项目、分支、未提交改动、最近提交、这个项目未完成的任务。
 * 同步执行且有超时——挡在用户按热键和 HUD 出现之间，不能卡住。
 * 解析不出目录或匹配不到项目就返回 undefined。
 */
export function terminalContext(snapshot: Snapshot, projects: Project[]): string | undefined {
  // 活动上报表（shell hook）比窗口标题解析准，最近一条命令的 cwd 直接拿来匹配项目；
  // 没装 hook 或最近没跑命令时退回标题解析（Claude Code 之类会把标题改成任务描述，解析不出就算了）
  const reported = latestShellActivity();
  const titleDir = parseTerminalTitle(snapshot.app.title);
  const project = (reported ? projectByCwd(reported.cwd, projects) : undefined) ?? (titleDir ? projectByDirName(titleDir, projects) : undefined);
  if (!project) return undefined;

  const lines = [`终端：${snapshot.app.name}，目录 ${project.dir}（项目 ${project.name}）`];
  const branch = reported?.branch || branchOf(project.dir);
  const dirty = gitStatusShort(project.dir);
  if (branch) lines.push(`分支 ${branch}${dirty.length ? `，${dirty.length} 个文件未提交` : ""}`);
  const commits = recentCommitTitles(project.dir);
  if (commits.length) lines.push(`最近提交：${commits.join(" / ")}`);
  const tasks = openTasksFor(project.name);
  if (tasks.length) lines.push(`这个项目未完成的任务：${tasks.map((t) => `${t.title}（${t.status}）`).join("、")}`);
  return lines.join("\n");
}
