import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAutonomousJob, reportBackToOrigin } from "./pipeline.js";
import { createTask, getTask, listTasks, updateTask, findTaskBySource } from "../memory/tasks.js";
import { listAudit, undoPlan } from "../memory/audit.js";
import { initMemory } from "../memory/db.js";

describe("开工前的体检", () => {
  it("不是 git 仓库就不开工", async () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-nogit-"));
    const task = createTask({ title: "改点东西", kind: "code", source: {}, status: "understood" });
    const out = await startAutonomousJob(task, "demo", dir, "修登录报错");
    expect(out.status).toBe("blocked");
    expect(out.progress).toContain("不是 git 仓库");
    expect(out.source.jobId).toBeUndefined();
  });

  it("开不出 worktree 就不开工，不留半拉子任务", async () => {
    // 空仓库（还没有任何提交）开不出 worktree
    const dir = mkdtempSync(join(tmpdir(), "friday-empty-"));
    execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
    const task = createTask({ title: "改点东西", kind: "code", source: {}, status: "understood" });
    const out = await startAutonomousJob(task, "demo", dir, "修登录报错");
    expect(out.status).toBe("blocked");
    expect(out.progress).toContain("没有开工");
    expect(out.source.jobId).toBeUndefined();
    expect(out.source.worktree).toBeUndefined();
  });
});

describe("reportBackToOrigin", () => {
  it("干完活把结果写回来源任务并标成待你看", () => {
    const origin = createTask({ title: "拂晓：改一下文案", kind: "slack", source: {}, status: "processing" });
    const created = createTask({ title: "whale-console：改文案", kind: "code", source: { fromTaskId: origin.id }, status: "review" });
    const done = updateTask(created.id, { progress: "改完了，跑过测试" })!;
    reportBackToOrigin(done);
    const after = getTask(origin.id)!;
    expect(after.status).toBe("review");
    expect(after.attention).toBe("review");
    expect(after.progress).toContain("派出去的活已完成");
  });

  it("来源已经收工就不动它", () => {
    const origin = createTask({ title: "已完成的事", kind: "slack", source: {}, status: "done" });
    const done = createTask({ title: "活", kind: "code", source: { fromTaskId: origin.id }, status: "review" });
    reportBackToOrigin(done);
    expect(getTask(origin.id)!.status).toBe("done");
  });

  it("没有来源就什么都不做", () => {
    const done = createTask({ title: "孤立的活", kind: "code", source: {}, status: "review" });
    expect(() => reportBackToOrigin(done)).not.toThrow();
  });

  it("来源是一段 Slack 对话时，顺带挂一条回复草稿", () => {
    const origin = createTask({
      title: "拂晓：在哪配",
      kind: "slack",
      source: { conversation: "D1:1", channelId: "D1", userName: "拂晓" },
      status: "processing",
    });
    const created = createTask({ title: "查代码", kind: "code", source: { fromTaskId: origin.id }, status: "review" });
    reportBackToOrigin(updateTask(created.id, { progress: "在 config/app.ts 里配" })!);
    const reply = (getTask(origin.id)!.pending ?? []).find((p) => p.type === "slack_reply");
    expect(reply?.payload.channel).toBe("D1");
    expect(String(reply?.payload.text)).toContain("config/app.ts");
  });
});

describe("二期在一期分支上接着开", () => {
  it("基线任务的分支查得到，开工时才知道从哪儿检出", () => {
    const first = createTask({ title: "一期", kind: "meegle", source: { branch: "feat/phase-1" }, project: "demo-proj", status: "processing" });
    const second = createTask({ title: "二期", kind: "meegle", source: { baseTaskId: first.id }, project: "demo-proj", status: "understood" });
    const base = getTask(getTask(second.id)!.source.baseTaskId!)!;
    expect(base.source.branch).toBe("feat/phase-1");
  });
});

describe("两条需求合并成一条", () => {
  it("被并掉那条的工单号记在主任务名下，同步认得出、不会重新建", () => {
    const into = createTask({ title: "一期", kind: "meegle", source: { meegleId: "S1" }, status: "understood" });
    updateTask(into.id, { source: { mergedMeegleIds: ["S2"] } });
    const found = findTaskBySource((s) => s.meegleId === "S2" || (s.mergedMeegleIds ?? []).includes("S2"), true);
    expect(found?.id).toBe(into.id);
  });
});
