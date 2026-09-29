import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attach, detachSession, setPtySpawner, subscribe, viewerSession } from "./attach.js";

let killed: string[] = [];
let n = 0;
let emit: (d: string) => void = () => {};
beforeEach(() => {
  vi.useFakeTimers();
  killed = [];
  n = 0;
  setPtySpawner(() => {
    const id = `p${n++}`;
    return { onData: (fn) => { emit = fn; return { dispose() {} }; }, onExit: () => ({ dispose() {} }), write: () => {}, resize: () => {}, kill: () => void killed.push(id) };
  });
});
afterEach(() => vi.useRealTimers());

describe("attach 观众生命周期", () => {
  it("15 秒没人订阅就 detach", () => {
    const id = attach("s1", "t", 80, 24);
    vi.advanceTimersByTime(14_000);
    expect(viewerSession(id)).toBe("s1");
    vi.advanceTimersByTime(2_000);
    expect(viewerSession(id)).toBeUndefined();
    expect(killed).toEqual(["p0"]);
  });

  it("订阅后不再按超时回收", () => {
    const id = attach("s1", "t", 80, 24);
    const off = subscribe(id, () => {})!;
    vi.advanceTimersByTime(60_000);
    expect(killed).toEqual([]);
    off();
  });

  it("订阅之前 tmux 画的那一屏攒着，订阅时先补给它", () => {
    const id = attach("s1", "t", 80, 24);
    emit("整屏重绘");
    const got: string[] = [];
    const off = subscribe(id, (d) => got.push(d))!;
    emit("增量");
    expect(got).toEqual(["整屏重绘", "增量"]);
    off();
  });

  it("detachSession 只清该会话的观众", () => {
    const a = attach("s1", "t", 80, 24);
    const b = attach("s1", "t", 80, 24);
    const c = attach("s2", "u", 80, 24);
    detachSession("s1");
    expect(killed.sort()).toEqual(["p0", "p1"]);
    expect(viewerSession(a)).toBeUndefined();
    expect(viewerSession(b)).toBeUndefined();
    expect(viewerSession(c)).toBe("s2");
  });
});
