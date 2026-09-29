import { describe, expect, it } from "vitest";
import { AUTOSTART_CONFIDENCE, type Task } from "@friday/shared";

const AUTOSTART_MIN_CONFIDENCE = AUTOSTART_CONFIDENCE.default;
import { AUTOSTART_SETTLE_MS, eligible, pickAutostart, type AutostartEnv } from "./autostart.js";

const NOW = Date.parse("2026-09-28T10:00:00Z");
const env: AutostartEnv = { now: NOW, running: 0, minConfidence: AUTOSTART_MIN_CONFIDENCE };
const settled = new Date(NOW - AUTOSTART_SETTLE_MS - 1000).toISOString();

const defect = (over: Partial<Task> = {}, source: Task["source"] = {}): Task =>
  ({
    id: "t1",
    title: "【新WBO·股票数据】上市日提交不落库",
    kind: "meegle",
    status: "understood",
    priority: "normal",
    project: "whale-console",
    createdAt: settled,
    updatedAt: settled,
    ...over,
    source: {
      meegleType: "issue",
      intake: { kind: "start", confidence: 90, project: "whale-console", detail: "把 listing_date 按 YYYY-MM-DD HH:mm:ss 传", why: "根因和修法都写了", at: settled },
      ...source,
    },
  }) as Task;

describe("eligible：只放够具体、归属确定、没人碰过的缺陷", () => {
  it("标准缺陷放行", () => {
    expect(eligible(defect(), env)).toBeUndefined();
  });

  it("需求一律不接——要先对方案", () => {
    expect(eligible(defect({}, { meegleType: "story" }), env)).toBe("不是缺陷");
  });

  it("把握不够的不接", () => {
    expect(eligible(defect({}, { intake: { kind: "start", confidence: AUTOSTART_MIN_CONFIDENCE - 1, project: "whale-console", detail: "x", why: "", at: settled } }), env)).toMatch(/门槛/);
  });

  it("门槛按传进来的值判：75 放行 78，80 挡住 78", () => {
    const t = defect({}, { intake: { kind: "start", confidence: 78, project: "whale-console", detail: "x", why: "", at: settled } });
    expect(eligible(t, { ...env, minConfidence: 75 })).toBeUndefined();
    expect(eligible(t, { ...env, minConfidence: 80 })).toBe("把握 78，门槛 80");
  });

  it("intake 判成 ask / queue 的不接", () => {
    expect(eligible(defect({}, { intake: { kind: "queue", why: "描述太模糊", at: settled } }), env)).toBe("判成 queue：描述太模糊");
  });

  it("项目归属和 intake 判的不一致 → 不接，开错仓库最贵", () => {
    expect(eligible(defect({ project: "fe-wealth-admin" }), env)).toMatch(/intake 判的是 whale-console/);
    expect(eligible(defect({ project: undefined }), env)).toBe("没有项目归属");
  });

  it("已经有终端、或卡上挂着问题的不接", () => {
    expect(eligible(defect({}, { jobId: "j" }), env)).toBe("已经有终端");
    expect(eligible(defect({ attention: "intake" }), env)).toMatch(/问题/);
  });

  it("刚进来的等一个同步周期——缺陷描述刚建时常被反复改", () => {
    expect(eligible(defect({ createdAt: new Date(NOW - 60_000).toISOString() }), env)).toMatch(/等描述稳定/);
  });

  it("不在排队里的（processing / done）不看", () => {
    expect(eligible(defect({ status: "processing" }), env)).toBe("不在排队里");
    expect(pickAutostart([defect({ status: "processing" })], env)).toEqual([]);
  });
});

describe("pickAutostart：并发和每日上限", () => {
  it("同时只跑 1 条，优先级高的先", () => {
    const a = defect({ id: "a", priority: "low" });
    const b = defect({ id: "b", priority: "high" });
    expect(pickAutostart([a, b], env).map((t) => t.id)).toEqual(["b"]);
  });

  it("已有一条在跑就不开", () => {
    expect(pickAutostart([defect()], { ...env, running: 1 })).toEqual([]);
  });

  it("不设每天上限：前一条跑完就接下一条，只受「同时 1 条」约束", () => {
    const q = [defect({ id: "a" }), defect({ id: "b" })];
    expect(pickAutostart(q, env).map((t) => t.id)).toEqual(["a"]);
    expect(pickAutostart(q.slice(1), env).map((t) => t.id)).toEqual(["b"]);
  });
});
