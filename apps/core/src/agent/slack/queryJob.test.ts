import { describe, expect, it } from "vitest";
import { queryJobPrompt } from "./queryJob.js";
import { initMemory } from "../../memory/db.js";
import { createTask, updateTask } from "../../memory/tasks.js";
import { createJob } from "../../memory/jobs.js";
import { onJobExit } from "../pipeline.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { reportPath, runsDir, jobLog } from "../runner.js";

describe("queryJobPrompt", () => {
  const one = [{ name: "whale-console", dir: "/w" }];
  const two = [...one, { name: "fe-wealth-admin", dir: "/f" }];

  it("写明只读、写明报告去哪", () => {
    const p = queryJobPrompt("job1", "分群奖励在哪配置", one, "拂晓");
    expect(p).toContain("只读");
    expect(p).toContain("不要修改任何文件");
    expect(p).toContain("job1.report.md");
    expect(p).toContain("分群奖励在哪配置");
    expect(p).toContain("拂晓");
  });

  it("要求给出文件路径和行号当依据", () => {
    expect(queryJobPrompt("job1", "x", one, "A")).toContain("行号");
  });

  it("项目判不出时列出全部项目让它自己判", () => {
    const p = queryJobPrompt("job1", "x", two, "A");
    expect(p).toContain("whale-console");
    expect(p).toContain("fe-wealth-admin");
    expect(p).toContain("先判断问的是哪个");
  });

  it("要求最后给一句可直接发出去的回复", () => {
    expect(queryJobPrompt("job1", "x", one, "A")).toContain("## 回复草稿");
  });

  it("不提终端、不让它等人——它跑在后台没有窗口", () => {
    const p = queryJobPrompt("job1", "x", one, "A");
    expect(p).toContain("不要问用户问题");
  });
});

describe("claudeArgs", () => {
  it("后台跑要带 -p，参数是数组不带引号（spawn 用）", async () => {
    const { claudeArgs } = await import("../runner.js");
    const args = claudeArgs({ settings: "/tmp/a b.json", mcp: "/tmp/c.json" }, true);
    expect(args[0]).toBe("-p");
    expect(args).toContain("/tmp/a b.json");
    expect(args.some((a) => a.startsWith("'"))).toBe(false);
  });
});

describe("查询任务收工", () => {
  it("有报告就进 review 并挂回复草稿，不挂 git_merge", () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const task = createTask({
      title: "回答拂晓：分群奖励在哪配",
      kind: "slack",
      source: { conversation: "D1:1789000010.0", channelId: "D1", userName: "拂晓" },
      status: "processing",
    });
    const id = "queryjob1";
    createJob({ id, project: "whale-console", dir: "/tmp", task: "分群奖励在哪配", logPath: jobLog(id), taskId: task.id });
    updateTask(task.id, { source: { jobId: id, headless: true } });
    mkdirSync(runsDir(), { recursive: true });
    writeFileSync(reportPath(id), "## 概要\n在分群 tab 里。\n\n## 依据\n- a.tsx:10 — 表单在这\n\n## 回复草稿\n在活动编辑页的分群 tab 里配。");

    const out = onJobExit(id, 0)!;
    expect(out.status).toBe("review");
    expect(out.pending?.map((p) => p.type)).toEqual(["slack_reply"]);
    expect(out.pending![0]!.payload.channel).toBe("D1");
    expect(out.pending![0]!.detail).toContain("分群 tab");
  });

  it("没有报告就标 blocked，不挂草稿", () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const task = createTask({
      title: "回答夕瑶：这个字段哪来的",
      kind: "slack",
      source: { conversation: "D2:1789000020.0", channelId: "D2", userName: "夕瑶" },
      status: "processing",
    });
    const id = "queryjob2";
    createJob({ id, project: "whale-console", dir: "/tmp", task: "字段哪来的", logPath: jobLog(id), taskId: task.id });
    updateTask(task.id, { source: { jobId: id, headless: true } });

    const out = onJobExit(id, 1)!;
    expect(out.status).toBe("blocked");
    expect(out.pending ?? []).toHaveLength(0);
  });
});
