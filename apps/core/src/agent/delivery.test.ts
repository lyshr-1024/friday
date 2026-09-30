import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { app } from "../api/index.js";
import { createJob } from "../memory/jobs.js";
import { createTask, getTask } from "../memory/tasks.js";
import { listMessages } from "../memory/conversations.js";
import { deliveryText } from "./delivery.js";
import { onJobExit } from "./pipeline.js";
import { reportPath, shotsDir } from "./runner.js";

const rpc = (jobId: string, name: string, args: unknown) =>
  app.request(`/mcp/${jobId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });

const report = { summary: "加了进度轮询", changes: ["src/a.ts:12 轮询没带 offset"], testSteps: [], testResult: "12 个用例全过", screenshots: [], verify: ["进度条随任务推进", "失败不卡在 99%"] };

describe("交付写进会话：卡上没有交付报告了，验收看这条", () => {
  it("写概要、测试结果、请你验证；后台查询多写依据", () => {
    const text = deliveryText(report);
    expect(text).toContain("交付了：加了进度轮询");
    expect(text).toContain("测试结果：12 个用例全过");
    expect(text).toContain("请你验证：\n- 进度条随任务推进\n- 失败不卡在 99%");
    expect(text).not.toContain("依据");
    expect(deliveryText(report, true)).toContain("查完了：加了进度轮询");
    expect(deliveryText(report, true)).toContain("依据：\n- src/a.ts:12 轮询没带 offset");
  });

  it("没写测试结果（占位的「（…）」）就不写那一行", () => {
    expect(deliveryText({ ...report, testResult: "（没写测试结果）" })).not.toContain("测试结果");
  });

  it("自主任务 friday_done：会话里一条完整的交付消息，不再是一句概要", async () => {
    createJob({ id: "job-dl-1", project: "demo", dir: "/tmp", task: "自主改", logPath: "/tmp/x.log" });
    const t = createTask({ title: "自主改", kind: "code", source: { jobId: "job-dl-1", autonomous: true }, project: "demo", status: "processing", plan: "改" });
    await rpc("job-dl-1", "friday_done", { summary: "加了进度轮询", testResult: "全过", verify: ["看 A"] });
    const msgs = listMessages(getTask(t.id)!.source.conversationId!).filter((m) => m.role === "assistant");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.content).toBe("交付了：加了进度轮询\n测试结果：全过\n请你验证：\n- 看 A");
  });

  it("friday_done 交付后退出：把截图目录收成附件，补一条带截图的消息", async () => {
    createJob({ id: "job-dl-2", project: "demo", dir: "/tmp", task: "自主改", logPath: "/tmp/x.log" });
    const t = createTask({ title: "自主改 2", kind: "code", source: { jobId: "job-dl-2", autonomous: true }, project: "demo", status: "processing", plan: "改" });
    await rpc("job-dl-2", "friday_done", { summary: "改完", testResult: "过" });
    mkdirSync(shotsDir("job-dl-2"), { recursive: true });
    writeFileSync(join(shotsDir("job-dl-2"), "page.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    onJobExit("job-dl-2", 0);
    const after = getTask(t.id)!;
    expect(after.report!.screenshots).toHaveLength(1);
    const last = listMessages(after.source.conversationId!).at(-1)!;
    expect(last.content).toBe("截图 1 张：");
    expect((last.payload as { attachments: unknown[] }).attachments).toHaveLength(1);
  });

  it("没调 friday_done、退出时读 report.md 的：同样写一条交付消息，截图挂上", () => {
    createJob({ id: "job-dl-3", project: "demo", dir: "/tmp", task: "自主改", logPath: "/tmp/x.log" });
    const t = createTask({ title: "自主改 3", kind: "code", source: { jobId: "job-dl-3", autonomous: true }, project: "demo", status: "processing", plan: "改" });
    mkdirSync(shotsDir("job-dl-3"), { recursive: true });
    writeFileSync(join(shotsDir("job-dl-3"), "a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(reportPath("job-dl-3"), "## 概要\n改好了\n\n## 测试结果\n过\n\n## 请验证\n- 看 B\n");
    onJobExit("job-dl-3", 0);
    const last = listMessages(getTask(t.id)!.source.conversationId!).at(-1)!;
    expect(last.content).toContain("交付了：改好了");
    expect(last.content).toContain("- 看 B");
    expect((last.payload as { attachments: unknown[] }).attachments).toHaveLength(1);
  });
});
