import { describe, expect, it } from "vitest";
import type { OkrWeeklyDraft } from "@friday/shared";
import { createConversation } from "../memory/conversations.js";
import { addPending, createTask, getTask } from "../memory/tasks.js";
import { fridayToolList } from "./tools.js";

const callIn = async (conv: string | undefined, name: string, args: Record<string, unknown>) => {
  const t = fridayToolList(conv).find((x) => x.name === name)!;
  return ((await t.handler(args as never, {})).content[0] as { text: string }).text;
};

function weeklyCard(week: string) {
  const t = createTask({ title: `OKR 周报 ${week}`, kind: "okr_weekly", status: "review", source: { okrWeek: week } });
  const draft: OkrWeeklyDraft = {
    week,
    quarter: "2026Q4",
    rows: [
      { objectId: 1, kr: "KR1", objective: "O", prevPct: 10, content: "旧写法", pct: 10, state: "draft", checked: true },
      { objectId: 2, kr: "KR2", objective: "O", prevPct: 0, content: "", pct: 0, state: "empty", checked: false },
    ],
  } as unknown as OkrWeeklyDraft;
  addPending(t.id, { type: "okr_submit", label: "提交 1 条到 OKR", detail: "d", payload: draft as unknown as Record<string, unknown> });
  return t;
}

describe("会话里改周报草稿", () => {
  it("okr_draft_update 按 KR 替换草稿正文和进度、空行补了内容就勾上，不提交", async () => {
    const t = weeklyCard("2026W1019-1025");
    const out = await callIn(createConversation().id, "okr_draft_update", { week: "2026W1019-1025", rows: [{ objectId: 1, content: "按口径写的", pct: 20 }, { objectId: 2, content: "本周无进展，原因：排期未到" }] });
    expect(out).toContain("草稿");
    const p = getTask(t.id)!.pending!.find((a) => a.type === "okr_submit")!;
    const rows = (p.payload as unknown as OkrWeeklyDraft).rows;
    expect(rows.find((r) => r.objectId === 1)).toMatchObject({ content: "按口径写的", pct: 20 });
    expect(rows.find((r) => r.objectId === 2)).toMatchObject({ content: "本周无进展，原因：排期未到", checked: true });
    expect(p.label).toBe("提交 2 条到 OKR");
  });

  it("这周没有周报卡：说清楚，让先起草", async () => {
    expect(await callIn(createConversation().id, "okr_draft_update", { week: "2026W0101-0107", rows: [{ objectId: 1, content: "x" }] })).toContain("okr_weekly");
  });

  it("会话里不许直接调 OKR 写周报，改草稿、让用户在卡上提交", async () => {
    for (const op of ["create_progress_report", "update_progress_report", "delete_progress_report"]) {
      const out = await callIn(createConversation().id, "tool_call", { tool: "okr", op, args: {} });
      expect(out, op).toContain("okr_draft_update");
    }
  });
});
