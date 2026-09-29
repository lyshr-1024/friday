import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { listTasks } from "../memory/tasks.js";
import { loadProjects } from "../memory/projects.js";
import { record } from "../memory/audit.js";
import { currentBranchSync, removeWorktree, worktreeDirtySync } from "../agent/git.js";

export interface Leftover { path: string; repoDir: string; branch?: string; dirty: boolean; taskId?: string; title?: string }

export function leftoverWorktrees(): Leftover[] {
  const out = new Map<string, Leftover>();
  for (const t of [...listTasks("done", 2000), ...listTasks("ignored", 2000)]) {
    const p = t.source.worktree;
    const repo = t.source.repoDir;
    if (!p || !repo || !existsSync(p)) continue;
    out.set(p, { path: p, repoDir: repo, ...(currentBranchSync(p) ? { branch: currentBranchSync(p) } : {}), dirty: worktreeDirtySync(p), taskId: t.id, title: t.title });
  }
  for (const proj of loadProjects()) {
    const dir = join(proj.dir, ".claude", "worktrees");
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((n) => n.startsWith("friday-"))) {
      const p = join(dir, name);
      if (!out.has(p)) out.set(p, { path: p, repoDir: proj.dir, ...(currentBranchSync(p) ? { branch: currentBranchSync(p) } : {}), dirty: worktreeDirtySync(p) });
    }
  }
  return [...out.values()];
}

export const worktrees = new Hono()
  .get("/worktrees/leftover", (c) => c.json(leftoverWorktrees()))
  .post("/worktrees/remove", async (c) => {
    const parsed = z.object({ path: z.string().min(1), force: z.boolean().optional() }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "path 必填" }, 400);
    const entry = leftoverWorktrees().find((w) => w.path === parsed.data.path);
    if (!entry) return c.json({ error: "这个路径不在遗留 worktree 列表里，不删" }, 400);
    const r = await removeWorktree(entry.repoDir, entry.path, parsed.data.force);
    record({ action: r.removed ? "worktree_removed" : "worktree_kept", why: parsed.data.force ? "你在设置页手动删遗留的 worktree，连没提交的改动一起丢" : "你在设置页手动删遗留的 worktree", how: r.removed ? `删了 ${entry.path}${r.branchDeleted ? `，分支 ${r.branch} 也删了` : r.branch ? `，分支 ${r.branch} 没合并留着` : ""}` : `没删：${r.kept ?? "未知原因"}`, evidence: { path: entry.path, repoDir: entry.repoDir, branch: r.branch ?? null }, risk: parsed.data.force ? "irreversible" : "reversible" });
    return c.json(r);
  });
