import { beforeEach, describe, expect, it } from "vitest";
import { createTask, getTask } from "../memory/tasks.js";
import { clearAwaiting, getJob, markAwaiting, recordTerminalInput } from "../memory/jobs.js";
import { updateTermSession } from "../memory/termSessions.js";
import { setTmuxRunner } from "./tmux.js";
import { setClaudeFinder } from "./runner.js";
import { openSession, setLauncher } from "./sessions.js";
import { NUDGE_TEXT, roundStopped, userPrompted } from "./rounds.js";
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
