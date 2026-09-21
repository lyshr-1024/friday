import { describe, expect, it } from "vitest";
import { app } from "./index.js";
import { initMemory } from "../memory/db.js";
import { addInboxItems } from "../memory/inbox.js";
import { createTask, getTask } from "../memory/tasks.js";
import { neighbors } from "../memory/links.js";
import { slackNode } from "../memory/infer.js";

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
