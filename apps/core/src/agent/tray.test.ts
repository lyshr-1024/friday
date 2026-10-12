import { describe, expect, it } from "vitest";
import { createTask, updateTask } from "../memory/tasks.js";
import { createTermSession } from "../memory/termSessions.js";
import { trayStatus } from "./tray.js";

const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
const ago = (min: number) => new Date(NOW - min * 60000).toISOString();

describe("菜单栏状态", () => {
  it("在问你 > 等你 > 在干活 > 空闲，计数只算要你出手的", () => {
    expect(trayStatus(NOW)).toEqual({ state: "idle", count: 0, items: [], doing: [] });
    createTask({ title: "卡住的", kind: "meegle", source: {}, status: "blocked" });
    expect(trayStatus(NOW)).toEqual({ state: "idle", count: 0, items: [], doing: [] });

    const busy = createTask({ title: "在跑的", kind: "code", source: {}, status: "processing" });
    createTermSession({ id: busy.id, project: "p", repoDir: "/r", tmuxName: "r-busy", kind: "interactive", jobId: "j1" });
    expect(trayStatus(NOW)).toMatchObject({ state: "working", count: 0 });

    const merge = createTask({ title: "合并分支", kind: "code", source: {}, status: "processing" });
    updateTask(merge.id, { pending: [{ id: "a", type: "git_merge", label: "合并", detail: "", payload: {}, at: ago(18) }] });
    const waiting = trayStatus(NOW);
    expect(waiting).toMatchObject({ state: "waiting", count: 1 });
    expect(waiting.items[0]).toEqual({ text: "待你决定 · 合并分支（18 分钟）", kind: "waiting", taskId: merge.id });

    const ask = createTask({ title: "要不要带上 sit", kind: "code", source: {}, status: "processing" });
    createTermSession({ id: ask.id, project: "p", repoDir: "/r", tmuxName: "r-ask", kind: "interactive", jobId: "j2" });
    updateTask(ask.id, { attention: "question" });
    const asking = trayStatus(NOW);
    expect(asking).toMatchObject({ state: "asking", count: 2 });
    expect(asking.items.map((i) => i.kind)).toEqual(["asking", "waiting"]);
  });

  it("Friday 在做只列它自己全权跑的", () => {
    const auto = createTask({ title: "自主修缺陷", kind: "meegle", source: { autonomous: true }, status: "processing" });
    expect(trayStatus(NOW).doing).toContainEqual({ taskId: auto.id, title: "自主修缺陷" });
    expect(trayStatus(NOW).doing.map((d) => d.title)).not.toContain("在跑的");
  });
});
