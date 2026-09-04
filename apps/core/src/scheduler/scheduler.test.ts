import { describe, expect, it } from "vitest";
import { intervalMs, isActive } from "./index.js";

const at = (hourShanghai: number) => new Date(Date.UTC(2026, 8, 4, (hourShanghai - 8 + 24) % 24, 30));

describe("调度节奏", () => {
  it("10:00–20:00 三分钟一轮，其余十五分钟", () => {
    expect(isActive(at(10))).toBe(true);
    expect(isActive(at(19))).toBe(true);
    expect(isActive(at(20))).toBe(false);
    expect(isActive(at(3))).toBe(false);
    expect(intervalMs(at(12))).toBe(3 * 60_000);
    expect(intervalMs(at(22))).toBe(15 * 60_000);
  });
});
