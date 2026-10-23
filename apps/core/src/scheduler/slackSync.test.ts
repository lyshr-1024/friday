import { describe, expect, it, vi } from "vitest";

const creds = vi.hoisted(() => ({ on: true }));
vi.mock("../connectors/slack/client.js", async (orig) => ({
  ...(await orig<typeof import("../connectors/slack/client.js")>()),
  loadSlackCreds: async () => (creds.on ? { token: "t", cookie: "c" } : undefined),
  slackCaller: () => async (method: string) => (method === "auth.test" ? { user_id: "U1" } : {}),
  fetchLastRead: async () => ({}),
  fetchSlack: async () => {
    throw new Error("Slack search.messages 失败：invalid_auth");
  },
}));

const { state, syncSlackOnce } = await import("./index.js");
const { seedBuiltins } = await import("../connectors/builtin.js");
seedBuiltins();

describe("Slack 凭证失效", () => {
  it("invalid_auth 之后钥匙串清空：下一轮安静标没接入，不写新的错误", async () => {
    await syncSlackOnce();
    expect(state.configured).toBe(true);
    const failed = state.lastError;
    expect(failed).toContain("invalid_auth");

    creds.on = false;
    const err = vi.spyOn(console, "error");
    expect(await syncSlackOnce()).toBe(0);
    expect(state.configured).toBe(false);
    expect(state.lastError).toBe(failed);
    expect(err).not.toHaveBeenCalled();
  });
});
