import { describe, expect, it } from "vitest";
import { fetchContext, fetchSlack, permalinkFor } from "./slack.js";

const responses: Record<string, unknown> = {
  "search.messages": {
    messages: {
      matches: [
        { ts: "1757000300.000100", text: "<@U1> 帮看下登录报错", user: "U2", username: "灵雨", permalink: "https://s/p1", channel: { id: "C1", name: "fe-dev" } },
        { ts: "1757000100.000100", text: "旧的", user: "U2", channel: { id: "C1", name: "fe-dev" } },
        { ts: "1757000400.000100", text: "我自己的", user: "U1", channel: { id: "C1", name: "fe-dev" } },
      ],
    },
  },
  "client.counts": { ims: [{ id: "D1", has_unreads: true, latest: "1757000500.000100" }, { id: "D2", has_unreads: false, latest: "1757000600.000100" }] },
  "conversations.history": {
    messages: [
      { ts: "1757000500.000100", text: "在吗", user: "U3" },
      { ts: "1757000450.000100", text: "join", user: "U3", subtype: "channel_join" },
      { ts: "1757000460.000100", text: "Meegle 通知", user: "UBOT", bot_id: "B1" },
    ],
  },
  "users.info": { user: { real_name: "小明" } },
  "chat.getPermalink": { permalink: "https://s/dm1" },
};
const calls: string[] = [];
const call = async (method: string) => {
  calls.push(method);
  return responses[method] as Record<string, unknown>;
};

describe("Slack 拉取", () => {
  it("只取游标之后、不是自己发的 @ 与私聊，并给出新游标", async () => {
    const res = await fetchSlack(call, "U1", { "slack:mentions": "1757000200.000000" }, 1757000700_000);
    expect(res.items.map((i) => [i.kind, i.userName, i.text])).toEqual([
      ["mention", "灵雨", "<@U1> 帮看下登录报错"],
      ["dm", "小明", "在吗"],
    ]);
    expect(res.items[0]!.channelName).toBe("#fe-dev");
    expect(res.items[1]!.permalink).toBe("https://s/dm1");
    expect(res.cursors).toEqual({ "slack:mentions": "1757000300.000100", "slack:im:D1": "1757000500.000100" });
    expect(calls.filter((m) => m === "conversations.history")).toHaveLength(1);
  });
});

describe("冷启动", () => {
  it("没有游标时只取最近 24 小时的消息", async () => {
    const res = await fetchSlack(call, "U1", {}, 1757000700_000 + 24 * 3600 * 1000 + 1);
    expect(res.items).toHaveLength(0);
    const recent = await fetchSlack(call, "U1", {}, 1757000700_000);
    expect(recent.items.length).toBeGreaterThan(0);
  });
});

describe("补拉对话上下文", () => {
  const item = { channelId: "C1", ts: "1757000300.000100" };
  const nameOf = async (id: string) => (id === "U2" ? "灵雨" : id);

  it("不在 thread 里就拉频道前文，只留这条之前的、去掉空消息", async () => {
    const seen: Array<Record<string, string>> = [];
    const c = async (method: string, params: Record<string, string>) => {
      seen.push({ method, ...params });
      return {
        messages: [
          { ts: "1757000100.000100", text: "多级标题在 iOS 上错位了", user: "U2" },
          { ts: "1757000150.000100", text: "<@U9> has joined the channel", user: "U9", subtype: "channel_join" },
          { ts: "1757000200.000100", text: "   ", user: "U2" },
          { ts: "1757000300.000100", text: "你看看志华遗留的这个问题", user: "U2" },
          { ts: "1757000400.000100", text: "这条在它之后", user: "U2" },
        ],
      } as Record<string, unknown>;
    };
    const ctx = await fetchContext(c, item, nameOf);
    expect(ctx.map((l) => l.text)).toEqual(["多级标题在 iOS 上错位了"]);
    expect(ctx[0]!.userName).toBe("灵雨");
    expect(seen[0]!.method).toBe("conversations.history");
    expect(seen[0]!.latest).toBe(item.ts);
  });

  it("在 thread 里就拉整个 thread", async () => {
    const seen: string[] = [];
    const c = async (method: string) => {
      seen.push(method);
      return { messages: [{ ts: "1757000050.000100", text: "这个需求怎么排", user: "U2" }] } as Record<string, unknown>;
    };
    const ctx = await fetchContext(c, { ...item, threadTs: "1757000050.000100" }, nameOf);
    expect(seen).toEqual(["conversations.replies"]);
    expect(ctx.map((l) => l.text)).toEqual(["这个需求怎么排"]);
  });

  it("拉不到就当没有前文，不让整条消息处理失败", async () => {
    const c = async () => {
      throw new Error("Slack conversations.history 失败：not_in_channel");
    };
    await expect(fetchContext(c, item, nameOf)).resolves.toEqual([]);
  });

  it("最多留 limit 条，取离它最近的", async () => {
    const c = async () =>
      ({ messages: Array.from({ length: 20 }, (_, i) => ({ ts: `17570000${String(i).padStart(2, "0")}.000100`, text: `第${i}条`, user: "U2" })) }) as Record<string, unknown>;
    const ctx = await fetchContext(c, { channelId: "C1", ts: "1757000099.000000" }, nameOf, 3);
    expect(ctx.map((l) => l.text)).toEqual(["第17条", "第18条", "第19条"]);
  });
});

describe("thread_ts 留存", () => {
  it("thread 里的回复记下根 ts，非 thread 消息不记", async () => {
    const withThread: Record<string, unknown> = {
      ...responses,
      "search.messages": {
        messages: {
          matches: [
            { ts: "1757000300.000100", text: "在 thread 里", user: "U2", username: "灵雨", channel: { id: "C1", name: "fe-dev" }, thread_ts: "1757000050.000100" },
            { ts: "1757000310.000100", text: "不在 thread 里", user: "U2", username: "灵雨", channel: { id: "C1", name: "fe-dev" }, thread_ts: "1757000310.000100" },
          ],
        },
      },
    };
    const c = async (method: string) => withThread[method] as Record<string, unknown>;
    const res = await fetchSlack(c, "U1", { "slack:mentions": "1757000200.000000" }, 1757000700_000);
    const inThread = res.items.find((i) => i.text === "在 thread 里")!;
    const notInThread = res.items.find((i) => i.text === "不在 thread 里")!;
    expect(inThread.threadTs).toBe("1757000050.000100");
    // thread_ts 等于自己的 ts 说明它是根消息，不算回复
    expect(notInThread.threadTs).toBeUndefined();
  });
});

describe("permalink 兜底", () => {
  it("getPermalink 失败时按团队域名拼官方格式链接", async () => {
    const failing = async (method: string) => {
      if (method === "chat.getPermalink") throw new Error("Slack chat.getPermalink 失败：channel_not_found");
      return responses[method] as Record<string, unknown>;
    };
    const res = await fetchSlack(failing, "U1", { "slack:mentions": "1757000200.000000" }, 1757000700_000, "https://acme.slack.com/");
    const dm = res.items.find((i) => i.kind === "dm")!;
    expect(dm.permalink).toBe("https://acme.slack.com/archives/D1/p1757000500000100");
    expect(permalinkFor(undefined, "D1", "1.2")).toBe("");
  });
});
