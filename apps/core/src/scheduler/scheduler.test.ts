import { afterEach, describe, expect, it, vi } from "vitest";
import { intervalMs, isActive, kickAutostart, startScheduler } from "./index.js";
import { briefTick } from "../agent/briefJob.js";
import { autostartTick } from "../agent/autostart.js";

vi.mock("../agent/briefJob.js", async (orig) => ({ ...(await orig<typeof import("../agent/briefJob.js")>()), briefTick: vi.fn(async () => "idle" as const) }));
vi.mock("../agent/autostart.js", async (orig) => ({ ...(await orig<typeof import("../agent/autostart.js")>()), autostartTick: vi.fn(async () => 0) }));

const at = (hourShanghai: number) => new Date(Date.UTC(2026, 8, 4, (hourShanghai - 8 + 24) % 24, 30));

describe("调度节奏", () => {
  it("10:00–20:00 三分钟一轮，其余十五分钟", () => {
    expect(isActive(at(10))).toBe(true);
    expect(isActive(at(19))).toBe(true);
    expect(isActive(at(20))).toBe(false);
    expect(isActive(at(3))).toBe(false);
    expect(intervalMs(at(12))).toBe(3 * 60_000);
    expect(intervalMs(at(22))).toBe(15 * 60_000);
  });
});

describe("kickAutostart：卡交了 / 批了立刻补跑一次", () => {
  afterEach(() => vi.useRealTimers());
  it("调度器没启动：什么都不做；启动后触发一次建卡和开工，同时只跑一个", async () => {
    kickAutostart();
    await new Promise((r) => setImmediate(r));
    expect(briefTick).not.toHaveBeenCalled();
    expect(autostartTick).not.toHaveBeenCalled();
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    startScheduler();
    kickAutostart();
    kickAutostart();
    await vi.waitFor(() => expect(autostartTick).toHaveBeenCalledTimes(1));
    expect(briefTick).toHaveBeenCalledTimes(1);
    kickAutostart();
    await vi.waitFor(() => expect(autostartTick).toHaveBeenCalledTimes(2));
  });
});
