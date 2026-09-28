import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { app } from "../api/index.js";
import { createJob, setJobSession } from "../memory/jobs.js";
import { createRun, runByJob, runsForTask, runsSummary } from "../memory/runs.js";
import { createTask, getTask, updateTask } from "../memory/tasks.js";
import { onJobExit } from "./pipeline.js";

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };

/** main 一个提交，再切到 branch 上改一个文件提交一次；返回仓库路径 */
function repoOnBranch(branch: string): string {
  const repo = mkdtempSync(join(tmpdir(), "friday-runs-"));
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "pipe", env });
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  git("switch", "-q", "-c", branch);
  writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n");
  git("commit", "-q", "-am", "fix");
  return repo;
}
const sha = (repo: string, ref = "HEAD") => execFileSync("git", ["-C", repo, "rev-parse", ref], { env }).toString().trim();
const rpc = (jobId: string, name: string, args: Record<string, unknown>) =>
  app.request(`/mcp/${jobId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });

function autonomousTask(jobId: string, repo: string) {
  createJob({ id: jobId, project: "demo", dir: repo, task: "自主改", logPath: "/tmp/x.log" });
  const t = createTask({ title: `demo：${jobId}`, kind: "code", source: { jobId, autonomous: true, repoDir: repo }, project: "demo", status: "processing", plan: "改" });
  createRun({ id: jobId, jobId, taskId: t.id, project: "demo", kind: "autonomous", trigger: "retry" });
  return t;
}

describe("runs 三处记账", () => {
  it("friday_done 交付：记下 exit=report、分支、tip、相对主干的 diff", async () => {
    const repo = repoOnBranch("fix/a");
    autonomousTask("rh-1", repo);
    await rpc("rh-1", "friday_done", { summary: "改完", testResult: "过" });
    expect(runByJob("rh-1")).toMatchObject({ exit: "report", branch: "fix/a", tipSha: sha(repo), filesChanged: 1, insertions: 2, deletions: 0 });
    expect(runByJob("rh-1")!.endedAt).toBeTruthy();
  });

  it("friday_blocked：exit=blocked", async () => {
    const repo = repoOnBranch("fix/b");
    autonomousTask("rh-2", repo);
    await rpc("rh-2", "friday_blocked", { reason: "需要生产库权限" });
    expect(runByJob("rh-2")!.exit).toBe("blocked");
  });

  it("窗口没了（-1）→ window_closed；正常退出没报告 → no_report；已交付过的不覆盖", async () => {
    const repo = repoOnBranch("fix/c");
    autonomousTask("rh-3", repo);
    onJobExit("rh-3", -1);
    expect(runByJob("rh-3")!.exit).toBe("window_closed");

    autonomousTask("rh-4", repoOnBranch("fix/d"));
    onJobExit("rh-4", 0);
    expect(runByJob("rh-4")!.exit).toBe("no_report");

    autonomousTask("rh-5", repoOnBranch("fix/e"));
    await rpc("rh-5", "friday_done", { summary: "改完", testResult: "过" });
    onJobExit("rh-5", 0);
    expect(runByJob("rh-5")!.exit).toBe("report");
  });

  it("合并时分支没动 → merged_as_is", async () => {
    const repo = repoOnBranch("fix/f");
    const t = autonomousTask("rh-6", repo);
    await rpc("rh-6", "friday_done", { summary: "改完", testResult: "过" });
    execFileSync("git", ["-C", repo, "switch", "-q", "main"], { env });
    const merge = getTask(t.id)!.pending!.find((p) => p.type === "git_merge")!;
    const res = await app.request(`/tasks/${t.id}/approve/${merge.id}`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(runByJob("rh-6")!.outcome).toBe("merged_as_is");
  });

  it("你在分支上又提交了一次 → merged_modified，写明几次", async () => {
    const repo = repoOnBranch("fix/g");
    const t = autonomousTask("rh-7", repo);
    await rpc("rh-7", "friday_done", { summary: "改完", testResult: "过" });
    writeFileSync(join(repo, "b.txt"), "mine\n");
    execFileSync("git", ["-C", repo, "add", "."], { env });
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "我补一刀"], { env });
    execFileSync("git", ["-C", repo, "switch", "-q", "main"], { env });
    const merge = getTask(t.id)!.pending!.find((p) => p.type === "git_merge")!;
    await app.request(`/tasks/${t.id}/approve/${merge.id}`, { method: "POST" });
    expect(runByJob("rh-7")).toMatchObject({ outcome: "merged_modified", outcomeWhy: "你在分支上又提交了 1 次" });
  });

  it("分支被改写过（amend / rebase）→ merged_modified，写明没法比对", async () => {
    const repo = repoOnBranch("fix/h");
    const t = autonomousTask("rh-8", repo);
    await rpc("rh-8", "friday_done", { summary: "改完", testResult: "过" });
    execFileSync("git", ["-C", repo, "commit", "-q", "--amend", "-m", "改个说明"], { env });
    execFileSync("git", ["-C", repo, "switch", "-q", "main"], { env });
    const merge = getTask(t.id)!.pending!.find((p) => p.type === "git_merge")!;
    await app.request(`/tasks/${t.id}/approve/${merge.id}`, { method: "POST" });
    expect(runByJob("rh-8")).toMatchObject({ outcome: "merged_modified", outcomeWhy: "分支被改写，无法比对" });
  });

  it("打回 → rejected 带原因；忽略 → abandoned", async () => {
    const t1 = autonomousTask("rh-9", repoOnBranch("fix/i"));
    await rpc("rh-9", "friday_done", { summary: "改完", testResult: "过" });
    await app.request(`/tasks/${t1.id}/reject`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "改错页面了" }) });
    expect(runByJob("rh-9")).toMatchObject({ outcome: "rejected", outcomeWhy: "改错页面了" });

    const t2 = autonomousTask("rh-10", repoOnBranch("fix/j"));
    await rpc("rh-10", "friday_done", { summary: "改完", testResult: "过" });
    await app.request(`/tasks/${t2.id}/ignore`, { method: "POST" });
    expect(runByJob("rh-10")!.outcome).toBe("abandoned");
  });

  it("交互式终端每轮 friday_done 各记一行，成本按轮次的增量算，不重复累计", async () => {
    const repo = repoOnBranch("feat/k");
    createJob({ id: "rh-11", project: "demo", dir: repo, task: "自己做", logPath: "/tmp/x.log" });
    const t = createTask({ title: "demo：自己做", kind: "code", source: { jobId: "rh-11" }, project: "demo", status: "processing" });
    await rpc("rh-11", "friday_done", { summary: "第一轮", testResult: "过" });
    await rpc("rh-11", "friday_done", { summary: "第二轮", testResult: "过" });
    const rounds = runsForTask(t.id).filter((r) => r.kind === "interactive_round");
    expect(rounds).toHaveLength(2);
    expect(rounds.every((r) => r.exit === "report" && r.branch === "feat/k")).toBe(true);
    updateTask(t.id, { status: "done" });
  });

  it("后台查询调 friday_done 不算「你开的终端」一轮——它的账只在查询那一行", async () => {
    const repo = repoOnBranch("main-ish");
    createJob({ id: "rh-q", project: "demo", dir: repo, task: "查一下", logPath: "/tmp/x.log" });
    const t = createTask({ title: "查询", kind: "slack", source: { jobId: "rh-q", headless: true, conversation: "C1:1" }, project: "demo", status: "processing" });
    createRun({ id: "rh-q", jobId: "rh-q", taskId: t.id, project: "demo", kind: "query", trigger: "slack" });
    await rpc("rh-q", "friday_done", { summary: "查到了", testResult: "无" });
    expect(runsForTask(t.id).map((r) => r.kind)).toEqual(["query"]);
  });

  it("friday_done 时 cost-state 还没写出来：进程退出时补上成本；一直读不到的在汇总里算「成本未知」", async () => {
    const home = mkdtempSync(join(tmpdir(), "friday-home-"));
    const realHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const repo = repoOnBranch("fix/cost");
      autonomousTask("rh-cost", repo);
      setJobSession("rh-cost", "sess-cost");
      await rpc("rh-cost", "friday_done", { summary: "改完", testResult: "过" });
      expect(runByJob("rh-cost")!.costUsd).toBeUndefined();
      // claude -p 退出时才把最后一条 cost-state 落盘
      const dir = join(home, ".claude", "projects", repo.replace(/[^A-Za-z0-9]/g, "-"));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "sess-cost.jsonl"), JSON.stringify({ type: "cost-state", totalCostUSD: 2.5, modelUsage: { "claude-opus-5": { costUSD: 2.5 } } }) + "\n");
      onJobExit("rh-cost", 0);
      expect(runByJob("rh-cost")).toMatchObject({ costUsd: 2.5, model: "claude-opus-5", exit: "report" });

      autonomousTask("rh-nocost", repoOnBranch("fix/nocost"));
      await rpc("rh-nocost", "friday_done", { summary: "改完", testResult: "过" });
      onJobExit("rh-nocost", 0);
      const g = runsSummary("30d").byProject.find((p) => p.project === "demo" && p.kind === "autonomous")!;
      expect(g.costUnknown).toBeGreaterThanOrEqual(1);
    } finally {
      process.env.HOME = realHome;
    }
  });

  it("不经 Friday 在别处合进了主干（MR），标完成时认出来：merged_as_is；没合进去的记 closed_unverified，不算 abandoned", async () => {
    const repo = repoOnBranch("fix/mr");
    const t = autonomousTask("rh-mr", repo);
    await rpc("rh-mr", "friday_done", { summary: "改完", testResult: "过" });
    execFileSync("git", ["-C", repo, "switch", "-q", "main"], { env });
    execFileSync("git", ["-C", repo, "merge", "-q", "--no-ff", "fix/mr", "-m", "MR !42"], { env });
    await app.request(`/tasks/${t.id}/done`, { method: "POST" });
    expect(runByJob("rh-mr")).toMatchObject({ outcome: "merged_as_is" });

    const t2 = autonomousTask("rh-open", repoOnBranch("fix/open"));
    await rpc("rh-open", "friday_done", { summary: "改完", testResult: "过" });
    await app.request(`/tasks/${t2.id}/done`, { method: "POST" });
    expect(runByJob("rh-open")).toMatchObject({ outcome: "closed_unverified" });
  });
});
