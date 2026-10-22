import { beforeEach, describe, expect, it } from "vitest";
import { createTask, getTask, updateTask } from "../memory/tasks.js";
import { clearAwaiting, createJob, getJob, markAwaiting, recordTerminalInput } from "../memory/jobs.js";
import { updateTermSession } from "../memory/termSessions.js";
import { setTmuxRunner } from "./tmux.js";
import { setClaudeFinder } from "./runner.js";
import { openSession, sayToSession, setLauncher } from "./sessions.js";
import { NUDGE_TEXT, roundStopped, stalledStarts, userPrompted } from "./rounds.js";
import { app } from "../api/index.js";
import { db } from "../memory/db.js";
import { setJobSession } from "../memory/jobs.js";
import { vi } from "vitest";
import { mainRepo } from "./testRepos.js";

let calls: string[][] = [];
const alive = new Set<string>();
beforeEach(() => {
  calls = [];
  setClaudeFinder(async () => "/bin/claude");
  setTmuxRunner(async (args) => {
    calls.push(args);
    if (args[0] === "-V") return "tmux 3.5a";
    const sub = args[4];
    const target = (args[args.indexOf("-t") + 1] ?? "").replace(/^=/, "").replace(/:.*$/, "");
    if (sub === "has-session" && !alive.has(target)) throw new Error("can't find session");
    if (sub === "list-windows") return "0|claude|1\n";
    return "";
  });
  setLauncher(async (_req, name) => void alive.add(name));
});

const typed = () => calls.filter((c) => c[4] === "send-keys" && c.includes("-l")).map((c) => c.at(-1)!);

async function fridayRun(source: Record<string, unknown> = { autonomous: true }, kind: "autonomous" | "interactive" = "autonomous") {
  const t = createTask({ title: "一轮", kind: "verbal", source, status: "processing", project: "app" });
  const job = await openSession(t, t, { kind, project: "app", repoDir: mainRepo("app"), task: "改" });
  updateTermSession(t.id, { status: "running" });
  calls = [];
  return { task: t.id, job };
}

describe("停了没交付", () => {
  it("Friday 发起的一轮停了没交付：第一次催，第二次标卡住", async () => {
    const { task, job } = await fridayRun();
    expect(await roundStopped(job)).toBe("nudged");
    expect(typed()).toEqual([NUDGE_TEXT]);
    expect(await roundStopped(job)).toBe("blocked");
    expect(getTask(task)!.status).toBe("blocked");
    expect(getTask(task)!.progress).toBe("停下来了没交付，看终端");
  });

  it("friday_done 之后紧跟的 Stop 不催", async () => {
    const { job } = await fridayRun();
    clearAwaiting(job);
    expect(await roundStopped(job)).toBe("none");
    expect(typed()).toEqual([]);
  });

  it("你自己在终端里打字的那一轮不催", async () => {
    const { job } = await fridayRun();
    markAwaiting(job);
    userPrompted(job, "这里为什么用 number？");
    expect(await roundStopped(job)).toBe("none");
  });

  it("Friday 敲的长提示词被 hook 截到 4000 字，仍认得出", async () => {
    const { job } = await fridayRun();
    const long = "改".repeat(6000);
    recordTerminalInput(job, long);
    markAwaiting(job);
    userPrompted(job, long.slice(0, 4000));
    expect(getJob(job)!.awaitingDelivery).toBe(true);
  });

  it("用户自己驾驶的会话从不催", async () => {
    const { job } = await fridayRun({}, "interactive");
    markAwaiting(job);
    expect(await roundStopped(job)).toBe("none");
  });

  it("开工就欠一次交付", async () => {
    const { job } = await fridayRun();
    expect(getJob(job)!.awaitingDelivery).toBe(true);
  });
});

describe("终审修正", () => {
  it("待验收的卡上插一句话：不催、不标卡住，只清掉欠交付", async () => {
    const { task, job } = await fridayRun();
    updateTask(task, { status: "review" });
    markAwaiting(job);
    expect(await roundStopped(job)).toBe("none");
    expect(await roundStopped(job)).toBe("none");
    expect(typed()).toEqual([]);
    expect(getTask(task)!.status).toBe("review");
    expect(getJob(job)!.awaitingDelivery).toBeUndefined();
  });

  it("会话是升级前开的交互式、眼下在跑的是 Friday 驾驶的 job：Friday 敲的话照样标欠交付", async () => {
    const { task } = await fridayRun({}, "interactive");
    const owner = createTask({ title: "Friday 接手", kind: "verbal", source: { autonomous: true }, status: "processing", project: "app" });
    createJob({ id: `fd-${owner.id}`, project: "app", dir: "/tmp", logPath: "/tmp/x.log", taskId: owner.id, sessionId: task });
    expect(await sayToSession(task, "接着改")).toBe("sent");
    expect(getJob(`fd-${owner.id}`)!.awaitingDelivery).toBe(true);
  });
});

describe("等不到 Stop 的那几种", () => {
  const hook = (job: string, body: Record<string, unknown>) =>
    app.request(`/jobs/${job}/message`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("经接口：Stop 催一次", async () => {
    const { job } = await fridayRun();
    await hook(job, { event: "Stop", text: "看完了" });
    await vi.waitFor(() => expect(typed()).toEqual([NUDGE_TEXT]));
  });

  it("Esc 中断、API 出错回到输入框没有 Stop，只有 idle_prompt 通知：同样催", async () => {
    const { job } = await fridayRun();
    await hook(job, { event: "Notification", notificationType: "idle_prompt", message: "Claude is waiting for your input" });
    await vi.waitFor(() => expect(typed()).toEqual([NUDGE_TEXT]));
  });

  it("开工 20 分钟还没回报会话 id（卡在信任目录 / 登录弹框上）：标卡住，释放名额", async () => {
    const { task, job } = await fridayRun();
    db().prepare("UPDATE jobs SET started_at = ? WHERE id = ?").run(new Date(Date.now() - 21 * 60_000).toISOString(), job);
    expect(stalledStarts()).toEqual([job]);
    expect(getTask(task)!.status).toBe("blocked");
    expect(getTask(task)!.progress).toContain("Claude 没起来");
    expect(getJob(job)!.awaitingDelivery).toBeUndefined();
  });

  it("回报过会话 id 的、还在准备段的：不动", async () => {
    const a = await fridayRun();
    setJobSession(a.job, "sess-a");
    const b = await fridayRun();
    updateTermSession(b.task, { status: "preparing" });
    for (const j of [a.job, b.job]) db().prepare("UPDATE jobs SET started_at = ? WHERE id = ?").run(new Date(Date.now() - 60 * 60_000).toISOString(), j);
    expect(stalledStarts()).toEqual([]);
    expect(getTask(a.task)!.status).toBe("processing");
  });
});
