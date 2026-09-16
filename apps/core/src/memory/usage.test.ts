import { describe, expect, it } from "vitest";
import { addUsage, rangeStart, usageSummary } from "./usage.js";

describe("用量统计", () => {
  it("一次调用的多个模型合成一次，按调用点和模型各聚合一份", () => {
    addUsage("triage", 1, [{ model: "claude-sonnet-5", inputTokens: 800, outputTokens: 400, cacheRead: 0, cacheWrite: 0, costUsd: 0.006 }]);
    addUsage("ask", 3, [
      { model: "claude-sonnet-5", inputTokens: 2000, outputTokens: 900, cacheRead: 1200, cacheWrite: 0, costUsd: 0.013 },
      { model: "claude-haiku-4-5", inputTokens: 300, outputTokens: 50, cacheRead: 0, cacheWrite: 0, costUsd: 0.0006 },
    ]);

    const s = usageSummary("today");
    expect(s.total.calls).toBe(2);
    expect(s.total.costUsd).toBeCloseTo(0.0196, 4);
    expect(s.total.inputTokens).toBe(3100);

    const ask = s.byLabel.find((e) => e.key === "ask")!;
    // 两个模型是同一次调用，不能算成两次
    expect(ask.calls).toBe(1);
    expect(ask.outputTokens).toBe(950);
    expect(ask.cacheRead).toBe(1200);

    const sonnet = s.byModel.find((e) => e.key === "claude-sonnet-5")!;
    expect(sonnet.inputTokens).toBe(2800);
    expect(s.byLabel[0]!.key).toBe("ask"); // 花得多的排前面
  });

  it("没有模型用量的调用不落账", () => {
    const before = usageSummary("today").total.calls;
    addUsage("route", 1, []);
    expect(usageSummary("today").total.calls).toBe(before);
  });

  it("同一毫秒的两次调用算两次", () => {
    const before = usageSummary("today").total.calls;
    const one = { model: "claude-haiku-4-5", inputTokens: 100, outputTokens: 10, cacheRead: 0, cacheWrite: 0, costUsd: 0.0002 };
    addUsage("route", 1, [one]);
    addUsage("route", 1, [one]);
    expect(usageSummary("today").total.calls).toBe(before + 2);
  });

  it("时间档从本地零点起算", () => {
    const now = new Date("2026-09-16T10:00:00+08:00");
    expect(rangeStart("today", now) < now.toISOString()).toBe(true);
    expect(rangeStart("7d", now) < rangeStart("today", now)).toBe(true);
    expect(rangeStart("30d", now) < rangeStart("7d", now)).toBe(true);
  });
});
