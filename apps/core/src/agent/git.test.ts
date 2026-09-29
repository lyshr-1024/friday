import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { diffStatSync, gitInspect, parseNumstat, worktreeDirt } from "./git.js";

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

  it("主仓有未提交改动也放行——Friday 在独立 worktree 里干活，碰不到主仓", async () => {
    writeFileSync(join(clean, "a.txt"), "changed");
    expect(await worktreeDirt(clean)).toBeUndefined();
  });

  it("不是 git 仓库也拦下", async () => {
    expect(await worktreeDirt(mkdtempSync(join(tmpdir(), "friday-nogit-")))).toBeTruthy();
  });
});

describe("逐文件增删（numstat）", () => {
  it("解析文本行和二进制行（- - 当 0，路径留着）", () => {
    expect(parseNumstat("54\t8\tsrc/pages/export/BatchExport.tsx\n-\t-\tdocs/shot.png\n5\t0\tsrc/hooks/useExportJob.test.ts\n")).toEqual([
      { path: "src/pages/export/BatchExport.tsx", insertions: 54, deletions: 8 },
      { path: "docs/shot.png", insertions: 0, deletions: 0 },
      { path: "src/hooks/useExportJob.test.ts", insertions: 5, deletions: 0 },
    ]);
  });

  it("空输出是空列表", () => {
    expect(parseNumstat("")).toEqual([]);
  });

  it("相对主干分叉点统计，并记下比的是哪个主干", () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-numstat-"));
    sh(dir, "init", "-q", "-b", "master");
    writeFileSync(join(dir, "a.txt"), "1\n2\n");
    sh(dir, "add", "."); sh(dir, "commit", "-qm", "init");
    sh(dir, "checkout", "-qb", "feat/x");
    writeFileSync(join(dir, "a.txt"), "1\n3\n4\n");
    writeFileSync(join(dir, "b.bin"), Buffer.from([0, 1, 2, 0, 255]));
    sh(dir, "add", "."); sh(dir, "commit", "-qm", "work");
    expect(diffStatSync(dir)).toEqual({
      filesChanged: 2,
      insertions: 2,
      deletions: 1,
      diffFiles: [{ path: "a.txt", insertions: 2, deletions: 1 }, { path: "b.bin", insertions: 0, deletions: 0 }],
      diffBase: "master",
    });
  });
});
