import { describe, expect, it } from "vitest";
import { initMemory, db } from "./db.js";
import { addNoteTask, dropNoteTask, migrateLocalTodos } from "./noteTask.js";
import { addLocalTodo } from "./todos.js";
import { listTasks } from "./tasks.js";

describe("记待办 = 建任务", () => {
  it("落在「待办」分组里，带来源和截止", () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const t = addNoteTask({ text: "把导出中心的筛选加上", due: "2026-09-20" });
    expect(t.status).toBe("understood");
    expect(t.kind).toBe("verbal");
    expect(t.due).toBe("2026-09-20");
    expect(listTasks().some((x) => x.id === t.id)).toBe(true);
  });

  it("超长的截断成标题，全文留在理解里", () => {
    const long = "补".repeat(120);
    const t = addNoteTask({ text: long });
    expect(t.title.length).toBeLessThanOrEqual(80);
    expect(t.title.endsWith("…")).toBe(true);
    expect(t.understanding).toBe(long);
    // 不超长的不重复存一份
    const short = addNoteTask({ text: "短的" });
    expect(short.understanding).toBeUndefined();
  });

  it("撤销是标 ignored，不物理删除", () => {
    const t = addNoteTask({ text: "这条会被撤销" });
    expect(dropNoteTask(t.id)).toBe(true);
    expect(listTasks().find((x) => x.id === t.id)!.status).toBe("ignored");
  });
});

describe("补搬 todos 表的孤儿待办", () => {
  it("只搬最近的、去重、搬过的不再搬第二遍", () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const now = Date.parse("2026-09-14T10:00:00Z");
    const old = new Date(now - 5 * 86_400_000).toISOString();
    addLocalTodo({ text: "今天记的 A" });
    addLocalTodo({ text: "今天记的 A" }); // 重复
    addLocalTodo({ text: "今天记的 B", due: "2026-09-30" });
    const stale = addLocalTodo({ text: "五天前记的" });
    db().prepare("UPDATE todos SET created_at = ? WHERE id = ?").run(old, stale.id);

    const moved = migrateLocalTodos(1, now);
    expect(moved).toBe(2); // 去重后两条，五天前那条不搬
    const titles = listTasks().map((t) => t.title);
    expect(titles).toContain("今天记的 A");
    expect(titles).toContain("今天记的 B");
    expect(titles).not.toContain("五天前记的");
    // 搬过的标成 done，再跑一次不会重复建
    expect(migrateLocalTodos(1, now)).toBe(0);
  });
});
