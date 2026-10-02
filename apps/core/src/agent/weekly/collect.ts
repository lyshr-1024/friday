import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { mapLimit } from "../../connectors/exec.js";
import type { Task } from "@friday/shared";
import { listTasks } from "../../memory/tasks.js";
import type { Week } from "./week.js";

export interface Material { id: string; text: string }

const AUTHOR = "haoran\\.jing@longbridge\\(\\.sg\\|-inc\\.com\\)";
const MAX_GIT = 300;
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;
const execFileP = promisify(execFile);

function repos(root: string): string[] {
  const out: string[] = [];
  const dirs = (p: string) => (existsSync(p) ? readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => join(p, e.name)) : []);
  for (const a of dirs(root)) {
    if (existsSync(join(a, ".git"))) out.push(a);
    else for (const b of dirs(a)) if (existsSync(join(b, ".git"))) out.push(b);
  }
  return out;
}

export async function collectGit(roots: string[], week: Week): Promise<Material[]> {
  const logs = await mapLimit(roots.flatMap(repos), 4, async (dir) => {
    try {
      // 不用 --since/--until：rebase/cherry-pick 会让某个祖先的日期比子孙新，git 一遇到超范围的
      // 提交就提前停止遍历，把范围内更早遍历到的提交也一并漏掉。改成不限日期取全量后自己过滤。
      const { stdout } = await execFileP("git", ["-C", dir, "log", "--exclude=refs/stash", "--all", `--author=${AUTHOR}`, "--pretty=format:%H|%aI|%s"], { encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER });
      return { dir, log: stdout };
    } catch (e) {
      console.error(`[okr] 跳过 ${dir}：${(e as { message: string }).message}`);
      return { dir, log: "" };
    }
  });
  const seen = new Set<string>();
  const hits: Array<{ at: number; name: string; text: string }> = [];
  for (const { dir, log } of logs) {
    const name = dir.split("/").pop()!;
    for (const l of log.split("\n").filter(Boolean)) {
      const [hash, iso, ...subject] = l.split("|");
      if (seen.has(hash!)) continue;
      const when = new Date(iso!);
      if (when < week.start || when >= week.end) continue;
      seen.add(hash!);
      hits.push({ at: when.getTime(), name, text: `[${name}] ${iso!.slice(0, 10)} ${subject.join("|")}` });
    }
  }
  hits.sort((x, y) => y.at - x.at || x.name.localeCompare(y.name));
  return hits.slice(0, MAX_GIT).map((h, i) => ({ id: `g${i + 1}`, text: h.text }));
}

// Meegle 同步每 15 分钟把所有开着的工单 updatedAt 刷一遍，光看时间会把排队没动的待办当成本周的工作
const untouched = (t: Task) => (t.status === "collected" || t.status === "understood") && (!t.stage || t.stage === "todo");

export function collectTasks(week: Week): Material[] {
  const from = week.start.toISOString();
  const to = week.end.toISOString();
  return listTasks(["collected", "understood", "processing", "review", "blocked", "done"], 1000)
    .filter((t) => t.updatedAt >= from && t.updatedAt < to && t.kind !== "okr_weekly" && t.kind !== "handbook" && t.kind !== "project" && !untouched(t))
    .map((t, i) => ({
      id: `t${i + 1}`,
      text: [t.title, t.source.meegleId ? `m-${t.source.meegleId}` : "", t.project ? `项目 ${t.project}` : "", t.stage ? `阶段 ${t.stage}` : "", `状态 ${t.status}`, t.report?.summary ? `交付：${t.report.summary.slice(0, 200)}` : ""].filter(Boolean).join(" · "),
    }));
}

export async function collectMaterials(week: Week, roots = [join(homedir(), "workspace")]): Promise<Material[]> {
  return [...(await collectGit(roots, week)), ...collectTasks(week)];
}
