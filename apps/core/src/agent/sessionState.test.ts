import { describe, expect, it } from "vitest";
import type { TermSession } from "@friday/shared";
import { sessionState, taskSession } from "./sessionState.js";
import { createTask, getTask } from "../memory/tasks.js";
import { createTermSession, updateTermSession } from "../memory/termSessions.js";

const T = (iso: number) => new Date(Date.UTC(2026, 8, 29, 12, 0, iso)).toISOString();
const S = (p: Partial<TermSession>): TermSession => ({ id: "r", project: "p", repoDir: "/r", tmuxName: "r", kind: "interactive", status: "running", createdAt: T(0), updatedAt: T(0), ...p });
const task = (p: Record<string, unknown> = {}) => ({ status: "processing" as const, ...p });

describe("状态位只取终端里的现实", () => {
  it("在问你压过一切", () => {
    expect(sessionState(task({ attention: "question", pending: [{}] }) as never, S({ lastInputAt: T(5), lastStopAt: T(1) }))).toBe("asking");
  });
  it("输入晚于 Stop = 干活中；准备段也算干活中", () => {
    expect(sessionState(task() as never, S({ lastInputAt: T(5), lastStopAt: T(1) }))).toBe("working");
    expect(sessionState(task() as never, S({ status: "preparing", lastInputAt: T(0) }))).toBe("preparing");
  });
  it("Stop 晚于看过 = 等你输入；看过之后变空闲", () => {
    expect(sessionState(task() as never, S({ lastInputAt: T(1), lastStopAt: T(5), seenAt: T(2) }))).toBe("awaiting");
    expect(sessionState(task() as never, S({ lastInputAt: T(1), lastStopAt: T(5), seenAt: T(6) }))).toBe("idle");
  });
  it("挂着待审动作 = 待你决定；卡住；Claude 已退出；没有会话", () => {
    expect(sessionState(task({ pending: [{}] }) as never, S({ status: "exited" }))).toBe("deciding");
    expect(sessionState(task({ status: "blocked" }) as never, S({ status: "exited" }))).toBe("blocked");
    expect(sessionState(task() as never, S({ status: "exited" }))).toBe("exited");
    expect(sessionState(task({ status: "understood" }) as never, undefined)).toBe("none");
    expect(sessionState(task() as never, S({ status: "closed" }))).toBe("none");
  });
});

describe("任务卡上的会话", () => {
  it("关掉的会话不再给名字（前端据此给「开始做」）；退出的给名字和状态（给「接着聊」）", () => {
    const t = createTask({ title: "会话状态", kind: "verbal", source: {}, status: "processing" });
    createTermSession({ id: t.id, project: "p", repoDir: "/r", tmuxName: "r-x", kind: "interactive", jobId: "j" });
    updateTermSession(t.id, { status: "exited", worktree: "/r-wt" });
    expect(taskSession(getTask(t.id)!)).toMatchObject({ state: "exited", name: "r-x", status: "exited", worktree: "/r-wt" });
    updateTermSession(t.id, { status: "closed" });
    const closed = taskSession(getTask(t.id)!);
    expect(closed.name).toBeUndefined();
    expect(closed.status).toBeUndefined();
    expect(closed.state).toBe("none");
  });

  it("缺陷的 rootId 指向已收工的需求：看它自己的会话", () => {
    const story = createTask({ title: "收工需求", kind: "meegle", source: {}, status: "done" });
    const bug = createTask({ title: "自己当根", kind: "meegle", source: { rootId: story.id }, status: "processing" });
    createTermSession({ id: bug.id, project: "p", repoDir: "/r", tmuxName: "r-bug", kind: "interactive", jobId: "j2" });
    expect(taskSession(getTask(bug.id)!).name).toBe("r-bug");
  });
});
