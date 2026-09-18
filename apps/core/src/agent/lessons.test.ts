import { describe, expect, it } from "vitest";
import { RELAY_CATEGORY } from "@friday/shared";
import { lessonFromRelay, RELAY_MIN_CHARS, recordLesson, reviewOnce } from "./lessons.js";
import { listLessons } from "../memory/lessons.js";

describe("自己敲进终端的话", () => {
  it("整句记一条 relay 经验", () => {
    const before = listLessons(RELAY_CATEGORY, 100).length;
    lessonFromRelay("t1", "先看 apps/core 里的 fence.ts");
    const after = listLessons(RELAY_CATEGORY, 100);
    expect(after.length).toBe(before + 1);
    expect(after[0]!.final).toBe("先看 apps/core 里的 fence.ts");
    expect(after[0]!.kind).toBe("relayed_direct");
  });

  it("y / 回车这类应答键学不出东西", () => {
    const before = listLessons(RELAY_CATEGORY, 100).length;
    lessonFromRelay("t1", "y");
    lessonFromRelay("t1", "\r");
    lessonFromRelay("t1", "1");
    expect(listLessons(RELAY_CATEGORY, 100).length).toBe(before);
    expect("y".length).toBeLessThan(RELAY_MIN_CHARS);
  });
});

describe("复盘", () => {
  // 原来每天自动跑一次，2026-09-18 起只由用户触发：会话里说一句、设置页按钮、POST /tasks/review
  it("跑过之后游标推进，下一次没有新的干预就直接跳过，不重复烧钱", async () => {
    await reviewOnce();
    const again = await reviewOnce();
    expect(again).toHaveProperty("skipped");
  });

  it("只学「你自己怎么做的」那几种，草稿类的已经没有来源", () => {
    const before = listLessons("question", 100).length;
    recordLesson({ category: "question", kind: "ignored", draft: "拂晓问能提测了吗" });
    recordLesson({ category: "question", kind: "done_without_reply", draft: "潇悦问前端收尾了没" });
    expect(listLessons("question", 100).length).toBe(before + 2);
  });
});
