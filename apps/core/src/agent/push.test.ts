import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { app } from "../api/index.js";
import { listAudit } from "../memory/audit.js";
import { createJob } from "../memory/jobs.js";
import { createTask } from "../memory/tasks.js";
import { pushDir, pushVerdict } from "./guard.js";
import { buildGuardScript } from "./runner.js";

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };

function repoOnBranch(branch: string): string {
  const repo = mkdtempSync(join(tmpdir(), "friday-push-"));
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "pipe", env });
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  git("switch", "-q", "-c", branch);
  return repo;
}

function runGuard(script: string, command: string): Promise<string> {
  const path = join(mkdtempSync(join(tmpdir(), "friday-guard-")), "guard.sh");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  // 不能用 spawnSync：脚本要回报给同进程里起的测试服务，同步等会把服务堵死
  return new Promise((resolve) => {
    const child = spawn(path);
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", () => resolve(out));
    child.stdin.end(JSON.stringify({ tool_input: { command }, cwd: "/tmp/wt" }));
  });
}

const git = (current: string, main?: string) => ({ currentBranch: () => current, defaultBranch: () => main });
const verdict = (cmd: string, current = "fix/a", main?: string) => pushVerdict(cmd, "/repo", git(current, main));

describe("pushVerdict：推功能分支放行，危险的拦", () => {
  it("推当前功能分支、显式写功能分支都放行", () => {
    expect(verdict("git push -u origin fix/a")).toMatchObject({ allow: true, branches: ["fix/a"] });
    expect(verdict("git push")).toMatchObject({ allow: true, branches: ["fix/a"] });
    expect(verdict("git push -u origin HEAD")).toMatchObject({ allow: true, branches: ["fix/a"] });
    expect(verdict("pnpm test && git push origin HEAD:refs/heads/feat/x")).toMatchObject({ allow: true, branches: ["feat/x"] });
    expect(verdict("git push -o merge_request.create origin fix/a")).toMatchObject({ allow: true });
  });

  it("强推、删远端、推 tag、推全部都拦", () => {
    for (const cmd of ["git push -f", "git push --force origin fix/a", "git push --force-with-lease", "git push -uf origin fix/a", "git push origin +fix/a"]) expect(verdict(cmd), cmd).toMatchObject({ allow: false, why: "不许强推" });
    for (const cmd of ["git push origin --delete fix/a", "git push origin :fix/a", "git push -d origin fix/a"]) expect(verdict(cmd), cmd).toMatchObject({ allow: false, why: "不许删远端分支" });
    expect(verdict("git push --tags")).toMatchObject({ allow: false });
    expect(verdict("git push origin refs/tags/v1")).toMatchObject({ allow: false });
    expect(verdict("git push --all")).toMatchObject({ allow: false });
  });

  it("推主干、环境分支、仓库默认分支都拦；当前就在主干上推也拦", () => {
    for (const b of ["main", "master", "sit", "release", "release/saas"]) expect(verdict(`git push origin ${b}`), b).toMatchObject({ allow: false });
    expect(verdict("git push origin HEAD:main")).toMatchObject({ allow: false });
    expect(verdict("git push", "master")).toMatchObject({ allow: false });
    expect(verdict("git push origin trunk", "fix/a", "trunk")).toMatchObject({ allow: false });
    expect(verdict("git push", "")).toMatchObject({ allow: false });
  });

  it("一条命令里推好几次不放", () => {
    expect(verdict("git push origin fix/a && git push origin fix/b")).toMatchObject({ allow: false });
  });
});

describe("pushDir", () => {
  it("git -C、cd &&、~ 和引号都认；没写目录用 cwd", () => {
    expect(pushDir("git -C /a/b push -u origin x")).toBe("/a/b");
    expect(pushDir("cd ~/workspace/fe && git push -u origin x")).toBe(`${homedir()}/workspace/fe`);
    expect(pushDir("cd '/a b/c' && git status && git push")).toBe("/a b/c");
    expect(pushDir("cd sub && git push", "/repo")).toBe("/repo/sub");
    expect(pushDir("git push -u origin x", "/repo")).toBe("/repo");
  });
});

describe("守卫脚本问 core 放不放", () => {
  it("core 放行就不拦，core 拦就带着原因拒；别的禁令照旧不问；连不上就拦", async () => {
    let answer: unknown = { allow: true };
    const bodies: string[] = [];
    const server = createServer((req, res) => {
      let b = "";
      req.on("data", (d) => (b += d)).on("end", () => { bodies.push(b); res.end(JSON.stringify(answer)); });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/jobs/j/push-check`;
    try {
      expect(await runGuard(buildGuardScript(process.execPath, url), "git push -u origin fix/a")).toBe("{}");
      expect(JSON.parse(bodies[0]!)).toEqual({ command: "git push -u origin fix/a", cwd: "/tmp/wt" });

      answer = { allow: false, why: "不许强推" };
      const denied = JSON.parse(await runGuard(buildGuardScript(process.execPath, url), "git push -f"));
      expect(denied.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(denied.hookSpecificOutput.permissionDecisionReason).toContain("不许强推");

      const rebase = JSON.parse(await runGuard(buildGuardScript(process.execPath, url), "git rebase main"));
      expect(rebase.hookSpecificOutput.permissionDecisionReason).toContain("变基会改写历史");
      expect(bodies).toHaveLength(2);
    } finally {
      server.close();
    }
    const down = JSON.parse(await runGuard(buildGuardScript(process.execPath, url), "git push"));
    expect(down.hookSpecificOutput.permissionDecisionReason).toContain("连不上 Friday");
    // 准备段 / 只读查询没有回报地址：push 一律拦
    expect(JSON.parse(await runGuard(buildGuardScript(process.execPath), "git push")).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("接口按真实仓库判断并记账", async () => {
    const repo = repoOnBranch("fix/push-ok");
    createJob({ id: "pc-1", project: "demo", dir: repo, task: "自主改", logPath: "/tmp/x.log" });
    const t = createTask({ title: "demo：pc-1", kind: "code", source: { jobId: "pc-1", autonomous: true, repoDir: repo, worktree: repo }, project: "demo", status: "processing" });
    const ask = async (command: string) => (await app.request("/jobs/pc-1/push-check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command, cwd: repo }) })).json();
    expect(await ask("git push -u origin HEAD")).toMatchObject({ allow: true, branches: ["fix/push-ok"] });
    expect(await ask("git push origin main")).toMatchObject({ allow: false });
    expect(listAudit({ taskId: t.id }).map((e) => e.action)).toEqual(expect.arrayContaining(["push_allowed", "push_denied"]));
  });
});
