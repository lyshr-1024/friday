import { describe, expect, it, vi } from "vitest";
vi.mock("../memory/projects.js", async (orig) => ({
  ...(await orig<typeof import("../memory/projects.js")>()),
  resolveProject: (q: string) => ({ kind: "match", project: { name: q, dir: `/tmp/${q}` } }),
}));
import { fridayToolList } from "./tools.js";
import { createSchedule, getSchedule, listSchedules, updateSchedule } from "../memory/schedules.js";

const call = async (name: string, args: Record<string, unknown>, conv?: string) => {
  const t = fridayToolList(conv).find((x) => x.name === name)!;
  const r = await t.handler(args as never, {});
  return (r.content[0] as { text: string }).text;
};

describe("定时任务工具", () => {
  it("schedule_add 校验不过就不登记", async () => {
    const before = listSchedules().length;
    expect(await call("schedule_add", { title: "x", cron: "0 25 * * *", executor: "friday", prompt: "p" })).toMatch(/没登记/);
    expect(listSchedules().length).toBe(before);
  });
  it("schedule_add 成功返回 id 和下次时间", async () => {
    const out = await call("schedule_add", { title: "早报", cron: "0 9 * * *", executor: "friday", prompt: "看看今天" });
    expect(out).toMatch(/s-[0-9a-f]{8}/);
    expect(out).toMatch(/每天 09:00/);
  });
  it("schedule_update 改完再校验", async () => {
    const s = createSchedule({ title: "u", cron: "0 9 * * *", executor: "friday", prompt: "p" });
    expect(await call("schedule_update", { id: s.id, cron: "bad" })).toMatch(/没改/);
    await call("schedule_update", { id: s.id, cron: "0 10 * * *" });
    expect(getSchedule(s.id)!.cron).toBe("0 10 * * *");
  });
  it("定时会话里 close_terminals 被拒", async () => {
    const s = createSchedule({ title: "c", cron: "0 9 * * *", executor: "friday", prompt: "p" });
    updateSchedule(s.id, { conversationId: "conv-sched" });
    expect(await call("close_terminals", { scope: "all" }, "conv-sched")).toMatch(/定时任务里不能关终端/);
  });
  it("schedule_update 改了项目 / 值守 / 模式就丢掉旧的长期卡，免得下一轮跑进旧项目的 worktree", async () => {
    const s = createSchedule({ title: "p", cron: "0 9 * * *", executor: "project", project: "a", prompt: "p" });
    updateSchedule(s.id, { anchorTaskId: "t-old" });
    await call("schedule_update", { id: s.id, prompt: "改提示词" });
    expect(getSchedule(s.id)!.anchorTaskId).toBe("t-old");
    await call("schedule_update", { id: s.id, project: "a" });
    expect(getSchedule(s.id)!.anchorTaskId).toBe("t-old");
    await call("schedule_update", { id: s.id, project: "b" });
    expect(getSchedule(s.id)!.anchorTaskId).toBeUndefined();
    updateSchedule(s.id, { anchorTaskId: "t-old2" });
    await call("schedule_update", { id: s.id, attended: true });
    expect(getSchedule(s.id)!.anchorTaskId).toBeUndefined();
    updateSchedule(s.id, { anchorTaskId: "t-old3" });
    await call("schedule_update", { id: s.id, mode: "fresh" });
    expect(getSchedule(s.id)!.anchorTaskId).toBeUndefined();
  });
  it("friday 执行方改模式丢掉旧会话", async () => {
    const s = createSchedule({ title: "f", cron: "0 9 * * *", executor: "friday", prompt: "p" });
    updateSchedule(s.id, { conversationId: "conv-old" });
    await call("schedule_update", { id: s.id, mode: "fresh" });
    expect(getSchedule(s.id)!.conversationId).toBeUndefined();
  });
  it("定时会话里不许登记 / 改 / 删定时任务，列表照样能看", async () => {
    const s = createSchedule({ title: "g", cron: "0 9 * * *", executor: "friday", prompt: "p" });
    updateSchedule(s.id, { conversationId: "conv-sched2" });
    const n = listSchedules().length;
    expect(await call("schedule_add", { title: "x", cron: "0 9 * * *", executor: "friday", prompt: "p" }, "conv-sched2")).toMatch(/定时任务里不能/);
    expect(listSchedules().length).toBe(n);
    expect(await call("schedule_update", { id: s.id, cron: "0 8 * * *" }, "conv-sched2")).toMatch(/定时任务里不能/);
    expect(getSchedule(s.id)!.cron).toBe("0 9 * * *");
    expect(await call("schedule_remove", { id: s.id }, "conv-sched2")).toMatch(/定时任务里不能/);
    expect(getSchedule(s.id)).toBeTruthy();
    expect(await call("schedules_list", {}, "conv-sched2")).toMatch(s.id);
  });
});
