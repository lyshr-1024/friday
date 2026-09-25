import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { listTasks } from "../../memory/tasks.js";
import type { Week } from "./week.js";

export interface Material { id: string; text: string }

const AUTHOR = "haoran\\.jing@longbridge\\(\\.sg\\|-inc\\.com\\)";
const MAX_GIT = 300;

function repos(root: string): string[] {
  const out: string[] = [];
  const dirs = (p: string) => (existsSync(p) ? readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => join(p, e.name)) : []);
  for (const a of dirs(root)) {
    if (existsSync(join(a, ".git"))) out.push(a);
    else for (const b of dirs(a)) if (existsSync(join(b, ".git"))) out.push(b);
  }
  return out;
}

export function collectGit(roots: string[], week: Week): Material[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const dir of roots.flatMap(repos)) {
    let log = "";
    try {
      // 不用 --since/--until：rebase/cherry-pick 会让某个祖先的日期比子孙新，git 一遇到超范围的
      // 提交就提前停止遍历，把范围内更早遍历到的提交也一并漏掉。改成不限日期取全量后自己过滤。
      log = execFileSync("git", ["-C", dir, "log", "--all", `--author=${AUTHOR}`, "--pretty=format:%H|%aI|%s"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      continue;
    }
    const name = dir.split("/").pop()!;
    for (const l of log.split("\n").filter(Boolean)) {
      const [hash, iso, ...subject] = l.split("|");
      if (seen.has(hash!)) continue;
      const when = new Date(iso!);
      if (when < week.start || when >= week.end) continue;
      seen.add(hash!);
      lines.push(`[${name}] ${iso!.slice(0, 10)} ${subject.join("|")}`);
    }
  }
  return lines.slice(0, MAX_GIT).map((text, i) => ({ id: `g${i + 1}`, text }));
}

export function collectTasks(week: Week): Material[] {
  const from = week.start.toISOString();
  const to = week.end.toISOString();
  return listTasks(["collected", "understood", "processing", "review", "blocked", "done"], 1000)
    .filter((t) => t.updatedAt >= from && t.updatedAt < to && t.kind !== "okr_weekly" && t.kind !== "handbook")
    .map((t, i) => ({
      id: `t${i + 1}`,
      text: [t.title, t.source.meegleId ? `m-${t.source.meegleId}` : "", t.project ? `项目 ${t.project}` : "", t.stage ? `阶段 ${t.stage}` : "", `状态 ${t.status}`, t.report?.summary ? `交付：${t.report.summary.slice(0, 200)}` : ""].filter(Boolean).join(" · "),
    }));
}

export function collectMaterials(week: Week, roots = [join(homedir(), "workspace")]): Material[] {
  return [...collectGit(roots, week), ...collectTasks(week)];
}
