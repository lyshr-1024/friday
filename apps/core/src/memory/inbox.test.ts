import { describe, expect, it } from "vitest";
import { addInboxItems, listInbox, markInboxDone, setSlackTeam, setTriage, sweepRepliedInbox } from "./inbox.js";
import { initMemory } from "./db.js";

const base = { kind: "dm" as const, channelId: "D1", channelName: "与 A 的私聊", userId: "U9", userName: "A", text: "hi", permalink: "https://s/1" };

describe("收件箱", () => {
  it("重复消息不重复插入，可标记完成，预处理结果可回读", () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const a = addInboxItems([{ ...base, id: "D1:1", ts: "1" }, { ...base, id: "D1:2", ts: "2" }]);
    expect(a).toHaveLength(2);
    expect(addInboxItems([{ ...base, id: "D1:1", ts: "1" }])).toHaveLength(0);
    setTriage("D1:2", { needsReply: true, urgency: "high", summary: "要回" , category: "question" });
    expect(listInbox().map((i) => i.id)).toEqual(["D1:2", "D1:1"]);
    expect(listInbox()[0]!.triage?.urgency).toBe("high");
    expect(markInboxDone("D1:1")).toBe(true);
    expect(listInbox().map((i) => i.id)).toEqual(["D1:2"]);
  });
});

describe("Slack 深链", () => {
  it("知道团队 ID 后每条消息带 slack:// 链接", () => {
    setSlackTeam("T123");
    const item = listInbox(true).find((i) => i.id === "D1:2")!;
    expect(item.appLink).toBe("slack://channel?team=T123&id=D1&message=2");
  });
});

// 入口拦截是这次才加的，库里还积着一批「我早就在 Slack 里回过、Friday 还挂着」的消息：
// 实测 58 条未处理私聊里 41 条属于这种。补标已处理，连带收掉它们的任务和线程。
describe("已在 Slack 回过的存量消息", () => {
  it("我回过的标成已处理，没回过的原样留着", async () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    addInboxItems([
      { ...base, id: "D5:1", channelId: "D5", ts: "1757000100" },
      { ...base, id: "D5:2", channelId: "D5", ts: "1757000200" },
    ]);
    const n = await sweepRepliedInbox(async (item) => item.id === "D5:1");
    expect(n).toBe(1);
    const open = listInbox().map((i) => i.id);
    expect(open).toContain("D5:2");
    expect(open).not.toContain("D5:1");
  });

  it("查不出来的（接口报错）当作没回，不误标", async () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    addInboxItems([{ ...base, id: "D6:1", channelId: "D6", ts: "1757000300" }]);
    const n = await sweepRepliedInbox(async () => { throw new Error("token 过期"); });
    expect(n).toBe(0);
    expect(listInbox().map((i) => i.id)).toContain("D6:1");
  });
});
