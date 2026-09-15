import { describe, expect, it } from "vitest";
import { recordLesson, shouldDistill } from "./lessons.js";
import { listLessons } from "../memory/lessons.js";
import { getThreshold, setThreshold } from "../memory/thresholds.js";
import { DEFAULT_THRESHOLD } from "./gate.js";

describe("记 lesson 并回调阈值", () => {
  it("打回抬高 10", () => {
    setThreshold("question", DEFAULT_THRESHOLD);
    recordLesson({ category: "question", kind: "rejected", feedback: "太啰嗦", confidence: 80 });
    expect(getThreshold("question")).toBe(100);
    expect(listLessons("question")[0]!.feedback).toBe("太啰嗦");
  });

  it("自动发被撤回抬高 20", () => {
    setThreshold("code_fix", 70);
    recordLesson({ category: "code_fix", kind: "auto_undone", final: "发出去的话", confidence: 91 });
    expect(getThreshold("code_fix")).toBe(90);
  });

  it("通过不改阈值", () => {
    setThreshold("notice", 80);
    recordLesson({ category: "notice", kind: "approved", confidence: 95 });
    recordLesson({ category: "notice", kind: "edited_approved", draft: "a", final: "b", confidence: 65 });
    expect(getThreshold("notice")).toBe(80);
  });
});

describe("提炼触发算式", () => {
  it("攒到第 4 条不触发，第 5 条触发", () => {
    for (const kind of ["rejected", "edited_approved", "auto_undone", "rejected"] as const) {
      recordLesson({ category: "review_ask", kind, confidence: 80 });
    }
    expect(shouldDistill("review_ask", "rejected")).toBe(false);
    recordLesson({ category: "review_ask", kind: "rejected", confidence: 80 });
    expect(shouldDistill("review_ask", "rejected")).toBe(true);
  });

  it("approved 不计入，连记 5 条也不触发", () => {
    for (let i = 0; i < 5; i++) recordLesson({ category: "other", kind: "approved", confidence: 90 });
    expect(shouldDistill("other", "approved")).toBe(false);
  });
});
