import { describe, expect, it } from "vitest";
import { backoff, decide, decideStart, stats, suggest, DEFAULT_THRESHOLD, MIN_THRESHOLD } from "./gate.js";
import type { Lesson } from "@friday/shared";

const brief = (over: Partial<{ needsReply: boolean; reply: string; confidence: number }> = {}) => ({
  situation: "s", needs: "n", needsReply: true, urgency: "normal" as const, reply: "好的我看看",
  actions: [], context: [], confidence: 95, confidenceReason: "", ...over,
});

describe("门控判定", () => {
  it("置信度达到阈值才自动发，等于阈值算达到", () => {
    expect(decide(brief({ confidence: 95 }), 90)).toBe("auto");
    expect(decide(brief({ confidence: 90 }), 90)).toBe("auto");
    expect(decide(brief({ confidence: 89 }), 90)).toBe("queue");
  });

  it("不需要回复或没有草稿一律进队列", () => {
    expect(decide(brief({ needsReply: false }), 90)).toBe("queue");
    expect(decide({ ...brief(), reply: undefined } as never, 90)).toBe("queue");
  });

  it("阈值封顶 100 时永远进队列，即便模型自评满分", () => {
    expect(decide(brief({ confidence: 100 }), 100)).toBe("queue");
  });
});

describe("阈值回退", () => {
  it("打回 +10，自动发被撤回 +20，封顶 100", () => {
    expect(backoff(90, "rejected")).toBe(100);
    expect(backoff(70, "rejected")).toBe(80);
    expect(backoff(70, "auto_undone")).toBe(90);
    expect(backoff(95, "auto_undone")).toBe(100);
    expect(backoff(100, "rejected")).toBe(100);
  });
});

const lesson = (kind: Lesson["kind"], confidence: number): Lesson => ({ id: kind + confidence, category: "question", kind, confidence, createdAt: "2026-09-11T00:00:00.000Z" });

describe("统计与阈值建议", () => {
  it("统计通过率与校准误差", () => {
    const s = stats([lesson("approved", 90), lesson("approved", 90), lesson("rejected", 90), lesson("approved", 90)]);
    expect(s.total).toBe(4);
    expect(s.approved).toBe(3);
    expect(s.calibrationError).toBeCloseTo(15, 5);
  });

  it("样本够、通过率高、校准准才建议下调 10", () => {
    const good = Array.from({ length: 20 }, (_, i) => lesson(i < 19 ? "approved" : "rejected", 92));
    expect(suggest(90, stats(good))).toBe(80);
    expect(suggest(MIN_THRESHOLD + 5, stats(good))).toBeUndefined();
    expect(suggest(90, stats(good.slice(0, 19)))).toBeUndefined();
    const miscalibrated = Array.from({ length: 20 }, (_, i) => lesson(i < 19 ? "approved" : "rejected", 50));
    expect(suggest(90, stats(miscalibrated))).toBeUndefined();
  });

  it("默认阈值是 100（等于全部进人工队列，用户自己调低某个类别才开自动发送）", () => {
    expect(DEFAULT_THRESHOLD).toBe(100);
  });
});

describe("自己开工的闸门", () => {
  it("默认 100 等于关着：置信度再高也排队", () => {
    expect(decideStart(100, DEFAULT_THRESHOLD)).toBe("queue");
    expect(decideStart(99, 100)).toBe("queue");
  });

  it("阈值调下来之后，够了才自己开", () => {
    expect(decideStart(85, 80)).toBe("auto");
    expect(decideStart(80, 80)).toBe("auto");
    expect(decideStart(79, 80)).toBe("queue");
  });

  it("打回一次就把开工阈值抬回去", () => {
    expect(backoff(80, "rejected")).toBe(90);
    expect(backoff(95, "rejected")).toBe(100);
  });
});

describe("负信号按代价抬阈值", () => {
  it("撤回 20 > 打回 / 忽略 10 > 自己回了 5，封顶 100", () => {
    expect(backoff(60, "auto_undone")).toBe(80);
    expect(backoff(60, "rejected")).toBe(70);
    expect(backoff(60, "ignored")).toBe(70);
    expect(backoff(60, "done_without_reply")).toBe(65);
    expect(backoff(95, "auto_undone")).toBe(100);
  });

  it("正信号不动阈值", () => {
    expect(backoff(60, "approved")).toBe(60);
    expect(backoff(60, "edited_approved")).toBe(60);
  });
});
