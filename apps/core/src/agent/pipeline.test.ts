import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAutonomousJob, reportBackToOrigin, onJobExit, finishTask } from "./pipeline.js";
import { createJob } from "../memory/jobs.js";
import { createRun, finishRun, openRunForTask, runByJob, runsForTask } from "../memory/runs.js";
import { state } from "../scheduler/index.js";
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

describe("测试阶段缺陷交给需求会话后的收尾", () => {
  const mkJob = (id: string, taskId: string) => createJob({ id, project: "app", dir: process.cwd(), logPath: join(tmpdir(), `${id}.log`), taskId });
  const handed = (rootId: string, extra: Record<string, unknown> = {}) =>
    createTask({ title: "缺陷", kind: "meegle", source: { rootId, autonomous: true, handedAt: new Date().toISOString(), ...extra }, status: "processing", project: "app" });

  it("headless 缺陷退出没交付：blocked、runs no_report、不挂 git_merge", () => {
    const story = createTask({ title: "需求", kind: "meegle", source: {}, status: "processing", project: "app" });
    const bug = handed(story.id, { jobId: "hj1" });
    mkJob("hj1", bug.id);
    createRun({ id: "hj1", jobId: "hj1", taskId: bug.id, project: "app", kind: "story_bug", trigger: "autostart" });
    onJobExit("hj1", 0);
    const t = getTask(bug.id)!;
    expect(t.status).toBe("blocked");
    expect(t.progress).toBe("需求会话退出了，这条没交付");
    expect(t.pending ?? []).toHaveLength(0);
    expect(runByJob("hj1")!.exit).toBe("no_report");
    onJobExit("hj1", -1);
  });

  it("headless 缺陷会话已不在（-1）：run 记 window_closed", () => {
    const story = createTask({ title: "需求", kind: "meegle", source: {}, status: "processing", project: "app" });
    const bug = handed(story.id, { jobId: "hj2" });
    mkJob("hj2", bug.id);
    createRun({ id: "hj2", jobId: "hj2", taskId: bug.id, project: "app", kind: "story_bug", trigger: "autostart" });
    onJobExit("hj2", -1);
    expect(runByJob("hj2")!.exit).toBe("window_closed");
  });

  it("需求的交互式 Claude 退出：say 路的 handed 缺陷标 blocked，有自己 job 的不动", () => {
    const story = createTask({ title: "需求", kind: "meegle", source: { jobId: "sj1" }, status: "processing", project: "app" });
    mkJob("sj1", story.id);
    const bug = handed(story.id);
    createRun({ id: "sj1#x", jobId: "sj1#x", taskId: bug.id, project: "app", kind: "story_bug", trigger: "autostart" });
    const own = handed(story.id, { jobId: "other" });
    const n = state.notices.length;
    onJobExit("sj1", 0);
    expect(getTask(bug.id)!.status).toBe("blocked");
    expect(getTask(bug.id)!.progress).toBe("需求会话退出了，这条没交付");
    expect(openRunForTask(bug.id)).toBeUndefined();
    expect(getTask(own.id)!.status).toBe("processing");
    expect(state.notices.length).toBe(n + 1);
  });

  it("用户标完成：story_bug 的 run 记 merged_as_is；忽略记 abandoned", async () => {
    const story = createTask({ title: "需求", kind: "meegle", source: {}, status: "processing", project: "app" });
    const a = handed(story.id);
    const b = handed(story.id);
    for (const [i, t] of [a, b].entries()) {
      createRun({ id: `r${i}-${t.id}`, jobId: `r${i}-${t.id}`, taskId: t.id, project: "app", kind: "story_bug", trigger: "autostart" });
      finishRun(`r${i}-${t.id}`, { exit: "report" });
    }
    await finishTask(a.id, "done", "完成");
    await finishTask(b.id, "ignored", "不用了");
    expect(runsForTask(a.id)[0]).toMatchObject({ outcome: "merged_as_is", outcomeWhy: "在需求分支上交付，由测试环境验收" });
    expect(runsForTask(b.id)[0]?.outcome).toBe("abandoned");
  });
});
