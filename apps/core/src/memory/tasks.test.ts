import { describe, expect, it } from "vitest";
import { initMemory } from "./db.js";
import { addPending, createTask, deleteTask, findTaskByRef, getTask, restoreTask, findTaskBySource, listTasks, listTasksByKind, takePending, taskBoard, tasksByIdPrefix, updateTask } from "./tasks.js";
import { db } from "./db.js";
import { listAudit, record, setEventStatus, undoPlan } from "./audit.js";

describe("任务中枢", () => {
  it("全数字的 id 前缀不被当成短号吃掉；#N 仍优先按短号", () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const t = createTask({ title: "数字 id", kind: "verbal", source: {} });
    const id = "20261022-aaaa-4bbb-8ccc-000000000001";
    db().prepare("UPDATE tasks SET id = ? WHERE id = ?").run(id, t.id);
    expect(findTaskByRef("20261022")!.id).toBe(id);
    expect(findTaskByRef(`#${t.seq}`)!.id).toBe(id);
  });

  it("撤销删除：快照没有 seq 就取新号，有且没被占用就保留，被占用也取新号", () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const a = createTask({ title: "删我", kind: "verbal", source: {} });
    const row = deleteTask(a.id)!;
    const old = { ...row } as Record<string, unknown>;
    delete old.seq;
    const next = createTask({ title: "后来的", kind: "verbal", source: {} });
    expect(restoreTask(old as never)).toBe(true);
    const back = getTask(a.id)!;
    expect(back.seq).toBeGreaterThan(next.seq);

    const b = createTask({ title: "再删", kind: "verbal", source: {} });
    const rowB = deleteTask(b.id)!;
    restoreTask(rowB);
    expect(getTask(b.id)!.seq).toBe(b.seq);

    const c = createTask({ title: "占号", kind: "verbal", source: {} });
    const rowC = deleteTask(c.id)!;
    const d = createTask({ title: "顶号", kind: "verbal", source: {} });
    db().prepare("UPDATE tasks SET seq = ? WHERE id = ?").run(c.seq, d.id);
    restoreTask(rowC);
    expect(getTask(c.id)!.seq).not.toBe(c.seq);
    expect(getTask(d.id)!.seq).toBe(c.seq);
  });

  it("新任务按顺序拿短号，#N / 数字 / id 前缀都能找回", () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const a = createTask({ title: "甲", kind: "verbal", source: {} });
    const b = createTask({ title: "乙", kind: "verbal", source: {} });
    expect(b.seq).toBe(a.seq + 1);
    expect(findTaskByRef(`#${b.seq}`)!.id).toBe(b.id);
    expect(findTaskByRef(String(a.seq))!.id).toBe(a.id);
    expect(findTaskByRef(b.id.slice(0, 8))!.id).toBe(b.id);
    expect(findTaskByRef(b.id)!.id).toBe(b.id);
    expect(findTaskByRef("#999999")).toBeUndefined();
  });


  it("建任务、按来源去重、推进状态、待审核动作进出", () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const t = createTask({ title: "回复灵雨：登录报错", kind: "slack", source: { threadId: "th-1" }, project: "whale-console", priority: "high", understanding: "灵雨追问工单 #1" });
    expect(t.status).toBe("collected");
    expect(findTaskBySource((s) => s.threadId === "th-1")?.id).toBe(t.id);
    updateTask(t.id, { status: "processing", plan: "先查工单再回" });
    const withPending = addPending(t.id, { type: "slack_reply", label: "发回复", detail: "回复灵雨", payload: { channel: "D1", text: "看到了" } })!;
    expect(withPending.status).toBe("review");
    expect(withPending.pending).toHaveLength(1);
    const taken = takePending(t.id, withPending.pending![0]!.id)!;
    expect(taken.action.type).toBe("slack_reply");
    expect(taken.task.pending).toBeUndefined();
    updateTask(t.id, { status: "done" });
    expect(findTaskBySource((s) => s.threadId === "th-1")).toBeUndefined();
    expect(listTasks("done").map((x) => x.id)).toContain(t.id);
    expect(taskBoard().counts.done).toBe(1);
  });

  it("周报和手册改动不上任务板，按类型能列全（连已忽略的）", () => {
    const w = createTask({ title: "OKR 周报 · 2026W0928-1004", kind: "okr_weekly", source: { okrWeek: "2026W0928-1004" }, status: "review" });
    const h = createTask({ title: "手册改动", kind: "handbook", source: {}, status: "review" });
    updateTask(h.id, { status: "ignored" });
    const ids = taskBoard().tasks.map((t) => t.id);
    expect(ids).not.toContain(w.id);
    expect(ids).not.toContain(h.id);
    expect(listTasksByKind("okr_weekly").map((t) => t.id)).toEqual([w.id]);
    expect(listTasksByKind("handbook").map((t) => t.id)).toEqual([h.id]);
  });
});

describe("账本", () => {
  it("记账、按任务查、撤销说明书、状态流转", () => {
    const t = createTask({ title: "记待办", kind: "verbal", source: { note: "周五前补 README" } });
    const ev = record({ taskId: t.id, action: "todo_add", why: "用户口头交代", how: "addLocalTodo", evidence: { text: "补 README" }, risk: "reversible", undo: { kind: "delete_todo", id: "todo-1" } });
    expect(ev.reversible).toBe(true);
    expect(listAudit({ taskId: t.id })[0]!.action).toBe("todo_add");
    expect(undoPlan(ev.id)).toEqual({ kind: "delete_todo", id: "todo-1" });
    expect(setEventStatus(ev.id, "undone")).toBe(true);
    const ro = record({ action: "meegle_lookup", why: "做功课", how: "meegle workitem get", risk: "read" });
    expect(ro.reversible).toBe(false);
    expect(listAudit({ limit: 5 }).length).toBeGreaterThanOrEqual(2);
  });
});

describe("按 id 前缀找任务", () => {
  it("前缀匹配；带非十六进制字符的不查", () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const t = createTask({ title: "前缀", kind: "verbal", source: {} });
    expect(tasksByIdPrefix(t.id.slice(0, 8)).map((x) => x.id)).toEqual([t.id]);
    expect(tasksByIdPrefix(t.id)).toHaveLength(1);
    expect(tasksByIdPrefix("%")).toEqual([]);
    expect(tasksByIdPrefix(`${t.id.slice(0, 4)}_`)).toEqual([]);
    expect(tasksByIdPrefix("")).toEqual([]);
  });
});
