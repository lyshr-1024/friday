import { describe, expect, it } from "vitest";
import { initMemory } from "../memory/db.js";
import { createTask, getTask, updateTask } from "../memory/tasks.js";
import { listAudit } from "../memory/audit.js";
import { signalScore } from "../memory/stageSignals.js";
import { PROMOTE_AFTER, answerHint, isAdvance, onSignal, onSlackAccepted, saysAccepted, setStage } from "./stage.js";

const mk = (stage: "todo" | "dev" | "testing" | "accepted" | "released" = "todo") => {
  const t = createTask({ title: `活 ${Math.random()}`, kind: "meegle", source: { meegleId: String(Math.random()) }, project: "demo" });
  return updateTask(t.id, { stage })!;
};

describe("任务阶段", () => {
  it("只认往前的方向", () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    expect(isAdvance("todo", "dev")).toBe(true);
    expect(isAdvance(undefined, "dev")).toBe(true);
    expect(isAdvance("testing", "dev")).toBe(false);
    expect(isAdvance("dev", "dev")).toBe(false);
  });

  it("强信号直接推并记一笔可撤的账", () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const t = mk("todo");
    const r = onSignal(t.id, { signal: "branch_commit", to: "dev", ask: "开始了？", why: "建了分支还有 commit" });
    expect(r.kind).toBe("advanced");
    expect(getTask(t.id)!.stage).toBe("dev");
    expect(getTask(t.id)!.stageBy).toBe("auto");
    const ev = listAudit({ taskId: t.id }).find((e) => e.action === "stage_advance")!;
    expect(ev.reversible).toBe(true);
  });

  it("弱信号只挂一问，不动阶段", () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const t = mk("dev");
    const r = onSignal(t.id, { signal: "mr_opened", to: "testing", ask: "看起来提测了？", why: "MR 建了" });
    expect(r.kind).toBe("asked");
    const after = getTask(t.id)!;
    expect(after.stage).toBe("dev");
    expect(after.stageHint?.to).toBe("testing");
  });

  it("弱信号被确认够次数就升级成强信号，往后直接推", () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const sig = `mr_${Math.random()}`;
    for (let i = 0; i < PROMOTE_AFTER; i++) {
      const t = mk("dev");
      onSignal(t.id, { signal: sig, to: "testing", ask: "提测了？", why: "MR" });
      answerHint(t.id, true);
      expect(getTask(t.id)!.stage).toBe("testing");
    }
    expect(signalScore(sig).confirmed).toBe(PROMOTE_AFTER);
    // 攒够之后同一条信号不再问，直接推
    const t = mk("dev");
    expect(onSignal(t.id, { signal: sig, to: "testing", ask: "提测了？", why: "MR" }).kind).toBe("advanced");
  });

  it("被否过的信号不升级，哪怕确认次数够了", () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const sig = `flaky_${Math.random()}`;
    const no = mk("dev");
    onSignal(no.id, { signal: sig, to: "testing", ask: "提测了？", why: "MR" });
    answerHint(no.id, false);
    for (let i = 0; i < PROMOTE_AFTER; i++) {
      const t = mk("dev");
      onSignal(t.id, { signal: sig, to: "testing", ask: "提测了？", why: "MR" });
      answerHint(t.id, true);
    }
    const t = mk("dev");
    expect(onSignal(t.id, { signal: sig, to: "testing", ask: "提测了？", why: "MR" }).kind).toBe("asked");
  });

  it("没有 stage 的任务（Slack 回消息）不参与阶段", () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const t = createTask({ title: "回个消息", kind: "slack", source: { threadId: `th-${Math.random()}` } });
    expect(onSignal(t.id, { signal: "branch_commit", to: "dev", ask: "", why: "" }).kind).toBe("skipped");
  });

  it("往回拨：说「Friday 推错了」才记到信号头上", () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const t = mk("dev");
    onSignal(t.id, { signal: "terminal_delivered", to: "testing", ask: "", why: "终端交付了" });
    const before = signalScore("terminal_delivered").rejected;
    setStage(t.id, "dev", "misjudged", "其实还没提测");
    expect(getTask(t.id)!.stage).toBe("dev");
    expect(signalScore("terminal_delivered").rejected).toBe(before + 1);
  });

  it("往回拨：说「确实被打回了」不记账到信号，免得它越学越不敢推", () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const t = mk("dev");
    onSignal(t.id, { signal: "terminal_delivered", to: "testing", ask: "", why: "终端交付了" });
    const before = signalScore("terminal_delivered").rejected;
    setStage(t.id, "dev", "bounced", "测试提了三个问题");
    expect(getTask(t.id)!.stage).toBe("dev");
    expect(signalScore("terminal_delivered").rejected).toBe(before);
    const ev = listAudit({ taskId: t.id }).find((e) => e.action === "stage_rollback")!;
    expect(ev.evidence.reason).toBe("bounced");
  });

  it("上线即终态：status 跟着 done，往回拨能回板上", () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const t = mk("accepted");
    setStage(t.id, "released");
    const done = getTask(t.id)!;
    expect(done.stage).toBe("released");
    expect(done.status).toBe("done");
    expect(done.releasedAt).toBeTruthy();
    setStage(t.id, "testing", "bounced", "上线后回滚了");
    const back = getTask(t.id)!;
    expect(back.status).not.toBe("done");
    expect(back.releasedAt).toBeUndefined();
  });

  it("认得出说死了的验收，含糊的不认", () => {
    expect(saysAccepted("这个验收通过了")).toBe(true);
    expect(saysAccepted("验收过了，可以发")).toBe(true);
    expect(saysAccepted("测试通过")).toBe(true);
    expect(saysAccepted("可以上线")).toBe(true);
    // 含糊的不能算——误判会把没验收的活推到「待发布」
    expect(saysAccepted("看起来没问题")).toBe(false);
    expect(saysAccepted("应该可以吧")).toBe(false);
    expect(saysAccepted("我再看看")).toBe(false);
    expect(saysAccepted("验收不通过")).toBe(false);
  });

  it("Slack 说验收过了：挂一问，不直接推", () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const t = mk("testing");
    const r = onSlackAccepted(t.id, "这个我验收过了，可以发", "拂晓");
    expect(r.kind).toBe("asked");
    const after = getTask(t.id)!;
    expect(after.stage).toBe("testing");
    expect(after.stageHint?.to).toBe("accepted");
    expect(after.stageHint?.ask).toContain("拂晓");
  });

  it("Slack 里没说验收的话不动它", () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const t = mk("testing");
    expect(onSlackAccepted(t.id, "这个什么时候能好", "拂晓").kind).toBe("skipped");
    expect(getTask(t.id)!.stageHint).toBeUndefined();
  });

  it("答「不是」只清掉那一问，阶段不动", () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const t = mk("dev");
    onSignal(t.id, { signal: `x_${Math.random()}`, to: "testing", ask: "提测了？", why: "MR" });
    answerHint(t.id, false);
    const after = getTask(t.id)!;
    expect(after.stage).toBe("dev");
    expect(after.stageHint).toBeUndefined();
  });
});
