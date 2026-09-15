import { describe, expect, it } from "vitest";
import { addLesson, countSince, listLessons, recentEdited } from "./lessons.js";

describe("lessons 存储", () => {
  it("四种 kind 都能写入，按类别新到旧读回", () => {
    addLesson({ category: "question", kind: "approved", confidence: 95 });
    addLesson({ category: "question", kind: "rejected", confidence: 80, feedback: "太啰嗦" });
    addLesson({ category: "code_fix", kind: "auto_undone", confidence: 91, final: "已发出的话" });
    const q = listLessons("question");
    expect(q).toHaveLength(2);
    expect(q[0]!.kind).toBe("rejected");
    expect(q[0]!.feedback).toBe("太啰嗦");
    expect(listLessons("code_fix")[0]!.final).toBe("已发出的话");
  });

  it("edited_approved 草稿与终稿都留下，可单独取最近几条", () => {
    addLesson({ category: "status_ask", kind: "edited_approved", confidence: 70, draft: "我看看", final: "在改了，今天给你" });
    addLesson({ category: "status_ask", kind: "approved", confidence: 92 });
    const edited = recentEdited("status_ask", 3);
    expect(edited).toHaveLength(1);
    expect(edited[0]!.draft).toBe("我看看");
    expect(edited[0]!.final).toBe("在改了，今天给你");
  });

  it("countSince 只数指定 kind", () => {
    addLesson({ category: "review_ask", kind: "approved", confidence: 90 });
    addLesson({ category: "review_ask", kind: "rejected", confidence: 90 });
    addLesson({ category: "review_ask", kind: "edited_approved", confidence: 90 });
    expect(countSince("review_ask", ["rejected", "edited_approved", "auto_undone"])).toBe(2);
  });

  it("countSince 不受硬编码上限影响，能数超过 1000 条", () => {
    const category = "notice";
    for (let i = 0; i < 1050; i++) {
      addLesson({ category, kind: i % 2 === 0 ? "approved" : "rejected", confidence: 80 });
    }
    const count = countSince(category, ["approved"]);
    expect(count).toBe(525);
  });

  it("recentEdited 不受上限影响，旧 edited_approved 被新记录挤出也能取到", () => {
    const category: "other" = "other";
    for (let i = 0; i < 5; i++) {
      addLesson({ category, kind: "edited_approved", confidence: 88, draft: `old_draft_${i}`, final: `old_final_${i}` });
    }
    for (let i = 0; i < 210; i++) {
      addLesson({ category, kind: "approved", confidence: 85 });
    }
    const edited = recentEdited(category, 3);
    expect(edited).toHaveLength(3);
    expect(edited.every((l) => l.kind === "edited_approved")).toBe(true);
    expect(edited[0]!.final).toMatch(/^old_final_/);
  });
});
