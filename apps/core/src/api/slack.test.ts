import { describe, expect, it } from "vitest";
import { app } from "./index.js";
import { initMemory } from "../memory/db.js";
import { addInboxItems } from "../memory/inbox.js";
import { createTask, getTask } from "../memory/tasks.js";
import { neighbors } from "../memory/links.js";
import { channelNode, slackNode } from "../memory/infer.js";

describe("Slack 挂靠接口", () => {
  it("手动挂上去，再摘掉", async () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    addInboxItems([{ id: "A1:1", kind: "dm", channelId: "A1", channelName: "私聊", userId: "U1", userName: "拂晓", text: "改一下", permalink: "p", ts: "1" }]);
    const t = createTask({ title: "养牛活动验收", kind: "meegle", source: {}, status: "understood" });

    const up = await app.request(`/slack/${encodeURIComponent("A1:1")}/attach`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId: t.id }),
    });
    expect(up.status).toBe(200);
    expect(neighbors(slackNode("A1:1"), "task").map((n) => n.ref)).toContain(t.id);

    const down = await app.request(`/slack/${encodeURIComponent("A1:1")}/attach/${t.id}`, { method: "DELETE" });
    expect(down.status).toBe(200);
    expect(neighbors(slackNode("A1:1"), "task").map((n) => n.ref)).not.toContain(t.id);
  });

  it("摘掉之后自动推断不会再把它连回来", async () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    addInboxItems([{ id: "A2:1", kind: "dm", channelId: "A2", channelName: "私聊", userId: "U2", userName: "夕瑶", text: "x", permalink: "p", ts: "1" }]);
    const t = createTask({ title: "别的事", kind: "meegle", source: {}, status: "understood" });
    await app.request(`/slack/${encodeURIComponent("A2:1")}/attach`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId: t.id }),
    });
    await app.request(`/slack/${encodeURIComponent("A2:1")}/attach/${t.id}`, { method: "DELETE" });

    const { candidateTasks } = await import("../agent/slack/attach.js");
    expect(candidateTasks("A2:1", [getTask(t.id)!]).map((x) => x.id)).not.toContain(t.id);
  });

  it("把一段对话建成任务", async () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    addInboxItems([{ id: "A3:1", kind: "dm", channelId: "A3", channelName: "私聊", userId: "U3", userName: "柠萌", text: "帮忙看下导出", permalink: "p", ts: "1" }]);
    const r = await app.request(`/slack/${encodeURIComponent("A3:1")}/task`, { method: "POST" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { id: string; title: string };
    expect(body.title).toContain("导出");
    expect(neighbors(slackNode("A3:1"), "task").map((n) => n.ref)).toContain(body.id);
  });

  it("对话不存在给 404", async () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const r = await app.request(`/slack/${encodeURIComponent("Z9:9")}/task`, { method: "POST" });
    expect(r.status).toBe(404);
  });
});

describe("频道挂靠接口", () => {
  it("把一个频道登记到需求上，再取消", async () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const t = createTask({ title: "养牛计划1.0", kind: "meegle", source: {}, status: "understood" });

    const up = await app.request(`/slack/channel/${encodeURIComponent("一起养牛")}/task`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId: t.id }),
    });
    expect(up.status).toBe(200);
    expect(neighbors(channelNode("一起养牛"), "task").map((n) => n.ref)).toContain(t.id);

    const down = await app.request(`/slack/channel/${encodeURIComponent("一起养牛")}/task/${t.id}`, { method: "DELETE" });
    expect(down.status).toBe(200);
    expect(neighbors(channelNode("一起养牛"), "task").map((n) => n.ref)).not.toContain(t.id);
  });

  it("频道名带不带 # 都是同一个", async () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const t = createTask({ title: "导出中心", kind: "meegle", source: {}, status: "understood" });
    await app.request(`/slack/channel/${encodeURIComponent("#导出中心-需求")}/task`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId: t.id }),
    });
    expect(neighbors(channelNode("导出中心-需求"), "task").map((n) => n.ref)).toContain(t.id);
  });

  it("任务不存在给 404", async () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const r = await app.request(`/slack/channel/${encodeURIComponent("一起养牛")}/task`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId: "nope" }),
    });
    expect(r.status).toBe(404);
  });

  it("列出出现过的频道和它们的挂靠", async () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    addInboxItems([
      { id: "C5:1", kind: "mention", channelId: "C5", channelName: "#一起养牛", userId: "U1", userName: "拂晓", text: "验收问题改一波", permalink: "p", ts: "1" },
      { id: "C5:2", kind: "mention", channelId: "C5", channelName: "#一起养牛", userId: "U1", userName: "拂晓", text: "再看看", permalink: "p", ts: "2" },
      { id: "C6:1", kind: "dm", channelId: "C6", channelName: "私聊", userId: "U2", userName: "夕瑶", text: "x", permalink: "p", ts: "3" },
    ]);
    const t = createTask({ title: "养牛计划1.0", kind: "meegle", source: {}, status: "understood" });
    await app.request(`/slack/channel/${encodeURIComponent("一起养牛")}/task`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId: t.id }),
    });

    const r = await app.request("/slack/channels");
    const { channels } = (await r.json()) as { channels: Array<{ name: string; taskId?: string; taskTitle?: string; messageCount: number }> };
    const cow = channels.find((x) => x.name === "一起养牛");
    expect(cow?.messageCount).toBe(2);
    expect(cow?.taskId).toBe(t.id);
    expect(cow?.taskTitle).toBe("养牛计划1.0");
    expect(channels.some((x) => x.name === "私聊")).toBe(false);
  });
});
