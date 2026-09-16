import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addWorktree, fridayWorktree, removeWorktree, worktreeDirt } from "./git.js";

const run = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });

let repo: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "friday-wt-"));
  run(repo, "init", "-q", "-b", "main");
  run(repo, "config", "user.email", "t@t");
  run(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "1\n");
  run(repo, "add", ".");
  run(repo, "commit", "-qm", "init");
});

afterAll(() => {
  execFileSync("rm", ["-rf", repo]);
});

describe("worktreeDirt", () => {
  it("主仓脏了也放行——Friday 在自己的 worktree 里干活，不碰主仓", async () => {
    writeFileSync(join(repo, "a.txt"), "改了但没提交\n");
    expect(await worktreeDirt(repo)).toBeUndefined();
    run(repo, "checkout", "--", "a.txt");
  });

  it("不是 git 仓库仍然拦下", async () => {
    expect(await worktreeDirt(tmpdir())).toContain("不是 git 仓库");
  });
});

describe("worktree 开与收", () => {
  it("开出来是 detached，分支由终端里的 Claude 自己建", async () => {
    const tree = fridayWorktree(repo, "abcdef1234");
    expect(tree).toContain("/.claude/worktrees/friday-abcdef12");
    expect(await addWorktree(repo, tree)).toBeUndefined();
    expect(existsSync(tree)).toBe(true);
    expect(run(tree, "branch", "--show-current").trim()).toBe("");
    await removeWorktree(repo, tree);
  });

  it("已合并的分支：目录和分支一起收掉", async () => {
    const tree = fridayWorktree(repo, "merged00000");
    await addWorktree(repo, tree);
    run(tree, "switch", "-qc", "feat/done");
    writeFileSync(join(tree, "b.txt"), "x\n");
    run(tree, "add", ".");
    run(tree, "commit", "-qm", "b");
    run(repo, "merge", "-q", "--no-ff", "feat/done", "-m", "merge");

    const r = await removeWorktree(repo, tree);
    expect(r).toMatchObject({ removed: true, branch: "feat/done", branchDeleted: true });
    expect(existsSync(tree)).toBe(false);
    expect(run(repo, "branch", "--format=%(refname:short)")).not.toContain("feat/done");
  });

  it("没合并的分支要留着——改动可能还想捡回来，那个决定归用户", async () => {
    const tree = fridayWorktree(repo, "unmerged000");
    await addWorktree(repo, tree);
    run(tree, "switch", "-qc", "feat/wip");
    writeFileSync(join(tree, "c.txt"), "x\n");
    run(tree, "add", ".");
    run(tree, "commit", "-qm", "c");

    const r = await removeWorktree(repo, tree);
    expect(r.removed).toBe(true);
    expect(r.branchDeleted).toBe(false);
    expect(r.kept).toContain("还没合并");
    expect(existsSync(tree)).toBe(false);
    expect(run(repo, "branch", "--format=%(refname:short)")).toContain("feat/wip");
  });

  it("未提交的改动不挡收 worktree（--force）", async () => {
    const tree = fridayWorktree(repo, "dirty000000");
    await addWorktree(repo, tree);
    writeFileSync(join(tree, "d.txt"), "没提交\n");
    expect((await removeWorktree(repo, tree)).removed).toBe(true);
  });

  it("收一个不存在的 worktree 不抛，只是没收成", async () => {
    const r = await removeWorktree(repo, join(repo, ".claude", "worktrees", "friday-nope"));
    expect(r.removed).toBe(false);
  });
});
