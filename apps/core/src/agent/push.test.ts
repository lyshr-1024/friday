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
import { createTask, getTask } from "../memory/tasks.js";
import { addMessage, createConversation } from "../memory/conversations.js";
import { FORCE_GRANT_MS, grantForcePush, hasForcePush } from "./pushGrant.js";
import { fridayToolList } from "./tools.js";
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
    for (const cmd of ["git push -f", "git push --force origin fix/a", "git push --force-with-lease", "git push -uf origin fix/a", "git push origin +fix/a"]) expect(verdict(cmd), cmd).toMatchObject({ allow: false, why: expect.stringContaining("不许强推") });
    for (const cmd of ["git push origin --delete fix/a", "git push origin :fix/a", "git push -d origin fix/a"]) expect(verdict(cmd), cmd).toMatchObject({ allow: false, why: "不许删远端分支" });
    expect(verdict("git push --tags")).toMatchObject({ allow: false });
    expect(verdict("git push origin refs/tags/v1")).toMatchObject({ allow: false });
    expect(verdict("git push --all")).toMatchObject({ allow: false });
  });

  it("只因强推被拦时带上强推种类和分支，留给授权判断；推主干的强推不带", () => {
    expect(verdict("git push --force-with-lease origin fix/a")).toMatchObject({ allow: false, force: { kind: "lease", dir: "/repo", branches: ["fix/a"] } });
    expect(verdict("git push --force-with-lease --force-if-includes")).toMatchObject({ force: { kind: "lease", branches: ["fix/a"] } });
    for (const cmd of ["git push -f", "git push --force origin fix/a", "git push --force-with-lease --force", "git push origin +fix/a"]) expect(verdict(cmd), cmd).toMatchObject({ force: { kind: "bare", branches: ["fix/a"] } });
    const main = verdict("git push --force-with-lease origin main");
    expect(main).toMatchObject({ allow: false, why: expect.stringContaining("main") });
    expect(main).not.toHaveProperty("force");
    expect(verdict("git push -fd origin fix/a")).toMatchObject({ allow: false, why: "不许删远端分支" });
  });

  it("推主干、环境分支、仓库默认分支都拦；当前就在主干上推也拦", () => {
    for (const b of ["main", "master", "sit", "release", "release/saas"]) expect(verdict(`git push origin ${b}`), b).toMatchObject({ allow: false });
    expect(verdict("git push origin HEAD:main")).toMatchObject({ allow: false });
    expect(verdict("git push", "master")).toMatchObject({ allow: false });
    expect(verdict("git push origin trunk", "fix/a", "trunk")).toMatchObject({ allow: false });
    expect(verdict("git push", "")).toMatchObject({ allow: false });
  });

  it("重定向不算要推的分支", () => {
    expect(verdict("git push -u origin fix/a 2>&1 | tail -8")).toMatchObject({ allow: true, branches: ["fix/a"] });
    expect(verdict("git push origin fix/a >/dev/null 2> /tmp/err")).toMatchObject({ allow: true, branches: ["fix/a"] });
    expect(verdict("git push --force-with-lease origin fix/a 2>&1 | tail -4")).toMatchObject({ force: { kind: "lease", branches: ["fix/a"] } });
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

  it("强推：用户授权过才放，只放 --force-with-lease、只放授权的分支、用一次就作废", async () => {
    const repo = repoOnBranch("fix/force-ok");
    createJob({ id: "pc-2", project: "demo", dir: repo, task: "自主改", logPath: "/tmp/y.log" });
    const t = createTask({ title: "demo：pc-2", kind: "code", source: { jobId: "pc-2", autonomous: true, repoDir: repo, worktree: repo }, project: "demo", status: "processing" });
    const ask = async (command: string) => (await app.request("/jobs/pc-2/push-check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command, cwd: repo }) })).json();
    expect(await ask("git push --force-with-lease origin fix/force-ok")).toMatchObject({ allow: false });
    grantForcePush(t.id, "fix/other");
    expect(await ask("git push --force-with-lease origin fix/force-ok")).toMatchObject({ allow: false });
    grantForcePush(t.id, "fix/force-ok");
    expect(await ask("git push --force origin fix/force-ok")).toMatchObject({ allow: false, why: expect.stringContaining("--force-with-lease") });
    expect(await ask("git push --force-with-lease origin fix/force-ok 2>&1 | tail -4")).toMatchObject({ allow: true, branches: ["fix/force-ok"] });
    expect(await ask("git push --force-with-lease origin fix/force-ok")).toMatchObject({ allow: false });
    expect(listAudit({ taskId: t.id }).find((e) => e.action === "push_allowed")!.why).toContain("授权");
    grantForcePush(t.id, "fix/force-ok", Date.now() - FORCE_GRANT_MS - 1);
    expect(await ask("git push --force-with-lease origin fix/force-ok")).toMatchObject({ allow: false });
  });
});

describe("会话里授权强推（push_force_grant）", () => {
  const setup = (branch: string) => {
    const repo = repoOnBranch(branch);
    const conv = createConversation().id;
    const jobId = `pg-${conv.slice(0, 8)}`;
    createJob({ id: jobId, project: "demo", dir: repo, task: "自主改", logPath: "/tmp/z.log" });
    const t = createTask({ title: "授权强推", kind: "code", source: { jobId, autonomous: true, repoDir: repo, worktree: repo, conversationId: conv }, project: "demo", status: "review" });
    const grant = async (said: string) => {
      addMessage(conv, { role: "user", kind: "ask", content: said });
      const tool = fridayToolList(conv).find((x) => x.name === "push_force_grant")!;
      return ((await tool.handler({} as never, {})).content[0] as { text: string }).text;
    };
    return { t, grant };
  };

  it("整句是强推才记授权；带问号、附加要求的不算", async () => {
    const { t, grant } = setup("fix/grant-a");
    expect(await grant("要不要强推？")).toMatch(/还没明确授权/);
    expect(await grant("强推吧，顺便改下描述")).toMatch(/还没明确授权/);
    expect(hasForcePush(t.id, "fix/grant-a")).toBe(false);
    expect(await grant("强推吧")).toMatch(/fix\/grant-a/);
    expect(hasForcePush(t.id, "fix/grant-a")).toBe(true);
    expect(listAudit({ taskId: t.id }).some((e) => e.action === "push_force_granted")).toBe(true);
  });

  it("任务在主干上：授权了也不推", async () => {
    const { t, grant } = setup("main-like");
    execFileSync("git", ["-C", getTask(t.id)!.source.worktree!, "switch", "-q", "main"], { stdio: "pipe" });
    expect(await grant("强推")).toMatch(/受保护分支/);
    expect(hasForcePush(t.id, "main")).toBe(false);
  });
});
