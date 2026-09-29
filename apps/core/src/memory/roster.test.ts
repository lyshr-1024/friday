import { beforeEach, describe, expect, it } from "vitest";
import { initMemory } from "./db.js";
import { addInboxItems, listInbox, setCursor, setPrior } from "./inbox.js";
import { priorText } from "./roster.js";

const base = { permalink: "p", text: "hi" };

describe("前文显示人名", () => {
  beforeEach(() => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    setCursor("slack:me", "UME");
  });

  it("私聊：自己是「你」，对方是私聊对象的显示名，不查任何接口", () => {
    const out = priorText(
      [
        { ts: "1", userId: "UME", userName: "", text: "在吗" },
        { ts: "2", userId: "UZL", userName: "", text: "在的" },
      ],
      { kind: "dm", peer: "张亮 (Zhang Liang)" },
    );
    expect(out).toEqual(["你：在吗", "张亮 (Zhang Liang)：在的"]);
  });

  it("频道：花名册命中显示名，查不到写「未知成员」，不出现 ID", () => {
    addInboxItems([{ ...base, id: "C1:1", kind: "mention", channelId: "C1", channelName: "fe-dev", userId: "U092UA21P6D", userName: "佳成 (Zhou Jiacheng)", ts: "1" }]);
    const out = priorText(
      [
        { ts: "1", userId: "U092UA21P6D", userName: "", text: "现在 C 用的是" },
        { ts: "2", userId: "U092U9WDXMF", userName: "", text: "是一个 ref 吗？" },
        { ts: "3", userId: "UME", userName: "", text: "对" },
      ],
      { kind: "mention" },
    );
    expect(out).toEqual(["佳成 (Zhou Jiacheng)：现在 C 用的是", "未知成员：是一个 ref 吗？", "你：对"]);
    expect(out.join("")).not.toMatch(/U092/);
  });

  it("入库时已经解析出的名字可用，ID 形状的名字不算名字", () => {
    const out = priorText(
      [
        { ts: "1", userId: "UX1", userName: "灵雨", text: "a" },
        { ts: "2", userId: "UX2", userName: "UX2ABCDEFGH", text: "b" },
        { ts: "3", userName: "机器人", text: "c" },
      ],
      { kind: "mention" },
    );
    expect(out).toEqual(["灵雨：a", "未知成员：b", "机器人：c"]);
  });

  it("旧数据（字符串数组）能读：带 ID 前缀的按 ID 换名，其余原样显示", () => {
    addInboxItems([{ ...base, id: "C9:1", kind: "mention", channelId: "C9", channelName: "x", userId: "U092UA21P6D", userName: "佳成 (Zhou Jiacheng)", ts: "9" }]);
    addInboxItems([{ ...base, id: "C9:2", kind: "mention", channelId: "C9", channelName: "x", userId: "U1", userName: "A", ts: "10" }]);
    const d = listInbox(true, 10).find((i) => i.id === "C9:2")!;
    setPrior(d.id, ["U092UA21P6D：现在 C 用的是 …", "纯文本旧行"] as never);
    const item = listInbox(true, 10).find((i) => i.id === "C9:2")!;
    expect(priorText(item.prior ?? [], { kind: "mention" })).toEqual(["佳成 (Zhou Jiacheng)：现在 C 用的是 …", "纯文本旧行"]);
  });
});
