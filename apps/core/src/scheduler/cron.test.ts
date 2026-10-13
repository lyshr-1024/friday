import { describe, expect, it } from "vitest";
import { describeCron, lastDue, nextDue, validateCron } from "./cron.js";

// 上海 10:00 = UTC 02:00
const sh = (iso: string) => new Date(`${iso}+08:00`);

describe("cron", () => {
  it("不合法的拒掉，五段才算", () => {
    expect(validateCron("0 25 * * *")).toBeTruthy();
    expect(validateCron("每天十点")).toBeTruthy();
    expect(validateCron("0 0 10 * * *")).toBeTruthy();
    expect(validateCron("0 10 * * *")).toBeUndefined();
  });

  it("lastDue 取区间里最后一个到点", () => {
    expect(lastDue("0 10 * * *", sh("2026-10-13T09:00:00"), sh("2026-10-13T10:00:30"))?.toISOString()).toBe(sh("2026-10-13T10:00:00").toISOString());
    expect(lastDue("0 10 * * *", sh("2026-10-13T10:00:00"), sh("2026-10-13T11:00:00"))).toBeUndefined();
    expect(lastDue("*/5 * * * *", sh("2026-10-13T09:00:00"), sh("2026-10-13T09:17:00"))?.toISOString()).toBe(sh("2026-10-13T09:15:00").toISOString());
  });

  it("nextDue 按上海时区", () => {
    expect(nextDue("0 10 * * *", sh("2026-10-13T11:00:00"))?.toISOString()).toBe(sh("2026-10-14T10:00:00").toISOString());
  });

  it("常见形态翻成中文，其余原样", () => {
    expect(describeCron("0 10 * * *")).toBe("每天 10:00");
    expect(describeCron("30 9 * * 1-5")).toBe("工作日 09:30");
    expect(describeCron("0 16 * * 5")).toBe("每周五 16:00");
    expect(describeCron("0 9 * * 1,3")).toBe("每周一、三 09:00");
    expect(describeCron("15 * * * *")).toBe("每小时第 15 分");
    expect(describeCron("*/10 * * * *")).toBe("每 10 分钟");
    expect(describeCron("* * * * *")).toBe("每分钟");
    expect(describeCron("0 10 1 * *")).toBe("每月 1 日 10:00");
    expect(describeCron("0 10 1 6 *")).toBe("0 10 1 6 *");
  });
});
