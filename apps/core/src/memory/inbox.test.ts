import { describe, expect, it } from "vitest";
import { addInboxItems, listInbox, markInboxDone, setTriage } from "./inbox.js";
import { initMemory } from "./db.js";

const base = { kind: "dm" as const, channelId: "D1", channelName: "与 A 的私聊", userId: "U9", userName: "A", text: "hi", permalink: "https://s/1" };

describe("收件箱", () => {
  it("重复消息不重复插入，可标记完成，预处理结果可回读", () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const a = addInboxItems([{ ...base, id: "D1:1", ts: "1" }, { ...base, id: "D1:2", ts: "2" }]);
    expect(a).toHaveLength(2);
    expect(addInboxItems([{ ...base, id: "D1:1", ts: "1" }])).toHaveLength(0);
    setTriage("D1:2", { needsReply: true, urgency: "high", summary: "要回" });
    expect(listInbox().map((i) => i.id)).toEqual(["D1:2", "D1:1"]);
    expect(listInbox()[0]!.triage?.urgency).toBe("high");
    expect(markInboxDone("D1:1")).toBe(true);
    expect(listInbox().map((i) => i.id)).toEqual(["D1:2"]);
  });
});
