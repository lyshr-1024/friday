import { describe, expect, it } from "vitest";
import { allThresholds, GATE_CATEGORIES, getThreshold, setThreshold } from "./thresholds.js";
import { DEFAULT_THRESHOLD } from "../agent/gate.js";

describe("阈值存储", () => {
  it("没设过的类别返回默认值，设过的读回来", () => {
    expect(getThreshold("question")).toBe(DEFAULT_THRESHOLD);
    setThreshold("question", 70);
    expect(getThreshold("question")).toBe(70);
    setThreshold("question", 75);
    expect(getThreshold("question")).toBe(75);
  });

  it("allThresholds 覆盖全部类别，含自己开工那档", () => {
    const all = allThresholds();
    expect(Object.keys(all).sort()).toEqual([...GATE_CATEGORIES].sort());
    expect(all.code_fix).toBe(DEFAULT_THRESHOLD);
    // 开工默认也是关着的：用户主动调低才会自己开
    expect(all.autostart).toBe(DEFAULT_THRESHOLD);
    expect(DEFAULT_THRESHOLD).toBe(100);
  });
});
