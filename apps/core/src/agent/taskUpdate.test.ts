import { describe, expect, it } from "vitest";
import { addPending, createTask, getTask } from "../memory/tasks.js";
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
});
