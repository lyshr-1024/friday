import { describe, expect, it } from "vitest";
import { blocksText, fetchContext, fetchSlack, permalinkFor, repliedSince } from "./slack.js";

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

describe("噪音不入库", () => {
  it("空消息和纯应答被挡掉，游标照常推进", async () => {
    const noisy: Record<string, unknown> = {
      ...responses,
      "search.messages": {
        messages: {
          matches: [
            { ts: "1757000300.000100", text: "<@U1>", user: "U2", username: "灵雨", channel: { id: "C1", name: "fe-dev" } },
            { ts: "1757000320.000100", text: "好的", user: "U2", username: "灵雨", channel: { id: "C1", name: "fe-dev" } },
            { ts: "1757000340.000100", text: "<@U1> 帮看下登录报错", user: "U2", username: "灵雨", channel: { id: "C1", name: "fe-dev" } },
          ],
        },
      },
      "client.counts": { ims: [] },
    };
    const c = async (method: string) => noisy[method] as Record<string, unknown>;
    const res = await fetchSlack(c, "U1", { "slack:mentions": "1757000200.000000" }, 1757000700_000);
    expect(res.items.map((i) => i.text)).toEqual(["<@U1> 帮看下登录报错"]);
    // 挡掉的两条也算看过了，否则下次同步又会重新捞一遍
    expect(res.cursors["slack:mentions"]).toBe("1757000340.000100");
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

describe("机器人与 Block Kit", () => {
  const botResponses: Record<string, unknown> = {
    "search.messages": {
      messages: {
        matches: [
          {
            ts: "1757000800.000100",
            text: "",
            user: "UBOT",
            username: "",
            channel: { id: "D9", name: "UBOT", is_im: true },
            blocks: [
              { type: "header", text: { type: "plain_text", text: "Defect Creation Notification" } },
              { type: "section", fields: [{ text: "*Priority:* P0" }] },
            ],
          },
          { ts: "1757000700.000100", text: "", user: "U2", channel: { id: "C1", name: "fe-dev" }, blocks: [{ text: { text: "看下这个" } }] },
        ],
      },
    },
    "client.counts": { ims: [] },
    "users.info": {},
    "chat.getPermalink": {},
  };
  const botCall = async (method: string, params: Record<string, string>) => {
    if (method === "users.info") return { user: { is_bot: params.user === "UBOT", real_name: params.user === "UBOT" ? "Meegle" : "灵雨" } };
    return botResponses[method] as Record<string, unknown>;
  };

  it("只有 bot_id、没有 user 的照样挡掉：Meegle 在 search 结果里就是这形态", async () => {
    const call = async (method: string, params: Record<string, string>) => {
      if (method === "users.info") return { user: { is_bot: false, real_name: "灵雨" } };
      if (method === "search.messages")
        return {
          messages: {
            matches: [
              { ts: "1757000810.000100", text: "【Meegle】需求分派给 <@U1>", bot_id: "B9", username: "Meegle", channel: { id: "C9", name: "meegle" } },
              { ts: "1757000805.000100", text: "<@U1> 构建失败", username: "CI", channel: { id: "C8", name: "ci" } },
              { ts: "1757000700.000100", text: "<@U1> 看下这个", user: "U2", channel: { id: "C1", name: "fe-dev" } },
            ],
          },
        };
      return botResponses[method] as Record<string, unknown>;
    };
    const res = await fetchSlack(call, "U1", { "slack:mentions": "1757000600.000000" }, 1757000900_000);
    expect(res.items.map((i) => i.text)).toEqual(["<@U1> 看下这个"]);
    expect(res.cursors["slack:mentions"]).toBe("1757000810.000100");
  });

  it("机器人 @ 我的不进收件箱，但游标照常前进", async () => {
    const res = await fetchSlack(botCall, "U1", { "slack:mentions": "1757000600.000000" }, 1757000900_000);
    expect(res.items.map((i) => i.userId)).toEqual(["U2"]);
    expect(res.cursors["slack:mentions"]).toBe("1757000800.000100");
  });

  it("text 为空时从 blocks 取正文，username 为空串时回落到 users.info", async () => {
    const res = await fetchSlack(botCall, "U1", { "slack:mentions": "1757000600.000000" }, 1757000900_000);
    expect(res.items[0]!.text).toBe("看下这个");
    expect(res.items[0]!.userName).toBe("灵雨");
  });

  it("blocksText 递归展开 elements 与 fields", async () => {
    expect(blocksText(undefined)).toBe("");
    expect(blocksText([{ elements: [{ text: { text: "a" } }, { fields: [{ text: "b" }] }] }])).toBe("a\nb");
  });
});

// 库里 58 条「未处理」私聊消息，41 条其实早就在 Slack app 里回过了（实测）。
// 典型的一条：对方 09-09 说「一会儿一起听下那个 whale 渠道系统」，我 36 秒后回了「好」，
// 六天后 Friday 还是把它建成待办挂着。自己回过 = 这件事已经处理完了。
describe("我在 Slack 里回过的就不算待办", () => {
  const me = "U1";
  const base = {
    "users.info": { user: { real_name: "佳成" } },
    "chat.getPermalink": { permalink: "https://s/x" },
    "search.messages": { messages: { matches: [] } },
  };

  it("私聊里我后来发过话，那之前对方的消息不入库", async () => {
    const r = {
      ...base,
      "client.counts": { ims: [{ id: "D1", has_unreads: true, latest: "1757000900.000100" }] },
      "conversations.history": {
        messages: [
          { ts: "1757000900.000100", text: "这条我还没回", user: "U3" },
          { ts: "1757000500.000100", text: "好", user: me },
          { ts: "1757000400.000100", text: "一会儿一起听下那个渠道系统", user: "U3" },
        ],
      },
    };
    const res = await fetchSlack(async (m: string) => r[m as keyof typeof r] as Record<string, unknown>, me, { "slack:im:D1": "1757000300.000000" }, 1757001000_000);
    expect(res.items.map((i) => i.text)).toEqual(["这条我还没回"]);
  });

  it("我回过之后对方又说了新的，新的还要进来", async () => {
    const r = {
      ...base,
      "client.counts": { ims: [{ id: "D1", has_unreads: true, latest: "1757000700.000100" }] },
      "conversations.history": {
        messages: [
          { ts: "1757000700.000100", text: "还有个事", user: "U3" },
          { ts: "1757000500.000100", text: "好", user: me },
          { ts: "1757000400.000100", text: "一会儿一起听下", user: "U3" },
        ],
      },
    };
    const res = await fetchSlack(async (m: string) => r[m as keyof typeof r] as Record<string, unknown>, me, { "slack:im:D1": "1757000300.000000" }, 1757001000_000);
    expect(res.items.map((i) => i.text)).toEqual(["还有个事"]);
  });

  it("频道 @ 按 thread 判断：我在那条 thread 里回过就不入库", async () => {
    const r = {
      ...base,
      "client.counts": { ims: [] },
      "search.messages": {
        messages: {
          matches: [
            { ts: "1757000400.000100", text: "<@U1> 这个你看下", user: "U3", thread_ts: "1757000400.000100", channel: { id: "C1", name: "fe" } },
            { ts: "1757000800.000100", text: "<@U1> 这条没人回", user: "U3", thread_ts: "1757000800.000100", channel: { id: "C1", name: "fe" } },
          ],
        },
      },
      "conversations.replies": {
        messages: [
          { ts: "1757000400.000100", text: "<@U1> 这个你看下", user: "U3" },
          { ts: "1757000500.000100", text: "看了，没问题", user: me },
        ],
      },
    };
    const calls: string[] = [];
    const res = await fetchSlack(async (m: string) => { calls.push(m); return (m === "conversations.replies" && !calls.includes("done") ? r["conversations.replies"] : r[m as keyof typeof r]) as Record<string, unknown>; }, me, { "slack:mentions": "1757000300.000000" }, 1757001000_000);
    expect(res.items.map((i) => i.text)).toEqual(["<@U1> 这条没人回"]);
  });

  it("频道里我在别处说过话不算回了这条：只看同一条 thread", async () => {
    const r = {
      ...base,
      "client.counts": { ims: [] },
      "search.messages": {
        messages: { matches: [{ ts: "1757000400.000100", text: "<@U1> 这个你看下", user: "U3", channel: { id: "C1", name: "fe" } }] },
      },
      // 没有 thread_ts：是频道里的独立一条，我后面在频道里聊别的不算回它
      "conversations.replies": { messages: [] },
    };
    const res = await fetchSlack(async (m: string) => r[m as keyof typeof r] as Record<string, unknown>, me, { "slack:mentions": "1757000300.000000" }, 1757001000_000);
    expect(res.items.map((i) => i.text)).toEqual(["<@U1> 这个你看下"]);
  });
});

// 实测抓到的误标：频道里不在 thread 里的 @，用它自己的 ts 当 root 调 conversations.replies，
// Slack 会把这条消息之后频道里的内容也带回来，于是「我在频道别处说过话」被当成回了这条。
// 两条真事因此被误标已处理（「浩然帮忙看看这个问题」「渠道系统的前端后续由…」）。
describe("repliedSince 对不在 thread 里的频道消息", () => {
  it("没有 threadTs 的频道 @ 一律算没回，不去查 replies", async () => {
    const calls: string[] = [];
    const call = async (m: string) => {
      calls.push(m);
      // 真实 API 的行为：拿非 thread 根消息去查 replies，会带回这条自己 + 频道后续
      return { messages: [{ ts: "1757000400.000100", user: "U3" }, { ts: "1757000900.000100", user: "U1" }] } as Record<string, unknown>;
    };
    const replied = await repliedSince(call, "U1", { kind: "mention", channelId: "C1", ts: "1757000400.000100" });
    expect(replied).toBe(false);
    expect(calls).toEqual([]);
  });

  it("在 thread 里的 @ 仍照常按 thread 判断", async () => {
    const call = async () => ({ messages: [{ ts: "1757000400.000100", user: "U3" }, { ts: "1757000500.000100", user: "U1" }] }) as Record<string, unknown>;
    const replied = await repliedSince(call, "U1", { kind: "mention", channelId: "C1", ts: "1757000400.000100", threadTs: "1757000400.000100" });
    expect(replied).toBe(true);
  });
});
