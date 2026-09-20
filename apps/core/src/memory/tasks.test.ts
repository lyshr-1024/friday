import { describe, expect, it } from "vitest";
import { initMemory } from "./db.js";
import { addPending, createTask, findTaskBySource, listTasks, takePending, taskBoard, updateTask } from "./tasks.js";
import { listAudit, record, setEventStatus, undoPlan } from "./audit.js";

describe("任务中枢", () => {
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


