import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { app } from "../api/index.js";
import { listAudit } from "../memory/audit.js";
import { listMessages } from "../memory/conversations.js";
import { createJob } from "../memory/jobs.js";
import { createTask, getTask } from "../memory/tasks.js";
import { buildGuardScript } from "./runner.js";

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };

/** 带一个裸仓库当 origin 的仓库，切到 branch 上提交一次 */
function repoWithOrigin(branch: string): { repo: string; origin: string } {
  const root = mkdtempSync(join(tmpdir(), "friday-push-"));
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "--bare", origin], { env });
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env });
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "pipe", env });
  git("remote", "add", "origin", origin);
  writeFileSync(join(repo, "a.txt"), "one\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  git("switch", "-q", "-c", branch);
  writeFileSync(join(repo, "a.txt"), "two\n");
  git("commit", "-q", "-am", "fix");
  return { repo, origin };
}

function autonomousTask(jobId: string, repo: string) {
  createJob({ id: jobId, project: "demo", dir: repo, task: "自主改", logPath: "/tmp/x.log" });
  return createTask({ title: `demo：${jobId}`, kind: "code", source: { jobId, autonomous: true, repoDir: repo, worktree: repo }, project: "demo", status: "processing", plan: "改" });
}

const pushRequest = (jobId: string) => app.request(`/jobs/${jobId}/push-request`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "git push -u origin HEAD" }) });

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

describe("推送待审", () => {
  it("守卫拦下 push 时回报 core，并告诉 Claude 已挂审核、别重试；别的禁令照旧", async () => {
    const bodies: string[] = [];
    const server = createServer((req, res) => {
      let b = "";
      req.on("data", (d) => (b += d)).on("end", () => { bodies.push(b); res.end("{}"); });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/jobs/j/push-request`;
    try {
      const push = JSON.parse(await runGuard(buildGuardScript(process.execPath, url), "git -C /tmp/wt push -u origin fix/a"));
      expect(push.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(push.hookSpecificOutput.permissionDecisionReason).toContain("挂到 Friday 任务卡上等用户批准");
      expect(JSON.parse(bodies[0]!)).toEqual({ command: "git -C /tmp/wt push -u origin fix/a", cwd: "/tmp/wt" });

      const rebase = JSON.parse(await runGuard(buildGuardScript(process.execPath, url), "git rebase main"));
      expect(rebase.hookSpecificOutput.permissionDecisionReason).toContain("变基会改写历史");
      expect(bodies).toHaveLength(1);
    } finally {
      server.close();
    }
    // 只读查询不挂推送：没有回报地址就只是拒绝
    expect(JSON.parse(await runGuard(buildGuardScript(process.execPath), "git push")).hookSpecificOutput.permissionDecisionReason).toContain("推送要你审核");
  });

  it("挂一条 git_push 待审，同一分支不重复挂；批准后推到 origin、任务不收工", async () => {
    const { repo, origin } = repoWithOrigin("fix/push-a");
    const t = autonomousTask("push-1", repo);
    expect((await pushRequest("push-1")).status).toBe(200);
    await pushRequest("push-1");
    const pend = getTask(t.id)!.pending!.filter((p) => p.type === "git_push");
    expect(pend).toHaveLength(1);
    expect(pend[0]!.payload).toMatchObject({ branch: "fix/push-a", dir: repo, jobId: "push-1" });
    expect(getTask(t.id)!.status).toBe("processing");

    const res = await app.request(`/tasks/${t.id}/approve/${pend[0]!.id}`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(execFileSync("git", ["-C", origin, "branch", "--list", "fix/push-a"], { env }).toString()).toContain("fix/push-a");
    const after = getTask(t.id)!;
    expect(after.status).toBe("processing");
    expect(after.pending ?? []).toHaveLength(0);
    expect(listAudit({ taskId: t.id }).some((e) => e.action === "git_push")).toBe(true);
    // Claude 已经不在跑：不往终端敲字，会话里说明 MR 还没建
    expect(listMessages(after.source.conversationId!).at(-1)!.content).toContain("MR 还没建");
  });

  it("在主干上不挂", async () => {
    const { repo } = repoWithOrigin("fix/push-b");
    execFileSync("git", ["-C", repo, "switch", "-q", "main"], { env });
    const t = autonomousTask("push-2", repo);
    expect((await pushRequest("push-2")).status).toBe(409);
    expect(getTask(t.id)!.pending ?? []).toHaveLength(0);
  });
});
