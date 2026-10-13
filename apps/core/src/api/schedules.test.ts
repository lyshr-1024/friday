import { describe, expect, it, vi } from "vitest";
vi.mock("../agent/schedule.js", async (orig) => ({ ...(await orig<typeof import("../agent/schedule.js")>()), fireSchedule: vi.fn(async () => ({ ok: true, result: "跑了", ref: "r1" })) }));
import { schedules } from "./schedules.js";
import { createSchedule, getSchedule } from "../memory/schedules.js";

describe("/schedules", () => {
  it("列、关、跑、删", async () => {
    const s = createSchedule({ title: "a", cron: "0 10 * * *", executor: "friday", prompt: "p" });
    const list = await (await schedules.request("/schedules")).json() as { items: Array<{ id: string; when: string }> };
    expect(list.items.find((x) => x.id === s.id)?.when).toBe("每天 10:00");
    expect((await schedules.request(`/schedules/${s.id}`, { method: "PATCH", body: JSON.stringify({ enabled: false }), headers: { "content-type": "application/json" } })).status).toBe(200);
    expect(getSchedule(s.id)!.enabled).toBe(false);
    const run = await (await schedules.request(`/schedules/${s.id}/run`, { method: "POST" })).json() as { result: string };
    expect(run.result).toBe("跑了");
    expect(getSchedule(s.id)!.lastResult).toBe("跑了");
    expect((await schedules.request(`/schedules/${s.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await schedules.request(`/schedules/${s.id}`, { method: "DELETE" })).status).toBe(404);
  });
});
