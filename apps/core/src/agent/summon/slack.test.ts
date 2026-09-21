import { describe, expect, it } from "vitest";
import { initMemory } from "../../memory/db.js";
import { addInboxItems } from "../../memory/inbox.js";
import { createTask } from "../../memory/tasks.js";
import { linkUp } from "../../memory/links.js";
import { slackNode, taskNode } from "../../memory/infer.js";
import { slackScene } from "./slack.js";

describe("HUD 在 Slack 前台", () => {
  it("按频道名找到最近一段对话和它挂着的任务", () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    addInboxItems([{ id: "H1:1", kind: "mention", channelId: "H1", channelName: "team-fe-bo", userId: "U1", userName: "拂晓", text: "验收问题改一下", permalink: "p", ts: "100" }]);
    const t = createTask({ title: "养牛活动验收", kind: "meegle", source: {}, status: "processing" });
    linkUp(slackNode("H1:100"), taskNode(t.id), "rule", "x");

    const scene = slackScene("#team-fe-bo", undefined)!;
    expect(scene.conv).toBe("H1:100");
    expect(scene.taskId).toBe(t.id);
    expect(scene.text).toContain("验收问题");
  });

  it("按人名找私聊", () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    addInboxItems([{ id: "H2:1", kind: "dm", channelId: "H2", channelName: "与柠萌的私聊", userId: "U2", userName: "柠萌", text: "导出那个", permalink: "p", ts: "200" }]);
    expect(slackScene(undefined, "柠萌")?.conv).toBe("H2:200");
  });

  it("没挂任务时 taskId 为空但对话还在", () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    addInboxItems([{ id: "H3:1", kind: "dm", channelId: "H3", channelName: "与夕瑶的私聊", userId: "U3", userName: "夕瑶", text: "在吗", permalink: "p", ts: "300" }]);
    const scene = slackScene(undefined, "夕瑶")!;
    expect(scene.taskId).toBeUndefined();
    expect(scene.conv).toBe("H3:300");
  });

  it("查不到返回 undefined", () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    expect(slackScene(undefined, "查无此人")).toBeUndefined();
  });
});
