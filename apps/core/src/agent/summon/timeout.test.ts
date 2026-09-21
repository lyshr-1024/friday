import { describe, expect, it, vi } from "vitest";
import type { Snapshot, SummonRules } from "@friday/shared";

const snapshot: Snapshot = {
  at: 1,
  app: { bundleId: "com.tinyspeck.slackmacgap", name: "Slack", title: "拂晓 - Slack" },
  permissions: { accessibility: true, automation: true, screen: true },
};
const rules: SummonRules = { saw: "Slack · 拂晓", actions: [], willThink: true };

/**
 * 超时/中断时 SDK 抛的是「Claude Code process aborted by user」。
 * 那句话糊在卡片上像是出了故障，而规则层的卡其实已经渲染出来了——安静降级，别盖掉它。
 */
describe("呼出判断超时", () => {
  it("中断异常不往外抛，返回空卡", async () => {
    vi.resetModules();
    vi.doMock("../claude.js", () => ({
      // eslint-disable-next-line require-yield
      askStream: async function* () {
        throw new Error("Claude Code process aborted by user");
      },
    }));
    const { summonCard } = await import("./card.js");
    const card = await summonCard({ snapshot, rules, candidates: [] });
    expect(card).toEqual({ verdict: "", actions: [] });
    vi.doUnmock("../claude.js");
  });

  it("不是中断的异常照常抛出去", async () => {
    vi.resetModules();
    vi.doMock("../claude.js", () => ({
      // eslint-disable-next-line require-yield
      askStream: async function* () {
        throw new Error("模型返回 500");
      },
    }));
    const { summonCard } = await import("./card.js");
    await expect(summonCard({ snapshot, rules, candidates: [] })).rejects.toThrow("模型返回 500");
    vi.doUnmock("../claude.js");
  });
});
