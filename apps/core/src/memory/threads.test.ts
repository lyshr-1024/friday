import { describe, expect, it } from "vitest";
import { addInboxItems, markInboxDone } from "./inbox.js";
import { attachToThread, closeSettledThreads, getThread, listThreads, previousBriefs, setThreadBrief, setThreadStatus, markAutoDone, threadItems } from "./threads.js";
import { createTask } from "./tasks.js";
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

  it("超出 2 小时的灰区：判定同一件事才接续，不判就照旧新开", () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const DAY = 24 * 3600 * 1000;
    const g = { ...base, kind: "mention" as const, channelId: "C7", channelName: "#一起养牛", userId: "U7", userName: "拂晓" };
    const [first, chase, other, late] = addInboxItems([
      { ...g, id: "C7:1", ts: String(T0), text: "验收问题先改一波" },
      { ...g, id: "C7:2", ts: String(T0 + 4 * 3600), text: "抽空验收问题改一改" },
      { ...g, id: "C7:3", ts: String(T0 + 5 * 3600), text: "另外下周的排期也发我下" },
      { ...g, id: "C7:4", ts: String(T0 + 30 * 3600), text: "验收问题改完了吗" },
    ]);
    const t1 = attachToThread(first!, (T0 + 1) * 1000);
    // 隔 4 小时但在说同一件事 → 接回原线程
    expect(attachToThread(chase!, (T0 + 4 * 3600) * 1000, { graceMs: DAY, sameTopic: () => true })).toBe(t1);
    // 同样在灰区，但不是同一件事 → 新开
    expect(attachToThread(other!, (T0 + 5 * 3600) * 1000, { graceMs: DAY, sameTopic: () => false })).not.toBe(t1);
    // 超过宽限期，判断都不该被调用
    let asked = false;
    attachToThread(late!, (T0 + 30 * 3600) * 1000, { graceMs: DAY, sameTopic: () => ((asked = true), true) });
    expect(asked).toBe(false);
    // 不传 opts 时保持原来的纯时间行为
    const [plain] = addInboxItems([{ ...g, id: "C7:5", ts: String(T0 + 31 * 3600), text: "再问一次" }]);
    expect(attachToThread(plain!, (T0 + 31 * 3600) * 1000)).not.toBe(t1);
  });

  it("情境卡、历史情境、状态流转、自动写只做一次", () => {
    const [t1, t2] = listThreads("open").filter((t) => t.kind === "dm").map((t) => t.id).sort();
    setThreadBrief(t1!, { situation: "灵雨追问登录报错", needs: "看下报错", needsReply: true, urgency: "high", context: [] }, "whale-console");
    expect(previousBriefs("U9", t2!)).toEqual(["灵雨追问登录报错"]);
    expect(listThreads("open").find((t) => t.id === t1)!.project).toBe("whale-console");
    expect(markAutoDone(t1!, "todo")).toBe(true);
    expect(markAutoDone(t1!, "todo")).toBe(false);
    expect(setThreadStatus(t1!, "done")).toBe(true);
    expect(listThreads("open").some((t) => t.id === t1)).toBe(false);
  });
});

describe("收工之后不再把旧消息当新事", () => {
  const G = { kind: "mention" as const, channelId: "C8", channelName: "#养牛", permalink: "" };

  // 这条守的是根因②的前提：openCandidate 只认 open 线程。行为本来就对，
  // 但「任务收工要连带关线程」的改动正是靠它才成立，塌了就会静默退回重复建任务。
  it("线程收工后同一个人的新消息另起一条线程，不接回已关的那条", () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const u = { ...G, userId: "U8", userName: "拂晓" };
    const [a, b] = addInboxItems([
      { ...u, id: "C8:1", ts: String(T0), text: "验收问题先改一波" },
      { ...u, id: "C8:2", ts: String(T0 + 600), text: "另外发布也安排下" },
    ]);
    const t1 = attachToThread(a!, (T0 + 1) * 1000);
    setThreadStatus(t1, "done");
    expect(attachToThread(b!, (T0 + 600) * 1000)).not.toBe(t1);
  });

  it("线程做功课只看还没处理的消息，已收工的旧消息不再进情境卡", () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const u = { ...G, userId: "U82", userName: "阿力" };
    const [old, fresh] = addInboxItems([
      { ...u, id: "C8:9", ts: String(T0), text: "上周那个验收问题" },
      { ...u, id: "C8:10", ts: String(T0 + 600), text: "今天的新问题" },
    ]);
    const id = attachToThread(old!, (T0 + 1) * 1000);
    attachToThread(fresh!, (T0 + 600) * 1000);
    markInboxDone(old!.id);
    expect(threadItems(id).map((i) => i.id)).toEqual(["C8:10"]);
  });
});

describe("历史遗留线程回填", () => {
  it("任务已全部收工的线程标成 done，还有在办任务的和没任务的都不动", () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const G = { kind: "mention" as const, channelId: "CB", channelName: "#回填", permalink: "" };
    const mk = (uid: string, id: string) => {
      const [it] = addInboxItems([{ ...G, userId: uid, userName: uid, id, ts: String(T0), text: "x" }]);
      return attachToThread(it!, (T0 + 1) * 1000);
    };
    const closed = mk("UA", "CB:1");
    const live = mk("UB", "CB:2");
    const bare = mk("UC", "CB:3");
    createTask({ title: "已收工", kind: "slack", source: { threadId: closed }, status: "done" });
    createTask({ title: "也收工了", kind: "slack", source: { threadId: closed }, status: "ignored" });
    createTask({ title: "还在办", kind: "slack", source: { threadId: live }, status: "understood" });

    expect(closeSettledThreads()).toBe(1);
    expect(getThread(closed)!.status).toBe("done");
    expect(getThread(live)!.status).toBe("open");
    expect(getThread(bare)!.status).toBe("open");
    expect(closeSettledThreads()).toBe(0);
  });
});
