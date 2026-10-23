import { describe, expect, it } from "vitest";
import type { ExternalRef } from "@friday/shared";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { reportPath, runsDir } from "./runner.js";
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
      kind: "conversation",
      source: { external: { tool: "slack", type: "conversation", id: "D1:1", author: "拂晓", attrs: { channelId: "D1" } } },
      status: "processing",
    });
    const created = createTask({ title: "查代码", kind: "code", source: { fromTaskId: origin.id }, status: "review" });
    reportBackToOrigin(updateTask(created.id, { progress: "在 config/app.ts 里配" })!);
    const reply = (getTask(origin.id)!.pending ?? []).find((p) => p.type === "chat_reply");
    expect((reply?.payload.to as ExternalRef | undefined)?.attrs?.channelId).toBe("D1");
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

  it("headless 缺陷已用 friday_done 交付（review）后退出：留在 review", () => {
    const story = createTask({ title: "需求", kind: "meegle", source: {}, status: "processing", project: "app" });
    const bug = handed(story.id, { jobId: "hj3" });
    mkJob("hj3", bug.id);
    updateTask(bug.id, { status: "review", report: { summary: "修好了", changes: [], testSteps: [], testResult: "过", screenshots: [], verify: [], at: new Date().toISOString() } });
    onJobExit("hj3", 0);
    expect(getTask(bug.id)!.status).toBe("review");
  });

  it("headless 缺陷用户已标完成后退出：仍是 done、不发通知、run 收尾", () => {
    const story = createTask({ title: "需求", kind: "meegle", source: {}, status: "processing", project: "app" });
    const bug = handed(story.id, { jobId: "hj4" });
    mkJob("hj4", bug.id);
    createRun({ id: "hj4", jobId: "hj4", taskId: bug.id, project: "app", kind: "story_bug", trigger: "autostart" });
    updateTask(bug.id, { status: "done" });
    const n = state.notices.length;
    onJobExit("hj4", 0);
    expect(getTask(bug.id)!.status).toBe("done");
    expect(state.notices.length).toBe(n);
    expect(runByJob("hj4")!.endedAt).toBeTruthy();
  });

  it("需求停在 review（交付过）时它的 Claude 退出：say 路的 handed 缺陷照样标 blocked", () => {
    const story = createTask({ title: "需求", kind: "meegle", source: { jobId: "sj2" }, status: "processing", project: "app" });
    updateTask(story.id, { status: "review", report: { summary: "做完", changes: [], testSteps: [], testResult: "过", screenshots: [], verify: [], at: new Date().toISOString() } });
    mkJob("sj2", story.id);
    const bug = handed(story.id);
    onJobExit("sj2", 0);
    expect(getTask(story.id)!.status).toBe("review");
    expect(getTask(bug.id)!.status).toBe("blocked");
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

describe("你收需求，名下缺陷跟着收", () => {
  it("挂在需求下的、交代进需求会话的一起标完成；别的需求的、已收工的不动；Meegle 自动收不级联", async () => {
    const story = createTask({ title: "新WBO", kind: "meegle", source: { meegleId: "s-100", mergedMeegleIds: ["s-101"], storyContainer: true }, status: "understood" });
    const a = createTask({ title: "缺陷 A", kind: "meegle", source: { meegleId: "d-1", linkedStoryId: "s-100" }, status: "review" });
    const b = createTask({ title: "缺陷 B", kind: "meegle", source: { meegleId: "d-2", linkedStoryId: "s-101" }, status: "blocked" });
    const c = createTask({ title: "缺陷 C", kind: "meegle", source: { meegleId: "d-3", rootId: story.id }, status: "understood" });
    const other = createTask({ title: "别的需求的缺陷", kind: "meegle", source: { meegleId: "d-4", linkedStoryId: "s-999" }, status: "understood" });
    const gone = createTask({ title: "早忽略了", kind: "meegle", source: { meegleId: "d-5", linkedStoryId: "s-100" }, status: "ignored" });
    await finishTask(story.id, "done", "你把任务标记完成", { withDefects: true });
    expect([a, b, c].map((t) => getTask(t.id)!.status)).toEqual(["done", "done", "done"]);
    expect(getTask(other.id)!.status).toBe("understood");
    expect(getTask(gone.id)!.status).toBe("ignored");
    expect(listAudit({ taskId: story.id }).find((e) => e.action === "story_defects_finished")?.how).toContain("3 条缺陷");

    const story2 = createTask({ title: "需求 2", kind: "meegle", source: { meegleId: "s-200" }, status: "understood" });
    const d = createTask({ title: "缺陷 D", kind: "meegle", source: { meegleId: "d-6", linkedStoryId: "s-200" }, status: "understood" });
    await finishTask(story2.id, "done", "「FE 发布」节点已经走完", { keepTerminal: true });
    expect(getTask(d.id)!.status).toBe("understood");
  });
});

describe("Friday 驾驶的 Claude 退出了", () => {
  it("没交付就退出（你 /exit 或它崩了）：标卡住，不算完成", () => {
    const t = createTask({ title: "自主改", kind: "verbal", source: { autonomous: true, jobId: "fx1" }, status: "processing", project: "app" });
    createJob({ id: "fx1", project: "app", dir: process.cwd(), logPath: join(tmpdir(), "fx1.log"), taskId: t.id });
    createRun({ id: "fx1", jobId: "fx1", taskId: t.id, project: "app", kind: "autonomous", trigger: "retry" });
    const out = onJobExit("fx1", 0)!;
    expect(out.status).toBe("blocked");
    expect(out.progress).toBe("Claude 退出了，这一轮没交付，看终端");
  });

  it("已收工（Meegle 自动收工留着终端）的任务，Claude 退出或会话没了：不翻成卡住", () => {
    for (const [id, status, code] of [["fx3", "done", 0], ["fx4", "ignored", -1]] as const) {
      const t = createTask({ title: id, kind: "verbal", source: { autonomous: true, jobId: id }, status, project: "app" });
      createJob({ id, project: "app", dir: process.cwd(), logPath: join(tmpdir(), `${id}.log`), taskId: t.id });
      createRun({ id, jobId: id, taskId: t.id, project: "app", kind: "autonomous", trigger: "retry" });
      expect(onJobExit(id, code)!.status).toBe(status);
      expect(runByJob(id)!.endedAt).toBeTruthy();
    }
  });

  it("升级时还在跑的老 -p 任务写了报告文件：照旧进审核", () => {
    const t = createTask({ title: "老任务", kind: "verbal", source: { autonomous: true, jobId: "fx2" }, status: "processing", project: "app" });
    createJob({ id: "fx2", project: "app", dir: process.cwd(), logPath: join(tmpdir(), "fx2.log"), taskId: t.id });
    mkdirSync(runsDir(), { recursive: true });
    writeFileSync(reportPath("fx2"), "## 概要\n改好了\n## 测试结果\n通过\n");
    expect(onJobExit("fx2", 0)!.status).toBe("review");
  });
});
