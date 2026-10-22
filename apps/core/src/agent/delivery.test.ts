import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { app } from "../api/index.js";
import { createJob } from "../memory/jobs.js";
import { createTask, getTask } from "../memory/tasks.js";
import { createConversation, listMessages } from "../memory/conversations.js";
import { deliveryText } from "./delivery.js";
import { onJobExit } from "./pipeline.js";
import { reportPath, shotsDir } from "./runner.js";

const rpc = (jobId: string, name: string, args: unknown) =>
  app.request(`/mcp/${jobId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });

const report = { summary: "加了进度轮询", changes: ["src/a.ts:12 轮询没带 offset"], testSteps: [], testResult: "12 个用例全过", screenshots: [], verify: ["进度条随任务推进", "失败不卡在 99%"] };

describe("deliveryText：交付消息的正文（主对话的主动消息复用）", () => {
  it("写概要、测试结果、请你验证；后台查询多写依据", () => {
    const text = deliveryText(report);
    expect(text).toContain("交付了：加了进度轮询");
    expect(text).toContain("测试结果：12 个用例全过");
    expect(text).toContain("请你验证：\n- 进度条随任务推进\n- 失败不卡在 99%");
    expect(text).not.toContain("依据");
    expect(deliveryText(report, true)).toContain("查完了：加了进度轮询");
    expect(deliveryText(report, true)).toContain("依据：\n- src/a.ts:12 轮询没带 offset");
  });

  it("带「替你定了」，在测试结果之后、请你验证之前", () => {
    const text = deliveryText({ ...report, decisions: ["字段用 string"] });
    expect(text).toContain("替你定了：\n- 字段用 string");
    expect(text.indexOf("替你定了")).toBeGreaterThan(text.indexOf("测试结果"));
    expect(text.indexOf("替你定了")).toBeLessThan(text.indexOf("请你验证"));
  });

  it("没写测试结果（占位的「（…）」）就不写那一行", () => {
    expect(deliveryText({ ...report, testResult: "（没写测试结果）" })).not.toContain("测试结果");
  });

  it("交付不再往任务会话写消息（由主对话的主动消息接手）", async () => {
    const conv = createConversation();
    createJob({ id: "job-dl-1", project: "demo", dir: "/tmp", task: "自主改", logPath: "/tmp/x.log" });
    const t = createTask({ title: "自主改", kind: "code", source: { jobId: "job-dl-1", autonomous: true, conversationId: conv.id }, project: "demo", status: "processing", plan: "改" });
    await rpc("job-dl-1", "friday_done", { summary: "加了进度轮询", testResult: "全过", verify: ["看 A"] });
    expect(getTask(t.id)!.report!.summary).toBe("加了进度轮询");
    expect(listMessages(conv.id)).toHaveLength(0);
  });

  it("friday_done 交付后退出：截图照样收成附件，但不往任务会话补消息", async () => {
    const conv = createConversation();
    createJob({ id: "job-dl-2", project: "demo", dir: "/tmp", task: "自主改", logPath: "/tmp/x.log" });
    const t = createTask({ title: "自主改 2", kind: "code", source: { jobId: "job-dl-2", autonomous: true, conversationId: conv.id }, project: "demo", status: "processing", plan: "改" });
    await rpc("job-dl-2", "friday_done", { summary: "改完", testResult: "过" });
    mkdirSync(shotsDir("job-dl-2"), { recursive: true });
    writeFileSync(join(shotsDir("job-dl-2"), "page.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    onJobExit("job-dl-2", 0);
    expect(getTask(t.id)!.report!.screenshots).toHaveLength(1);
    expect(listMessages(conv.id)).toHaveLength(0);
  });

  it("没调 friday_done、退出时读 report.md 的：报告和截图照样落卡，不写会话消息", () => {
    const conv = createConversation();
    createJob({ id: "job-dl-3", project: "demo", dir: "/tmp", task: "自主改", logPath: "/tmp/x.log" });
    const t = createTask({ title: "自主改 3", kind: "code", source: { jobId: "job-dl-3", autonomous: true, conversationId: conv.id }, project: "demo", status: "processing", plan: "改" });
    mkdirSync(shotsDir("job-dl-3"), { recursive: true });
    writeFileSync(join(shotsDir("job-dl-3"), "a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(reportPath("job-dl-3"), "## 概要\n改好了\n\n## 测试结果\n过\n\n## 请验证\n- 看 B\n");
    onJobExit("job-dl-3", 0);
    const after = getTask(t.id)!;
    expect(after.report!.summary).toBe("改好了");
    expect(after.report!.screenshots).toHaveLength(1);
    expect(listMessages(conv.id)).toHaveLength(0);
  });
});
