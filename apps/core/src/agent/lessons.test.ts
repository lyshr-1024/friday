import { describe, expect, it } from "vitest";
import { lessonFromTask, recordLesson, reviewDue, shouldDistill } from "./lessons.js";
import { listLessons } from "../memory/lessons.js";
import { getThreshold, setThreshold } from "../memory/thresholds.js";
import { DEFAULT_THRESHOLD } from "./gate.js";
import { createTask, addPending } from "../memory/tasks.js";

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

describe("没按草稿处理也是一次人工处理", () => {
  const withDraft = (title: string) => {
    const t = createTask({ title, kind: "slack", source: {}, status: "review" });
    return addPending(t.id, { type: "slack_reply", label: "回复", detail: "草稿原文", payload: { channel: "C1", text: "草稿原文" } })!;
  };

  it("直接忽略：记 ignored，阈值抬 10", () => {
    setThreshold("other", 70);
    const lesson = lessonFromTask(withDraft("忽略掉的"), "ignored");
    expect(lesson?.kind).toBe("ignored");
    expect(lesson?.draft).toBe("草稿原文");
    expect(getThreshold("other")).toBe(80);
  });

  it("自己回了：记 done_without_reply，阈值抬 5", () => {
    setThreshold("other", 70);
    lessonFromTask(withDraft("自己回的"), "done_without_reply");
    expect(getThreshold("other")).toBe(75);
  });

  it("会话里改写草稿：draft 是原稿，final 是改后的", () => {
    const lesson = lessonFromTask(withDraft("改过的"), "edited_approved", "改后的话");
    expect(lesson?.draft).toBe("草稿原文");
    expect(lesson?.final).toBe("改后的话");
  });

  it("没有待发草稿就不记——git_merge 这类审核动作跟对话质量无关", () => {
    const t = createTask({ title: "只有合并动作", kind: "code", source: {}, status: "review" });
    const withMerge = addPending(t.id, { type: "git_merge", label: "合并", detail: "friday/x", payload: {} })!;
    expect(lessonFromTask(withMerge, "ignored")).toBeUndefined();
  });
});

describe("该复盘了没", () => {
  it("从没跑过就该跑", () => {
    expect(reviewDue(undefined)).toBe(true);
  });

  it("今天跑过就不再跑，隔一天才跑", () => {
    const now = Date.parse("2026-09-16T10:00:00Z");
    expect(reviewDue("2026-09-16T02:00:00Z", now)).toBe(false);
    expect(reviewDue("2026-09-15T02:00:00Z", now)).toBe(true);
  });
});
