import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { addPending, createTask, getTask, updateTask } from "../memory/tasks.js";
import { updateTaskFromChat } from "./taskUpdate.js";
import { executePending } from "./pipeline.js";
import { app } from "../api/index.js";

describe("会话结论回流任务卡", () => {
  it("改方案、改回复草稿：待审动作的 detail 和 payload.text 一起换，通过时发的就是新文本", () => {
    const t = createTask({ title: "知许：改 segment", kind: "slack", source: { threadId: "th-1" }, status: "understood", plan: "先看群里的完整要求" });
    addPending(t.id, { type: "slack_reply", label: "回复 知许", detail: "收到，我看下", payload: { channel: "C1", text: "收到，我看下", userName: "知许" } });
    const r = updateTaskFromChat(t.id, { plan: "variant_mode 改 exclusive，conditions 加 pending_feed_g_at_17<=0", replyDraft: "改法定了：variant_mode 改 exclusive，今天下午提 MR" })!;
    expect(r.changed).toEqual(["方案", "回复草稿"]);
    const after = getTask(t.id)!;
    expect(after.plan).toContain("exclusive");
    expect(after.pending![0]).toMatchObject({ detail: "改法定了：variant_mode 改 exclusive，今天下午提 MR", payload: { channel: "C1", text: "改法定了：variant_mode 改 exclusive，今天下午提 MR", userName: "知许" } });
  });

  it("Friday 能重写验收列表：没有报告时凭空建，已勾的状态清零", () => {
    const t = createTask({ title: "改导出中心", kind: "code", source: {}, status: "processing" });
    // 之前没有交付报告也能写
    const r1 = updateTaskFromChat(t.id, { verify: ["导出按钮出现在右上角", "点了能下到 csv"] })!;
    expect(r1.changed).toEqual(["验收列表"]);
    const a = getTask(t.id)!;
    expect(a.report!.verify).toEqual(["导出按钮出现在右上角", "点了能下到 csv"]);
    expect(a.report!.checked).toEqual([false, false]);
    expect(a.report!.summary).toBe("");

    // 勾掉一条后换列表：新条目没人验过，勾选必须清零
    updateTaskFromChat(t.id, { verify: ["导出按钮出现在右上角", "点了能下到 csv"] });
    const withCheck = getTask(t.id)!;
    updateTaskFromChat(t.id, { verify: ["换了方案：导出入口挪到了左栏"] });
    const b = getTask(t.id)!;
    expect(b.report!.verify).toEqual(["换了方案：导出入口挪到了左栏"]);
    expect(b.report!.checked).toEqual([false]);
    expect(withCheck.report!.verify).toHaveLength(2);
  });

  it("验收列表没变就不算改动，空条目会被丢掉", () => {
    const t = createTask({ title: "y", kind: "code", source: {}, status: "processing" });
    updateTaskFromChat(t.id, { verify: ["  只有这一条  ", "   "] });
    expect(getTask(t.id)!.report!.verify).toEqual(["只有这一条"]);
    expect(updateTaskFromChat(t.id, { verify: ["只有这一条"] })!.changed).toEqual([]);
  });

  it("重写验收列表不碰终端已经交付的正文", () => {
    const t = createTask({ title: "z", kind: "code", source: {}, status: "review" });
    updateTask(t.id, {
      report: { summary: "改完了导出中心", changes: ["动了 3 个文件"], testSteps: ["跑了 pnpm test"], testResult: "42 passed", screenshots: [], verify: ["旧的一条"], checked: [true] },
    });
    updateTaskFromChat(t.id, { verify: ["新方案的一条"] });
    const a = getTask(t.id)!;
    // 只换验收点和勾选，终端交付的正文原样留着
    expect(a.report!.verify).toEqual(["新方案的一条"]);
    expect(a.report!.checked).toEqual([false]);
    expect(a.report!.summary).toBe("改完了导出中心");
    expect(a.report!.changes).toEqual(["动了 3 个文件"]);
    expect(a.report!.testResult).toBe("42 passed");
  });

  it("dropReply 撤掉待审回复；没变化就不记", () => {
    const t = createTask({ title: "x", kind: "slack", source: { threadId: "th-2" }, status: "review" });
    addPending(t.id, { type: "slack_reply", label: "回复", detail: "a", payload: { channel: "C", text: "a" } });
    expect(updateTaskFromChat(t.id, { dropReply: true })!.changed).toEqual(["撤掉回复"]);
    expect(getTask(t.id)!.pending ?? []).toHaveLength(0);
    expect(updateTaskFromChat(t.id, { plan: undefined })!.changed).toEqual([]);
    expect(updateTaskFromChat("nope", { plan: "x" })).toBeUndefined();
  });

  it("审核通过但发送失败：动作放回待审，用户改好的文本不丢", async () => {
    const t = createTask({ title: "y", kind: "slack", source: {}, status: "review" });
    addPending(t.id, { type: "slack_reply", label: "回复", detail: "改好的文本", payload: { channel: "C", text: "改好的文本" } });
    const actionId = getTask(t.id)!.pending![0]!.id;
    await expect(executePending(t.id, actionId, { slackPost: async () => { throw new Error("channel_not_found"); } })).rejects.toThrow("channel_not_found");
    const after = getTask(t.id)!;
    expect(after.pending).toHaveLength(1);
    expect(after.pending![0]).toMatchObject({ id: actionId, detail: "改好的文本" });
    expect(after.status).toBe("review");
  });

  it("用户在会话里说做完了：状态改 done，清掉等你看标记和没发的待审动作", () => {
    const t = createTask({ title: "z", kind: "code", source: { jobId: "j" }, status: "processing" });
    addPending(t.id, { type: "slack_reply", label: "回复", detail: "a", payload: { channel: "C", text: "a" } });
    const r = updateTaskFromChat(t.id, { status: "done" })!;
    expect(r.changed).toEqual(["状态 → 已完成"]);
    const after = getTask(t.id)!;
    expect(after.status).toBe("done");
    expect(after.pending ?? []).toHaveLength(0);
    expect(after.attention).toBeUndefined();
  });

  it("星标关注往返", async () => {
    const t = createTask({ title: "p", kind: "code", source: {}, status: "processing" });
    const on = (await (await app.request(`/tasks/${t.id}/pin`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pinned: true }) })).json()) as { pinned?: boolean };
    expect(on.pinned).toBe(true);
    expect(getTask(t.id)!.pinned).toBe(true);
    const off = (await (await app.request(`/tasks/${t.id}/pin`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pinned: false }) })).json()) as { pinned?: boolean };
    expect(off.pinned).toBeUndefined();
  });

  it("答了归属就把 Friday 的提问收掉，不然它还挂在「待我决定」里", () => {
    writeFileSync(join(config.dataDir, "projects.md"), "## whale-console\n- 目录：/x/whale-console\n");
    const t = createTask({ title: "【NZ-开户详情页】无人脸照片时展示「暂无照片」", kind: "meegle", source: { meegleId: "24519239" }, status: "understood" });
    updateTask(t.id, { attention: "intake", progress: "这条工单是财富后台还是新BO项目的？" });
    updateTaskFromChat(t.id, { project: "whale-console" });
    expect(getTask(t.id)!.attention).toBeUndefined();
  });
});
