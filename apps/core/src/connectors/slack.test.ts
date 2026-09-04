import { describe, expect, it } from "vitest";
import { fetchSlack, permalinkFor } from "./slack.js";

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
  "conversations.history": { messages: [{ ts: "1757000500.000100", text: "在吗", user: "U3" }, { ts: "1757000450.000100", text: "join", user: "U3", subtype: "channel_join" }] },
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
