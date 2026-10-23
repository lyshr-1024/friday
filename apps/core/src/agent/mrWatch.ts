import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Task } from "@friday/shared";
import { record } from "../memory/audit.js";
import { listTasks } from "../memory/tasks.js";
import { finishDefectsOf, finishTask } from "./pipeline.js";

const execFileP = promisify(execFile);

export interface MergedMr {
  iid: number;
  target: string;
  mergedAt: string;
}

/** 这个仓库里以 branch 为源分支、已合并的 MR；查不了（glab 没装、没登录、网络）返回 undefined */
export type MrLookup = (repoDir: string, branch: string) => Promise<MergedMr[] | undefined>;

const GLAB_FALLBACKS = ["/opt/homebrew/bin/glab", "/usr/local/bin/glab"];

function glabPath(): string | undefined {
  const fromPath = (process.env.PATH ?? "").split(":").filter(Boolean).map((d) => join(d, "glab"));
  return [...fromPath, ...GLAB_FALLBACKS].find((p) => {
    try {
      accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

export const glabMerged: MrLookup = async (repoDir, branch) => {
  const bin = glabPath();
  if (!bin) return undefined;
  try {
    const { stdout } = await execFileP(bin, ["mr", "list", "--source-branch", branch, "--merged", "-F", "json"], { cwd: repoDir, timeout: 20_000 });
    const rows = JSON.parse(stdout) as Array<{ iid: number; target_branch: string; merged_at?: string | null }>;
    return rows.filter((m) => m.merged_at).map((m) => ({ iid: m.iid, target: m.target_branch, mergedAt: m.merged_at! }));
  } catch (e) {
    console.warn(`[mr] 查 ${branch} 的 MR 失败：${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
};

/** 有自己分支的任务；交代进需求会话的缺陷借的是需求的分支，跟着需求收 */
function candidates(): Task[] {
  return listTasks(["processing", "review", "blocked"], 500).filter(
    (t) => t.kind !== "project" && t.source.branch && t.source.repoDir && !t.source.handedAt && t.source.branch !== "main" && t.source.branch !== "master",
  );
}

/** 你在 GitLab 上合了 MR，Friday 看不到就一直挂在待验收：每轮同步后用 glab 查一遍，合了就收工 */
export async function mrWatchTick(lookup: MrLookup = glabMerged): Promise<number> {
  let closed = 0;
  for (const t of candidates()) {
    // 同名分支以前合过的旧 MR 不算
    const hit = (await lookup(t.source.repoDir!, t.source.branch!))?.filter((m) => m.mergedAt >= t.createdAt).sort((a, b) => b.mergedAt.localeCompare(a.mergedAt))[0];
    if (!hit) continue;
    const why = `MR !${hit.iid} 已合并进 ${hit.target}`;
    record({
      taskId: t.id,
      action: "mr_merged",
      why: "GitLab 上这条分支的 MR 合并了",
      how: `${why}，任务标完成，名下缺陷一起收`,
      evidence: { iid: hit.iid, target: hit.target, branch: t.source.branch, mergedAt: hit.mergedAt },
      risk: "reversible",
    });
    await finishDefectsOf(t, "done", `所属任务的${why}，名下缺陷一起收`);
    await finishTask(t.id, "done", why);
    closed++;
  }
  return closed;
}
