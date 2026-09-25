import { describe, expect, it } from "vitest";
import { draftPrompt, parseDraft, type KrContext } from "./draft.js";

const krs: KrContext[] = [
  { kr: { id: 10, name: "出入金迁移", objective: "O1", quarter: "2026Q3" }, prevContent: "上周做了 A", prevPct: 90 },
  { kr: { id: 11, name: "组件修复", objective: "O2", quarter: "2026Q3" }, prevContent: null, prevPct: null },
];
const mats = [{ id: "g1", text: "[whale-console] fix: 出金" }, { id: "t1", text: "SaaS 计费 · m-24514104" }];

describe("起草钳制", () => {
  it("越权 KR 丢掉、进度不降不超、不存在的素材编号剔除", () => {
    const out = parseDraft(
      "好的：" + JSON.stringify({
        items: [
          { objectId: 10, content: "修了出金", pct: 60, why: "x", used: ["g1", "g99"] },
          { objectId: 11, content: "修组件", pct: 130, why: "y", used: ["t1"] },
          { objectId: 999, content: "别人的", pct: 50, why: "z", used: ["g1"] },
        ],
        unmatched: ["t1", "nope"],
      }),
      krs,
      mats,
    )!;
    expect(out.items).toEqual([
      { objectId: 10, content: "修了出金", pct: 90, why: "x", used: ["g1"] },
      { objectId: 11, content: "修组件", pct: 100, why: "y", used: ["t1"] },
    ]);
    expect(out.unmatched).toEqual(["t1"]);
  });

  it("素材编号剔完为空的条目不算草稿", () => {
    const out = parseDraft(JSON.stringify({ items: [{ objectId: 10, content: "编的", pct: 95, why: "", used: ["g42"] }], unmatched: [] }), krs, mats)!;
    expect(out.items).toEqual([]);
  });

  it("不是 JSON 返回 undefined", () => {
    expect(parseDraft("抱歉我不能", krs, mats)).toBeUndefined();
  });

  it("提示词里素材和上周正文都在围栏里", () => {
    const { system, prompt } = draftPrompt(krs, mats);
    expect(system).toContain("<untrusted>");
    expect(prompt).toContain('<untrusted source="krs">');
    expect(prompt).toContain('<untrusted source="materials">');
    expect(prompt).toContain('<untrusted source="last-week">');
  });
});
