import { beforeEach, describe, expect, it, vi } from "vitest";
import { initMemory } from "../../memory/db.js";
import { addInboxItems } from "../../memory/inbox.js";
import { createTask } from "../../memory/tasks.js";
import { linkUp } from "../../memory/links.js";
import { slackNode, taskNode } from "../../memory/infer.js";
import { slackScene } from "./slack.js";

const recentMock = vi.fn(async () => ({ lines: [] as Array<{ ts: string; userName: string; text: string }> }));
vi.mock("../../connectors/slack.js", () => ({
  loadSlackCreds: async () => ({ token: "t", cookie: "c" }),
  slackCaller: () => async () => ({}),
  fetchChannelRecent: (...a: unknown[]) => recentMock(...(a as [])),
}));

describe("HUD 在 Slack 前台", () => {
  beforeEach(() => recentMock.mockReset().mockResolvedValue({ lines: [] }));

  it("按频道名找到最近一段对话和它挂着的任务", async () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    addInboxItems([{ id: "H1:1", kind: "mention", channelId: "H1", channelName: "team-fe-bo", userId: "U1", userName: "拂晓", text: "验收问题改一下", permalink: "p", ts: "100" }]);
    const t = createTask({ title: "养牛活动验收", kind: "meegle", source: {}, status: "processing" });
    linkUp(slackNode("H1:100"), taskNode(t.id), "rule", "x");

    const scene = (await slackScene("#team-fe-bo", undefined))!;
    expect(scene.conv).toBe("H1:100");
    expect(scene.taskId).toBe(t.id);
    expect(scene.text).toContain("验收问题");
  });

  it("按人名找私聊", async () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    addInboxItems([{ id: "H2:1", kind: "dm", channelId: "H2", channelName: "与柠萌的私聊", userId: "U2", userName: "柠萌", text: "导出那个", permalink: "p", ts: "200" }]);
    expect((await slackScene(undefined, "柠萌"))?.conv).toBe("H2:200");
  });

  it("没挂任务时 taskId 为空但对话还在", async () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    addInboxItems([{ id: "H3:1", kind: "dm", channelId: "H3", channelName: "与夕瑶的私聊", userId: "U3", userName: "夕瑶", text: "在吗", permalink: "p", ts: "300" }]);
    const scene = (await slackScene(undefined, "夕瑶"))!;
    expect(scene.taskId).toBeUndefined();
    expect(scene.conv).toBe("H3:300");
  });

  it("查不到返回 undefined", async () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    expect(await slackScene(undefined, "查无此人")).toBeUndefined();
  });

  // 库里的频道名带 #（同步时那么存的），窗口标题里不带——只剥一边等于永远对不上
  it("库里带 # 的频道名也能对上不带 # 的标题", async () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    addInboxItems([{ id: "H5:1", kind: "mention", channelId: "H5", channelName: "#proj-推荐feed页迭代", userId: "U5", userName: "佳成", text: "这个下周能出吗", permalink: "p", ts: "500" }]);
    expect((await slackScene("proj-推荐feed页迭代", undefined))?.conv).toBe("H5:500");
    expect((await slackScene("#proj-推荐feed页迭代", undefined))?.conv).toBe("H5:500");
  });

  // Slack 显示名普遍是「中文名 (English Name)」，而窗口标题带未读数时只剩中文名，
  // 严格相等会永远匹配不上——真机上就是这么漏的
  it("显示名带英文后缀也能对上", async () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    addInboxItems([{ id: "H4:1", kind: "dm", channelId: "H4", channelName: "与 拂晓 (Chen Xiaofu) 的私聊", userId: "U4", userName: "拂晓 (Chen Xiaofu)", text: "那个改了吗", permalink: "p", ts: "400" }]);
    expect((await slackScene(undefined, "拂晓"))?.conv).toBe("H4:400");
    expect((await slackScene(undefined, "拂晓 (Chen Xiaofu)"))?.conv).toBe("H4:400");
  });

  it("本地一条都没有，但频道里有实时消息时照样给出 scene", async () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    recentMock.mockResolvedValue({
      channelId: "C9",
      lines: [
        { ts: "900", userName: "佳成", text: "菜单去掉 anyOf" },
        { ts: "901", userName: "浩然", text: "没有人在用了" },
      ],
    } as never);
    const scene = (await slackScene("#team-no-local", undefined))!;
    expect(scene.conv).toBe("C9:901");
    expect(scene.text).toBe("没有人在用了");
    expect(scene.channelName).toBe("#team-no-local");
    expect(scene.recent).toHaveLength(2);
  });

  it("私聊不拉实时消息", async () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    addInboxItems([{ id: "H6:1", kind: "dm", channelId: "H6", channelName: "与阿吉的私聊", userId: "U6", userName: "阿吉", text: "在", permalink: "p", ts: "600" }]);
    await slackScene(undefined, "阿吉");
    expect(recentMock).not.toHaveBeenCalled();
  });
});