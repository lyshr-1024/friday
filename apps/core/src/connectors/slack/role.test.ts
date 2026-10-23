import { describe, expect, it, vi } from "vitest";
import { seedBuiltins } from "../builtin.js";
import "./index.js";
import { role } from "../roles.js";
import { addPending, createTask } from "../../memory/tasks.js";
import { listAudit, undoPlan } from "../../memory/audit.js";
import { executePending } from "../../agent/pipeline.js";
import { db } from "../../memory/db.js";

const postMessage = vi.fn(async (..._args: unknown[]) => ({ ts: "1700000000.000200", permalink: "https://x.slack.com/p1" }));

vi.mock("./client.js", async (orig) => ({
  ...(await orig<typeof import("./client.js")>()),
  loadSlackCreds: async () => ({ token: "t", cookie: "c" }),
  postMessage: (...args: unknown[]) => postMessage(...args),
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
    await expect(role("chat").post({ to: { tool: "slack", type: "conversation", id: "C1:1.0", attrs: { channelId: "C1" } }, text: "x" }, { kind: "friday", why: "x" })).rejects.toThrow("必须带已批准的待审动作");
  });

  it("ownsApp 认 Slack 桌面端", () => {
    expect(role("chat").ownsApp("com.tinyspeck.slackmacgap")).toBe(true);
    expect(role("chat").ownsApp("com.apple.finder")).toBe(false);
  });

  it("审核通过发出：只记一条 slack_reply_sent，字段和撤回跟原来一致", async () => {
    const t = createTask({ title: "回复", kind: "conversation", source: {}, status: "review" });
    const to = { tool: "slack", type: "conversation" as const, id: "D1:1.0", attrs: { channelId: "D1", threadTs: "1.0" } };
    const action = addPending(t.id, { type: "chat_reply", label: "回复", detail: "明天上线", payload: { to, text: "明天上线" } })!.pending![0]!;
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

  it("升级前挂着的老 slack_reply 待审批准后照常发出，记账字段不变", async () => {
    const t = createTask({ title: "老回复", kind: "conversation", source: {}, status: "review" });
    const old = [{ id: "a-old", type: "slack_reply", label: "回复 a", detail: "x", payload: { channel: "C1", text: "x", threadTs: "1.2", userName: "a" }, at: new Date().toISOString() }];
    db().prepare("UPDATE tasks SET pending = ? WHERE id = ?").run(JSON.stringify(old), t.id);
    postMessage.mockClear();
    await executePending(t.id, "a-old");
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0]!.slice(1)).toEqual(["C1", "x", "1.2"]);
    const last = listAudit({ taskId: t.id }).filter((e) => e.action === "slack_reply_sent").at(-1);
    expect(last?.action).toBe("slack_reply_sent");
    expect(last?.evidence).toMatchObject({ channel: "C1" });
  });
});
