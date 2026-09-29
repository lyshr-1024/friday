import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "./index.js";
import { createTask } from "../memory/tasks.js";

function repoWithWorktree() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "wt-repo-")));
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  const tree = join(realpathSync(mkdtempSync(join(tmpdir(), "wt-tree-"))), "feat-x");
  git("worktree", "add", "-q", "-b", "feat/x", tree);
  return { repo, tree };
}

const post = (body: unknown) => app.request("/worktrees/remove", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("遗留 worktree", () => {
  it("已完成任务的 worktree 还在磁盘上就列出来", async () => {
    const { repo, tree } = repoWithWorktree();
    const t = createTask({ title: "遗留", kind: "verbal", source: { worktree: tree, repoDir: repo }, status: "done" });
    const list = (await (await app.request("/worktrees/leftover")).json()) as Array<{ path: string; repoDir: string; taskId?: string }>;
    expect(list.find((w) => w.path === tree)).toMatchObject({ repoDir: repo, taskId: t.id });
  });

  it("不在遗留列表里的路径一律拒绝，不删", async () => {
    const { repo, tree } = repoWithWorktree();
    const res = await post({ path: tree, repoDir: repo });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("不在遗留");
    expect(existsSync(tree)).toBe(true);
  });

  it("列表里的路径按记录里的 repoDir 删，请求里的 repoDir 不作数", async () => {
    const { repo, tree } = repoWithWorktree();
    createTask({ title: "遗留2", kind: "verbal", source: { worktree: tree, repoDir: repo }, status: "done" });
    const res = await post({ path: tree, repoDir: "/nonexistent" });
    expect(res.status).toBe(200);
    expect(existsSync(tree)).toBe(false);
  });
});
