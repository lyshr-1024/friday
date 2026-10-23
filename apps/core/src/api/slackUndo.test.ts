import { describe, expect, it, vi } from "vitest";
import { listAudit, record } from "../memory/audit.js";
import { createTask } from "../memory/tasks.js";

const keychain = vi.hoisted(() => ({ on: false }));
vi.mock("../connectors/slack/keychain.js", () => ({ keychainGet: async () => (keychain.on ? "x" : undefined) }));

const deleteMessage = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../connectors/slack/client.js", async (orig) => ({ ...(await orig<typeof import("../connectors/slack/client.js")>()), deleteMessage }));

const { app } = await import("./index.js");
const { seedBuiltins } = await import("../connectors/builtin.js");
const { role } = await import("../connectors/roles.js");
seedBuiltins();

function sent(taskId: string, ts: string): string {
  return record({ taskId, action: "slack_reply_sent", why: "你审核通过", how: "x", evidence: {}, risk: "irreversible", status: "approved", undo: { kind: "delete_slack_message", channel: "D1", ts } }).id;
}

const undo = (id: string) => app.request(`/audit/${id}/undo`, { method: "POST" });

describe("撤回发出去的 Slack 回复", () => {
  it("启动时没接入、之后配上了：照样能撤回，账记在同一条任务上", async () => {
    expect(await role("chat").configured()).toBe(false);
    keychain.on = true;
    const t = createTask({ title: "回复", kind: "slack", source: {}, status: "done" });
    const res = await undo(sent(t.id, "1.1"));
    expect(res.status).toBe(200);
    expect(deleteMessage).toHaveBeenCalledWith(expect.any(Function), "D1", "1.1");
    expect(listAudit({ taskId: t.id }).find((e) => e.action === "slack_delete")).toMatchObject({ risk: "irreversible" });
  });

  it("钥匙串里没有凭证：400「Slack 未接入」", async () => {
    keychain.on = false;
    const t = createTask({ title: "回复", kind: "slack", source: {}, status: "done" });
    const res = await undo(sent(t.id, "1.2"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Slack 未接入" });
  });
});
