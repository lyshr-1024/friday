import { describe, expect, it } from "vitest";
import { allThresholds, getThreshold, setThreshold } from "./thresholds.js";
import { DEFAULT_THRESHOLD } from "../agent/gate.js";

describe("阈值存储", () => {
  it("没设过的类别返回默认值，设过的读回来", () => {
    expect(getThreshold("question")).toBe(DEFAULT_THRESHOLD);
    setThreshold("question", 70);
    expect(getThreshold("question")).toBe(70);
    setThreshold("question", 75);
    expect(getThreshold("question")).toBe(75);
  });

  it("allThresholds 覆盖全部类别", () => {
    const all = allThresholds();
    expect(Object.keys(all)).toHaveLength(6);
    expect(all.code_fix).toBe(DEFAULT_THRESHOLD);
  });
});
