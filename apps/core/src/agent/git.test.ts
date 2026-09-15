import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitInspect, worktreeDirt } from "./git.js";

function sh(dir: string, ...args: string[]) {
  return execFileSync("git", ["-C", dir, ...args], { stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString();
}

describe("git_inspect", () => {
  const dir = mkdtempSync(join(tmpdir(), "friday-git-"));
  sh(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "a");
  sh(dir, "add", "."); sh(dir, "commit", "-qm", "init");
  sh(dir, "branch", "feat/merged"); sh(dir, "checkout", "-qb", "feat/open");
  writeFileSync(join(dir, "b.txt"), "b"); sh(dir, "add", "."); sh(dir, "commit", "-qm", "open work");
  sh(dir, "checkout", "-q", "main");
  const wt = mkdtempSync(join(tmpdir(), "friday-wt-"));
  sh(dir, "worktree", "add", "-q", join(wt, "open"), "feat/open");
  writeFileSync(join(dir, "c.txt"), "dirty");

  it("status 显示分支与未提交改动", async () => {
    const out = await gitInspect(dir, "status");
    expect(out).toContain("分支：main");
    expect(out).toContain("?? c.txt");
  });

  it("worktrees 标出已合并 / 未合并", async () => {
    const out = await gitInspect(dir, "worktrees");
    expect(out).toContain("基准：main");
    expect(out).toMatch(/feat\/open · 未合并/);
    expect(out).toMatch(/main · 主分支/);
  });

  it("branches 区分未合并与已合并", async () => {
    const out = await gitInspect(dir, "branches");
    expect(out).toMatch(/未合并：\n\s*feat\/open/);
    expect(out).toMatch(/已合并：[\s\S]*feat\/merged/);
  });
});

describe("开工前的工作区检查", () => {
  const clean = mkdtempSync(join(tmpdir(), "friday-clean-"));
  sh(clean, "init", "-q", "-b", "main");
  writeFileSync(join(clean, "a.txt"), "a");
  sh(clean, "add", "."); sh(clean, "commit", "-qm", "init");

  it("干净仓库放行", async () => {
    expect(await worktreeDirt(clean)).toBeUndefined();
  });

  it("有未提交改动时说明拦在哪", async () => {
    writeFileSync(join(clean, "a.txt"), "changed");
    const dirt = await worktreeDirt(clean);
    expect(dirt).toContain("a.txt");
  });

  it("不是 git 仓库也拦下", async () => {
    expect(await worktreeDirt(mkdtempSync(join(tmpdir(), "friday-nogit-")))).toBeTruthy();
  });
});
