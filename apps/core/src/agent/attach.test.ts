import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttachError, attach, detachSession, frameBuffer, resetAttachBreaker, setPtySpawner, subscribe, viewerSession } from "./attach.js";
import { setTmuxPath } from "./tmux.js";

let killed: string[] = [];
let n = 0;
let emit: (d: string) => void = () => {};
beforeEach(() => {
  vi.useFakeTimers();
  setTmuxPath("/fake/tmux");
  resetAttachBreaker();
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

  it("pty 退出：订阅方收到结束回调，观众注销", () => {
    let exit = () => {};
    setPtySpawner(() => ({ onData: () => ({ dispose() {} }), onExit: (fn) => { exit = fn; return { dispose() {} }; }, write: () => {}, resize: () => {}, kill: () => {} }));
    const id = attach("s1", "t", 80, 24);
    let ended = 0;
    subscribe(id, () => {}, () => ended++);
    exit();
    expect(ended).toBe(1);
    expect(viewerSession(id)).toBeUndefined();
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

describe("attach 拉起失败", () => {
  it("spawner 抛错：抛 AttachError，不登记观众", () => {
    setPtySpawner(() => { throw new Error("posix_spawnp failed"); });
    expect(() => attach("s1", "t", 80, 24)).toThrow(AttachError);
    detachSession("s1");
  });

  it("找不到 tmux：不调 spawner", () => {
    setTmuxPath(undefined);
    let called = 0;
    setPtySpawner(() => { called++; throw new Error("x"); });
    expect(() => attach("s1", "t", 80, 24)).toThrow(AttachError);
    expect(called).toBe(0);
  });

  it("连续失败 3 次熔断 60 秒：第 4 次不调 spawner，冷却后恢复", () => {
    let called = 0;
    setPtySpawner(() => { called++; throw new Error("posix_spawnp failed"); });
    for (let i = 0; i < 3; i++) expect(() => attach("s1", "t", 80, 24)).toThrow(AttachError);
    expect(called).toBe(3);
    expect(() => attach("s1", "t", 80, 24)).toThrow(/暂停/);
    expect(called).toBe(3);
    vi.advanceTimersByTime(61_000);
    expect(() => attach("s1", "t", 80, 24)).toThrow(AttachError);
    expect(called).toBe(4);
  });

  it("成功一次清零失败计数", () => {
    const ok = () => ({ onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), write: () => {}, resize: () => {}, kill: () => {} });
    let fail = true;
    setPtySpawner(() => { if (fail) throw new Error("x"); return ok(); });
    for (let i = 0; i < 2; i++) expect(() => attach("s1", "t", 80, 24)).toThrow();
    fail = false;
    const id = attach("s1", "t", 80, 24);
    fail = true;
    for (let i = 0; i < 2; i++) expect(() => attach("s1", "t", 80, 24)).toThrow(AttachError);
    fail = false;
    expect(viewerSession(attach("s1", "t", 80, 24))).toBe("s1");
    detachSession("s1");
    expect(viewerSession(id)).toBeUndefined();
  });
});

describe("同步输出整帧发", () => {
  const ON = "\x1b[?2026h";
  const OFF = "\x1b[?2026l";

  it("同步块没收口先攒着，收口后一次发出", () => {
    const out: string[] = [];
    const f = frameBuffer((d) => out.push(d));
    f.push(`${ON}\x1b[?25l第一段`);
    f.push("第二段");
    expect(out).toEqual([]);
    f.push(`\x1b[?25h${OFF}`);
    expect(out).toEqual([`${ON}\x1b[?25l第一段第二段\x1b[?25h${OFF}`]);
  });

  it("收口序列被切在两段之间也认得", () => {
    const out: string[] = [];
    const f = frameBuffer((d) => out.push(d));
    f.push(`${ON}x\x1b[?20`);
    f.push("26l");
    expect(out).toEqual([`${ON}x${OFF}`]);
  });

  it("不在同步块里的输出立刻发，打字回显不加延迟", () => {
    const out: string[] = [];
    const f = frameBuffer((d) => out.push(d));
    f.push("a");
    f.push("b");
    expect(out).toEqual(["a", "b"]);
  });

  it("一直不收口最多等 50ms", () => {
    const out: string[] = [];
    const f = frameBuffer((d) => out.push(d));
    f.push(`${ON}半帧`);
    vi.advanceTimersByTime(49);
    expect(out).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(out).toEqual([`${ON}半帧`]);
  });

  it("经 attach 订阅收到的是整帧", () => {
    const id = attach("s9", "t", 80, 24);
    const got: string[] = [];
    subscribe(id, (d) => got.push(d));
    emit(`${ON}一`);
    emit(`二${OFF}`);
    expect(got).toEqual([`${ON}一二${OFF}`]);
    detachSession("s9");
  });
});
