import { beforeEach, describe, expect, it, vi } from "vitest";
import { initMemory } from "../../memory/db.js";
import { addInboxItems } from "../../memory/inbox.js";
import { createTask } from "../../memory/tasks.js";
import { linkUp } from "../../memory/links.js";
import { slackNode, taskNode } from "../../memory/infer.js";
import { slackScene } from "./slack.js";

type Recent = { channelId?: string; lines: Array<{ ts: string; userName: string; text: string }> };
const channelMock = vi.fn(async (): Promise<Recent> => ({ lines: [] }));
const dmMock = vi.fn(async (): Promise<Recent> => ({ lines: [] }));
vi.mock("../../connectors/slack.js", () => ({
  loadSlackCreds: async () => ({ token: "t", cookie: "c" }),
  slackCaller: () => async () => ({}),
  slackSelfId: async () => "ME",
  fetchChannelRecent: (...a: unknown[]) => channelMock(...(a as [])),
  fetchDmRecent: (...a: unknown[]) => dmMock(...(a as [])),
}));

describe("HUD 在 Slack 前台", () => {
  beforeEach(() => {
    channelMock.mockReset().mockResolvedValue({ lines: [] });
    dmMock.mockReset().mockResolvedValue({ lines: [] });
    initMemory(process.env.FRIDAY_DATA_DIR!);
  });

  it("私聊也拉实时原文，主语句用屏幕上最新那条而不是库里那条", async () => {
    addInboxItems([{ id: "H1:1", kind: "dm", channelId: "D1", channelName: "与 Shawn 的私聊", userId: "U1", userName: "Shawn", text: "小需求应该可以", permalink: "p", ts: "100" }]);
    dmMock.mockResolvedValue({
      channelId: "D1",
      lines: [
        { ts: "900", userName: "Shawn", text: "请问这个需求你正在开发当中吗？" },
        { ts: "901", userName: "我", text: "我这周尽量做一下" },
        { ts: "902", userName: "Shawn", text: "感谢感谢" },
      ],
    });
    const scene = (await slackScene(undefined, "Shawn"))!;
    expect(dmMock).toHaveBeenCalled();
    expect(scene.text).toBe("感谢感谢");
    expect(scene.recent).toHaveLength(3);
    expect(scene.conv).toBe("D1:902");
  });

  it("频道的主语句同样跟着屏幕走，不被库里的旧消息顶掉", async () => {
    addInboxItems([{ id: "H2:1", kind: "mention", channelId: "C1", channelName: "team-fe-bo", userId: "U2", userName: "拂晓", text: "三天前 @ 我的那条", permalink: "p", ts: "100" }]);
    channelMock.mockResolvedValue({
      channelId: "C1",
      lines: [
        { ts: "900", userName: "佳成", text: "菜单去掉 anyOf" },
        { ts: "901", userName: "浩然", text: "没有人在用了" },
      ],
    });
    const scene = (await slackScene("#team-fe-bo", undefined))!;
    expect(scene.text).toBe("没有人在用了");
    expect(scene.conv).toBe("C1:901");
  });

  it("拉不到实时时退回库里那条，仍能给出 scene 和挂着的任务", async () => {
    addInboxItems([{ id: "H3:1", kind: "mention", channelId: "H3", channelName: "team-fallback", userId: "U3", userName: "拂晓", text: "验收问题改一下", permalink: "p", ts: "100" }]);
    const t = createTask({ title: "养牛活动验收", kind: "meegle", source: {}, status: "processing" });
    linkUp(slackNode("H3:100"), taskNode(t.id), "rule", "x");
    const scene = (await slackScene("#team-fallback", undefined))!;
    expect(scene.conv).toBe("H3:100");
    expect(scene.taskId).toBe(t.id);
    expect(scene.text).toContain("验收问题");
  });

  it("实时拿到的对话挂着任务时也要找出来", async () => {
    const t = createTask({ title: "多语言字段", kind: "meegle", source: {}, status: "processing" });
    linkUp(slackNode("D9:902"), taskNode(t.id), "user", "x");
    dmMock.mockResolvedValue({ channelId: "D9", lines: [{ ts: "902", userName: "Shawn", text: "催排期" }] });
    expect((await slackScene(undefined, "Shawn"))?.taskId).toBe(t.id);
  });

  it("库里带 # 的频道名也能对上不带 # 的标题", async () => {
    addInboxItems([{ id: "H5:1", kind: "mention", channelId: "H5", channelName: "#proj-推荐feed页迭代", userId: "U5", userName: "佳成", text: "这个下周能出吗", permalink: "p", ts: "500" }]);
    expect((await slackScene("proj-推荐feed页迭代", undefined))?.conv).toBe("H5:500");
    expect((await slackScene("#proj-推荐feed页迭代", undefined))?.conv).toBe("H5:500");
  });

  it("显示名带英文后缀也能对上", async () => {
    addInboxItems([{ id: "H4:1", kind: "dm", channelId: "H4", channelName: "与 拂晓 (Chen Xiaofu) 的私聊", userId: "U4", userName: "拂晓 (Chen Xiaofu)", text: "那个改了吗", permalink: "p", ts: "400" }]);
    expect((await slackScene(undefined, "拂晓"))?.conv).toBe("H4:400");
    expect((await slackScene(undefined, "拂晓 (Chen Xiaofu)"))?.conv).toBe("H4:400");
  });

  it("实时消息里的账号名换成熟悉的显示名", async () => {
    addInboxItems([{ id: "H8:1", kind: "dm", channelId: "H8", channelName: "与 佳成 (Zhou Jiacheng) 的私聊", userId: "U8", userName: "佳成 (Zhou Jiacheng)", text: "在", permalink: "p", ts: "800" }]);
    channelMock.mockResolvedValue({
      channelId: "C88",
      lines: [
        { ts: "880", userName: "jiacheng.zhou", text: "菜单去掉 anyOf" },
        { ts: "881", userName: "someone.else", text: "收到" },
      ],
    });
    const scene = (await slackScene("team-name-book", undefined))!;
    expect(scene.recent?.[0]?.userName).toBe("佳成 (Zhou Jiacheng)");
    expect(scene.recent?.[1]?.userName).toBe("someone.else");
  });

  it("查不到返回 undefined", async () => {
    expect(await slackScene(undefined, "查无此人")).toBeUndefined();
  });
});
