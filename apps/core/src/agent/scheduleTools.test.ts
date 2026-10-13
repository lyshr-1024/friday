import { describe, expect, it } from "vitest";
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
});
