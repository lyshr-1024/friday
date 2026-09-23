import { describe, expect, it } from "vitest";
import { initMemory } from "../../memory/db.js";
import { addInboxItems, markInboxDone } from "../../memory/inbox.js";
import { addPending, createTask, getTask } from "../../memory/tasks.js";
import { archiveStaleTasks, settleQueryTasks, STALE_MS } from "./settle.js";

describe("你自己在 Slack 回了", () => {
  it("挂着的查询任务收掉、草稿撤下", () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    addInboxItems([
      { id: "S1:1", kind: "dm", channelId: "S1", channelName: "私聊", userId: "U1", userName: "拂晓", text: "在哪配", permalink: "p", ts: "1" },
    ]);
    markInboxDone("S1:1");
    let t = createTask({ title: "回答拂晓", kind: "slack", source: { conversation: "S1:1", channelId: "S1", headless: true }, status: "review" });
    t = addPending(t.id, { type: "slack_reply", label: "回复拂晓", detail: "草稿", payload: { channel: "S1", text: "草稿" } })!;

    expect(settleQueryTasks()).toBe(1);
    const after = getTask(t.id)!;
    expect(after.status).toBe("done");
    expect(after.pending ?? []).toHaveLength(0);
  });

  it("没被读过的不动", () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    addInboxItems([
      { id: "S2:1", kind: "dm", channelId: "S2", channelName: "私聊", userId: "U2", userName: "夕瑶", text: "在哪配", permalink: "p", ts: "1" },
    ]);
    const t = createTask({ title: "回答夕瑶", kind: "slack", source: { conversation: "S2:1", channelId: "S2", headless: true }, status: "review" });
    settleQueryTasks();
    expect(getTask(t.id)!.status).toBe("review");
  });

  it("HUD 手动建成的任务不是 headless 查询，不被自动收掉", () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    addInboxItems([
      { id: "S3:1", kind: "dm", channelId: "S3", channelName: "私聊", userId: "U3", userName: "千一", text: "在哪配", permalink: "p", ts: "1" },
    ]);
    markInboxDone("S3:1");
    const t = createTask({ title: "回答千一", kind: "verbal", source: { conversation: "S3:1", channelId: "S3" }, status: "review" });
    expect(settleQueryTasks()).toBe(0);
    expect(getTask(t.id)!.status).toBe("review");
  });
});

describe("挂过一天没动的 Slack 待决定", () => {
  it("归档，草稿作废，记一笔可撤销的账", async () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    let t = createTask({ title: "回答青禾", kind: "slack", source: { conversation: "S3:1", channelId: "S3" }, status: "review" });
    t = addPending(t.id, { type: "slack_reply", label: "回复青禾", detail: "草稿", payload: { channel: "S3", text: "草稿" } })!;
    await archiveStaleTasks(Date.parse(t.updatedAt) + STALE_MS + 1);
    const after = getTask(t.id)!;
    expect(after.status).toBe("ignored");
    expect(after.pending ?? []).toHaveLength(0);
  });

  it("不到一天的不动", async () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const t = createTask({ title: "回答松石", kind: "slack", source: { conversation: "S4:1", channelId: "S4" }, status: "review" });
    await archiveStaleTasks(Date.parse(t.updatedAt) + STALE_MS - 1000);
    expect(getTask(t.id)!.status).toBe("review");
  });

  it("挂着开工动作的不归档：事情本身还没做", async () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    let t = createTask({ title: "改个 bug", kind: "slack", source: { conversation: "S5:1", channelId: "S5" }, status: "review" });
    t = addPending(t.id, { type: "start_job", label: "开工", detail: "", payload: {} })!;
    await archiveStaleTasks(Date.parse(t.updatedAt) + STALE_MS + 1);
    expect(getTask(t.id)!.status).toBe("review");
  });
});
