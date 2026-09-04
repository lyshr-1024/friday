import { describe, expect, it } from "vitest";
import { fetchSlack } from "./slack.js";

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
    const res = await fetchSlack(call, "U1", { "slack:mentions": "1757000200.000000" });
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
