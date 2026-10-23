import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliveryReport } from "@friday/shared";
import { config } from "../config.js";
import { addPending, createTask, updateTask } from "../memory/tasks.js";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { executePending, finishTask } from "./pipeline.js";
import { setStage } from "./stage.js";
import { updateTaskFromChat } from "./taskUpdate.js";

// 挡在 SDK 这层：mock ./claude.js 时 importOriginal 会经 tools → knowledge 绕回真模块，真去调模型
vi.mock("@anthropic-ai/claude-agent-sdk", async (orig) => ({
  ...(await orig<typeof import("@anthropic-ai/claude-agent-sdk")>()),
  query: vi.fn(() => (async function* () {})()),
}));

const report: DeliveryReport = { summary: "改了列宽", changes: ["src/a.ts — 改列宽"], testSteps: [], testResult: "", screenshots: [], verify: [] };
const mk = (status: "review" | "done" = "review") => updateTask(createTask({ title: `改列宽 ${Math.random()}`, kind: "code", project: "p-done", status, source: {} }).id, { report })!;
const asked = () => vi.mocked(query).mock.calls.length;
const settle = () => new Promise((r) => setTimeout(r, 20));

beforeAll(() => {
  writeFileSync(join(config.dataDir, "projects.md"), `# 项目\n\n## p-done\n- 目录：${mkdtempSync(join(tmpdir(), "kb-done-"))}\n`);
});
beforeEach(() => vi.mocked(query).mockClear());

describe("收工写知识库：每条完成路径都触发，已完成的不重复记", () => {
  it("finishTask 标完成", async () => {
    await finishTask(mk().id, "done", "你把任务标记完成");
    await vi.waitFor(() => expect(asked()).toBe(1));
  });

  it("已经是完成的再 finishTask 一次不重复记", async () => {
    await finishTask(mk("done").id, "done", "又标了一次");
    await settle();
    expect(asked()).toBe(0);
  });

  it("阶段拨到已上线", async () => {
    const t = updateTask(mk().id, { stage: "accepted" })!;
    setStage(t.id, "released");
    await vi.waitFor(() => expect(asked()).toBe(1));
  });

  it("待审动作全部执行完", async () => {
    const t = addPending(mk().id, { type: "custom", label: "随便一个动作", detail: "d", payload: {} })!;
    await executePending(t.id, t.pending![0]!.id);
    await vi.waitFor(() => expect(asked()).toBe(1));
  });

  it("会话里 task_update 标完成", async () => {
    updateTaskFromChat(mk().id, { status: "done" });
    await vi.waitFor(() => expect(asked()).toBe(1));
  });
});
