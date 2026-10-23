import { describe, expect, it, vi } from "vitest";
import { seedBuiltins } from "../builtin.js";
import "./index.js";
import { role } from "../roles.js";
import { addPending, createTask } from "../../memory/tasks.js";
import { listAudit, undoPlan } from "../../memory/audit.js";
import { executePending } from "../../agent/pipeline.js";

vi.mock("./client.js", async (orig) => ({
  ...(await orig<typeof import("./client.js")>()),
  loadSlackCreds: async () => ({ token: "t", cookie: "c" }),
  postMessage: async () => ({ ts: "1700000000.000200", permalink: "https://x.slack.com/p1" }),
}));

seedBuiltins();

describe("chat 角色：slack", () => {
  it("parseTitle 认 HUD 窗口标题的几种形态", () => {
    const chat = role("chat");
    expect(chat.parseTitle("一起养牛（频道） - Longbridge - 1 个新项目 - Slack")).toEqual({ channel: "一起养牛" });
    expect(chat.parseTitle("team-fe-bo（频道） - Longbridge - Slack")).toEqual({ channel: "team-fe-bo" });
    expect(chat.parseTitle("活动 - Longbridge - Slack")).toEqual({});
    expect(chat.parseTitle("拂晓 (Chen Xiaofu) - Longbridge - Slack")).toEqual({ person: "拂晓 (Chen Xiaofu)" });
    expect(chat.parseTitle("拂晓 (2) - Longbridge - Slack")).toEqual({ person: "拂晓" });
  });

  it("post 没批准就抛", async () => {
    await expect(role("chat").post({ channel: "C1", text: "x" }, { kind: "friday", why: "x" })).rejects.toThrow("必须带已批准的待审动作");
  });

  it("ownsApp 认 Slack 桌面端", () => {
    expect(role("chat").ownsApp("com.tinyspeck.slackmacgap")).toBe(true);
    expect(role("chat").ownsApp("com.apple.finder")).toBe(false);
  });

  it("审核通过发出：只记一条 slack_reply_sent，字段和撤回跟原来一致", async () => {
    const t = createTask({ title: "回复", kind: "slack", source: {}, status: "review" });
    const action = addPending(t.id, { type: "slack_reply", label: "回复", detail: "明天上线", payload: { channel: "D1", text: "明天上线", threadTs: "1.0" } })!.pending![0]!;
    await executePending(t.id, action.id);
    const rows = listAudit({ taskId: t.id }).filter((e) => e.action === "slack_reply_sent");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      why: "你审核通过",
      risk: "irreversible",
      status: "approved",
      evidence: { channel: "D1", text: "明天上线", ts: "1700000000.000200", permalink: "https://x.slack.com/p1" },
    });
    expect(undoPlan(rows[0]!.id)).toEqual({ kind: "delete_slack_message", channel: "D1", ts: "1700000000.000200" });
  });
});
