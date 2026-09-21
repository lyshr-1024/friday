import { describe, expect, it } from "vitest";
import { initMemory } from "../../memory/db.js";
import { addInboxItems, markInboxDone } from "../../memory/inbox.js";
import { addPending, createTask, getTask } from "../../memory/tasks.js";
import { settleQueryTasks } from "./settle.js";

describe("你自己在 Slack 回了", () => {
  it("挂着的查询任务收掉、草稿撤下", () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    addInboxItems([
      { id: "S1:1", kind: "dm", channelId: "S1", channelName: "私聊", userId: "U1", userName: "拂晓", text: "在哪配", permalink: "p", ts: "1" },
    ]);
    markInboxDone("S1:1");
    let t = createTask({ title: "回答拂晓", kind: "slack", source: { conversation: "S1:1", channelId: "S1" }, status: "review" });
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
    const t = createTask({ title: "回答夕瑶", kind: "slack", source: { conversation: "S2:1", channelId: "S2" }, status: "review" });
    settleQueryTasks();
    expect(getTask(t.id)!.status).toBe("review");
  });
});
