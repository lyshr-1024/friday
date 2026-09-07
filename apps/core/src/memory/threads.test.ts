import { describe, expect, it } from "vitest";
import { addInboxItems } from "./inbox.js";
import { attachToThread, listThreads, previousBriefs, setThreadBrief, setThreadStatus, markAutoDone } from "./threads.js";
import { initMemory } from "./db.js";

const base = { kind: "dm" as const, channelId: "D9", channelName: "与 灵雨 的私聊", userId: "U9", userName: "灵雨", text: "x", permalink: "" };
const T0 = 1_760_000_000; // 秒

describe("线程聚合", () => {
  it("同一人 2 小时内并成一条，超过则新开；频道 @ 按频道+人分", () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const [a, b, c] = addInboxItems([
      { ...base, id: "D9:1", ts: String(T0) },
      { ...base, id: "D9:2", ts: String(T0 + 3600) },
      { ...base, id: "D9:3", ts: String(T0 + 3 * 3600 + 1) },
    ]);
    const t1 = attachToThread(a!, (T0 + 10) * 1000);
    expect(attachToThread(b!, (T0 + 3600) * 1000)).toBe(t1);
    const t2 = attachToThread(c!, (T0 + 3 * 3600 + 5) * 1000);
    expect(t2).not.toBe(t1);
    const [m1, m2] = addInboxItems([
      { ...base, id: "C1:1", kind: "mention", channelId: "C1", channelName: "#fe", ts: String(T0 + 100) },
      { ...base, id: "C2:1", kind: "mention", channelId: "C2", channelName: "#ops", ts: String(T0 + 200) },
    ]);
    expect(attachToThread(m1!, (T0 + 100) * 1000)).not.toBe(attachToThread(m2!, (T0 + 200) * 1000));
    const open = listThreads("open");
    expect(open).toHaveLength(4);
    expect(open.find((t) => t.id === t1)!.items.map((i) => i.id)).toEqual(["D9:1", "D9:2"]);
  });

  it("情境卡、历史情境、状态流转、自动写只做一次", () => {
    const [t1, t2] = listThreads("open").filter((t) => t.kind === "dm").map((t) => t.id).sort();
    setThreadBrief(t1!, { situation: "灵雨追问登录报错", needs: "看下报错", needsReply: true, urgency: "high", actions: [], context: [] }, "whale-console");
    expect(previousBriefs("U9", t2!)).toEqual(["灵雨追问登录报错"]);
    expect(listThreads("open").find((t) => t.id === t1)!.project).toBe("whale-console");
    expect(markAutoDone(t1!, "todo")).toBe(true);
    expect(markAutoDone(t1!, "todo")).toBe(false);
    expect(setThreadStatus(t1!, "done")).toBe(true);
    expect(listThreads("open").some((t) => t.id === t1)).toBe(false);
  });
});
