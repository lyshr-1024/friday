import { describe, expect, it } from "vitest";
import { parseWeek, targetWeek, weekOf } from "./week.js";

const d = (s: string) => new Date(s);

describe("周的口径", () => {
  it("周一到周日，标识跟平台一致", () => {
    expect(weekOf(d("2026-09-24T10:00")).id).toBe("2026W0921-0927");
    expect(weekOf(d("2026-09-27T23:59")).id).toBe("2026W0921-0927");
    expect(weekOf(d("2026-09-28T00:00")).id).toBe("2026W0928-1004");
  });

  it("跨年周按周一所在年", () => {
    expect(weekOf(d("2027-01-02T12:00")).id).toBe("2026W1228-0103");
  });

  it("周五 16:00 起算本周，之前算上周", () => {
    expect(targetWeek(d("2026-09-25T15:59")).id).toBe("2026W0914-0920");
    expect(targetWeek(d("2026-09-25T16:00")).id).toBe("2026W0921-0927");
    expect(targetWeek(d("2026-09-27T23:59")).id).toBe("2026W0921-0927");
    expect(targetWeek(d("2026-09-28T09:00")).id).toBe("2026W0921-0927");
  });

  it("parseWeek 认回来，格式不对或不是周一就不认", () => {
    const w = parseWeek("2026W0921-0927")!;
    expect(w.start.getDay()).toBe(1);
    expect(w.id).toBe("2026W0921-0927");
    expect(parseWeek("2026W0922-0928")).toBeUndefined();
    expect(parseWeek("本周")).toBeUndefined();
  });
});
