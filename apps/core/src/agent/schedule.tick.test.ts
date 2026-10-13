import { describe, expect, it, vi } from "vitest";
vi.mock("./runs.js", () => ({ isRunning: vi.fn(() => false), startRun: vi.fn(), subscribe: vi.fn(() => () => {}) }));
import { isRunning } from "./runs.js";
import { scheduleTick } from "./schedule.js";
import { createSchedule, getSchedule, listSchedules, deleteSchedule, updateSchedule } from "../memory/schedules.js";
import { db } from "../memory/db.js";

const sh = (iso: string) => new Date(`${iso}+08:00`);
const clean = () => listSchedules().forEach((s) => deleteSchedule(s.id));
const backdate = (id: string, iso: string) => db().prepare("UPDATE schedules SET created_at = ? WHERE id = ?").run(iso, id);

describe("scheduleTick", () => {
  it("到点跑一次，同一分钟再 tick 不重复", async () => {
    clean();
    const s = createSchedule({ title: "a", cron: "0 10 * * *", executor: "friday", prompt: "p" });
    backdate(s.id, sh("2026-10-12T00:00:00").toISOString());
    const fire = vi.fn(async () => ({ ok: true, result: "ok" }));
    expect(await scheduleTick(sh("2026-10-13T10:00:20"), fire)).toBe(1);
    expect(await scheduleTick(sh("2026-10-13T10:00:50"), fire)).toBe(0);
    expect(getSchedule(s.id)!.lastRunAt).toBeTruthy();
  });

  it("错过补一次：下午醒来只跑一次", async () => {
    clean();
    const s = createSchedule({ title: "b", cron: "*/30 * * * *", executor: "friday", prompt: "p" });
    backdate(s.id, sh("2026-10-13T08:00:00").toISOString());
    const fire = vi.fn(async () => ({ ok: true, result: "ok" }));
    expect(await scheduleTick(sh("2026-10-13T15:10:00"), fire)).toBe(1);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("超过 12 小时不补，写一句原因", async () => {
    clean();
    const s = createSchedule({ title: "c", cron: "0 10 * * 1", executor: "friday", prompt: "p" });
    backdate(s.id, sh("2026-10-01T00:00:00").toISOString());
    const fire = vi.fn(async () => ({ ok: true, result: "ok" }));
    expect(await scheduleTick(sh("2026-10-13T23:00:00"), fire)).toBe(0);
    expect(fire).not.toHaveBeenCalled();
    expect(getSchedule(s.id)!.lastResult).toMatch(/超过 12 小时/);
  });

  it("创建之前的到点不算", async () => {
    clean();
    const s = createSchedule({ title: "d", cron: "0 10 * * *", executor: "friday", prompt: "p" });
    backdate(s.id, sh("2026-10-13T10:30:00").toISOString());
    const fire = vi.fn(async () => ({ ok: true, result: "ok" }));
    expect(await scheduleTick(sh("2026-10-13T11:00:00"), fire)).toBe(0);
  });

  it("关掉的不跑；上一轮没完跳过并写原因", async () => {
    clean();
    const s = createSchedule({ title: "e", cron: "0 10 * * *", executor: "friday", prompt: "p", enabled: false });
    backdate(s.id, sh("2026-10-12T00:00:00").toISOString());
    const fire = vi.fn(async () => ({ ok: true, result: "ok" }));
    expect(await scheduleTick(sh("2026-10-13T10:00:20"), fire)).toBe(0);
    updateSchedule(s.id, { enabled: true, conversationId: "c-busy2" }, sh("2026-10-12T12:00:00"));
    vi.mocked(isRunning).mockReturnValueOnce(true);
    expect(await scheduleTick(sh("2026-10-13T10:00:20"), fire)).toBe(0);
    expect(getSchedule(s.id)!.lastResult).toMatch(/还在/);
  });

  it("一条抛错不影响下一条", async () => {
    clean();
    for (const t of ["x", "y"]) backdate(createSchedule({ title: t, cron: "0 10 * * *", executor: "friday", prompt: "p" }).id, sh("2026-10-12T00:00:00").toISOString());
    const fire = vi.fn().mockRejectedValueOnce(new Error("炸")).mockResolvedValueOnce({ ok: true, result: "ok" });
    expect(await scheduleTick(sh("2026-10-13T10:00:20"), fire)).toBe(1);
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it("tick 重入：上一轮 tick 没完时直接返回 0", async () => {
    clean();
    backdate(createSchedule({ title: "z", cron: "0 10 * * *", executor: "friday", prompt: "p" }).id, sh("2026-10-12T00:00:00").toISOString());
    let release!: () => void;
    const fire = vi.fn(() => new Promise<{ ok: boolean; result: string }>((r) => { release = () => r({ ok: true, result: "ok" }); }));
    const first = scheduleTick(sh("2026-10-13T10:00:20"), fire);
    expect(await scheduleTick(sh("2026-10-13T10:00:30"), fire)).toBe(0);
    release();
    expect(await first).toBe(1);
  });

  it("暂停期间错过的那次，恢复开关后不补跑；明天照常", async () => {
    clean();
    const s = createSchedule({ title: "f", cron: "0 10 * * *", executor: "friday", prompt: "p" });
    backdate(s.id, sh("2026-10-12T00:00:00").toISOString());
    updateSchedule(s.id, { enabled: false }, sh("2026-10-13T09:00:00"));
    updateSchedule(s.id, { enabled: true }, sh("2026-10-13T10:30:00"));
    const fire = vi.fn(async () => ({ ok: true, result: "ok" }));
    expect(await scheduleTick(sh("2026-10-13T10:31:00"), fire)).toBe(0);
    expect(getSchedule(s.id)!.lastRunAt).toBeUndefined();
    expect(await scheduleTick(sh("2026-10-14T10:00:20"), fire)).toBe(1);
  });

  it("改 cron 不会把刚变成「已过」的那个点立刻补跑", async () => {
    clean();
    const s = createSchedule({ title: "g", cron: "0 10 * * *", executor: "friday", prompt: "p" });
    backdate(s.id, sh("2026-10-12T00:00:00").toISOString());
    updateSchedule(s.id, { cron: "0 9 * * *" }, sh("2026-10-13T09:30:00"));
    const fire = vi.fn(async () => ({ ok: true, result: "ok" }));
    expect(await scheduleTick(sh("2026-10-13T09:31:00"), fire)).toBe(0);
    expect(await scheduleTick(sh("2026-10-14T09:00:20"), fire)).toBe(1);
  });

  it("只改标题、或本来就开着再开一次，不重新起算", async () => {
    clean();
    const s = createSchedule({ title: "h", cron: "0 10 * * *", executor: "friday", prompt: "p" });
    backdate(s.id, sh("2026-10-12T00:00:00").toISOString());
    updateSchedule(s.id, { title: "h2", enabled: true, cron: "0 10 * * *" }, sh("2026-10-13T10:30:00"));
    const fire = vi.fn(async () => ({ ok: true, result: "ok" }));
    expect(await scheduleTick(sh("2026-10-13T10:31:00"), fire)).toBe(1);
  });
});
