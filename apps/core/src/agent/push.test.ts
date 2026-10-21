import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { app } from "../api/index.js";
import { config } from "../config.js";
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
const verdict = (cmd: string, current = "fix/a", main?: string, patterns?: string[]) => pushVerdict(cmd, "/repo", git(current, main), patterns);

describe("pushVerdict：只拦保护分支，开发分支怎么推都行", () => {
  it("推当前分支、显式分支、带 MR 选项都放行", () => {
    expect(verdict("git push -u origin fix/a")).toMatchObject({ allow: true, branches: ["fix/a"] });
    expect(verdict("git push")).toMatchObject({ allow: true, branches: ["fix/a"] });
    expect(verdict("git push -u origin HEAD")).toMatchObject({ allow: true, branches: ["fix/a"] });
    expect(verdict("pnpm test && git push origin HEAD:refs/heads/feat/x")).toMatchObject({ allow: true, branches: ["feat/x"] });
    expect(verdict("git push -o merge_request.create origin fix/a")).toMatchObject({ allow: true });
  });

  it("开发分支的强推、删远端、一条命令推几次都放行", () => {
    for (const cmd of ["git push -f", "git push --force origin fix/a", "git push --force-with-lease", "git push -uf origin fix/a", "git push origin +fix/a", "git push --force-with-lease origin fix/b:fix/a"]) {
      expect(verdict(cmd), cmd).toMatchObject({ allow: true });
    }
    for (const cmd of ["git push origin --delete fix/a", "git push origin :fix/a", "git push -d origin fix/a"]) expect(verdict(cmd), cmd).toMatchObject({ allow: true, branches: ["fix/a"] });
    expect(verdict("git push origin fix/a && git push origin fix/b")).toMatchObject({ allow: true, branches: ["fix/a", "fix/b"] });
  });

  it("推到保护分支、删保护分支、推全部、推 tag、游离 HEAD 都拦", () => {
    for (const b of ["main", "master", "sit", "release", "release/saas"]) expect(verdict(`git push origin ${b}`), b).toMatchObject({ allow: false, why: expect.stringContaining(b) });
    expect(verdict("git push origin HEAD:main")).toMatchObject({ allow: false });
    expect(verdict("git push --force-with-lease origin fix/a:main")).toMatchObject({ allow: false });
    expect(verdict("git push", "master")).toMatchObject({ allow: false });
    expect(verdict("git push origin trunk", "fix/a", "trunk")).toMatchObject({ allow: false });
    expect(verdict("git push", "")).toMatchObject({ allow: false, why: expect.stringContaining("游离") });
    for (const cmd of ["git push origin --delete main", "git push origin :master", "git push -d origin release"]) expect(verdict(cmd), cmd).toMatchObject({ allow: false });
    expect(verdict("git push --all")).toMatchObject({ allow: false });
    expect(verdict("git push --mirror")).toMatchObject({ allow: false });
    expect(verdict("git push --tags")).toMatchObject({ allow: false, why: expect.stringContaining("tag") });
    expect(verdict("git push origin refs/tags/v1")).toMatchObject({ allow: false, why: expect.stringContaining("tag") });
    expect(verdict("git push origin fix/a && git push origin main")).toMatchObject({ allow: false });
  });

  it("项目自己的保护名单整体替换默认名单", () => {
    expect(verdict("git push origin main", "fix/a", undefined, ["trunk", "canary*"])).toMatchObject({ allow: true, branches: ["main"] });
    expect(verdict("git push origin canary-7", "fix/a", undefined, ["trunk", "canary*"])).toMatchObject({ allow: false, why: expect.stringContaining("canary-7") });
    expect(verdict("git push", "trunk", undefined, ["trunk"])).toMatchObject({ allow: false });
  });

  it("重定向不算要推的分支", () => {
    expect(verdict("git push -u origin fix/a 2>&1 | tail -8")).toMatchObject({ allow: true, branches: ["fix/a"] });
    expect(verdict("git push origin fix/a >/dev/null 2> /tmp/err")).toMatchObject({ allow: true, branches: ["fix/a"] });
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
  it("push 问 core；切保护分支本地直接拦；rebase / merge 不问也不拦；连不上就拦", async () => {
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

      answer = { allow: false, why: "不许推 main" };
      const denied = JSON.parse(await runGuard(buildGuardScript(process.execPath, url), "git push origin main"));
      expect(denied.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(denied.hookSpecificOutput.permissionDecisionReason).toContain("不许推 main");

      expect(await runGuard(buildGuardScript(process.execPath, url), "git rebase main")).toBe("{}");
      expect(await runGuard(buildGuardScript(process.execPath, url), "git merge main")).toBe("{}");
      const sw = JSON.parse(await runGuard(buildGuardScript(process.execPath, url), "git checkout main"));
      expect(sw.hookSpecificOutput.permissionDecisionReason).toContain("保护分支");
      const own = JSON.parse(await runGuard(buildGuardScript(process.execPath, url, ["trunk"]), "git switch trunk"));
      expect(own.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(await runGuard(buildGuardScript(process.execPath, url, ["trunk"]), "git checkout main")).toBe("{}");
      expect(bodies).toHaveLength(2);
    } finally {
      server.close();
    }
    const down = JSON.parse(await runGuard(buildGuardScript(process.execPath, url), "git push"));
    expect(down.hookSpecificOutput.permissionDecisionReason).toContain("连不上 Friday");
    // 准备段 / 只读查询没有回报地址：push 一律拦
    expect(JSON.parse(await runGuard(buildGuardScript(process.execPath), "git push")).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("接口按真实仓库和项目的保护名单判断并记账", async () => {
    writeFileSync(join(config.dataDir, "projects.md"), "## demo\n- 目录：/tmp/demo\n- 保护分支：trunk, canary*\n");
    const repo = repoOnBranch("fix/push-ok");
    createJob({ id: "pc-1", project: "demo", dir: repo, task: "自主改", logPath: "/tmp/x.log" });
    const t = createTask({ title: "demo：pc-1", kind: "code", source: { jobId: "pc-1", autonomous: true, repoDir: repo, worktree: repo }, project: "demo", status: "processing" });
    const ask = async (command: string) => (await app.request("/jobs/pc-1/push-check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command, cwd: repo }) })).json();
    expect(await ask("git push -u origin HEAD")).toMatchObject({ allow: true, branches: ["fix/push-ok"] });
    expect(await ask("git push --force-with-lease origin fix/push-ok")).toMatchObject({ allow: true });
    expect(await ask("git push origin canary-2")).toMatchObject({ allow: false });
    expect(await ask("git push origin trunk")).toMatchObject({ allow: false });
    // 仓库自己的默认分支（origin/HEAD）另外算；这个仓库没有远端，main 在项目名单外就放
    expect(await ask("git push origin main")).toMatchObject({ allow: true });
    expect(listAudit({ taskId: t.id }).map((e) => e.action)).toEqual(expect.arrayContaining(["push_allowed", "push_denied"]));
  });
});
