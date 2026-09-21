import { listTasks } from "../memory/tasks.js";
import { isPushed } from "./git.js";
import { onSignal } from "./stage.js";

/**
 * 扫一遍在写代码的任务，看分支推上远端没。
 * 推了是弱信号（可能只是备份），所以 onSignal 会先在卡片上问一句而不是直接推进。
 * 真正的 MR 状态得调 GitLab/GitHub API，那是另一条集成，这版不做。
 */
export async function watchStageSignals(): Promise<number> {
  const tasks = listTasks().filter((t) => t.stage === "dev" && t.source.branch && !t.stageHint);
  let n = 0;
  for (const t of tasks) {
    const dir = t.source.repoDir ?? t.source.worktree;
    if (!dir) continue;
    if (!(await isPushed(dir, t.source.branch!).catch(() => false))) continue;
    const r = onSignal(t.id, {
      signal: "branch_pushed",
      to: "testing",
      ask: `分支 ${t.source.branch} 推上去了，是提测了吗？`,
      why: `分支 ${t.source.branch} 已推到远端`,
    });
    if (r.kind !== "skipped") n += 1;
  }
  return n;
}
