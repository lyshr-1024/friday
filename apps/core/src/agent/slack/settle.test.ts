import { describe, expect, it } from "vitest";
import { initMemory } from "../../memory/db.js";
import { addInboxItems, markInboxDone } from "../../memory/inbox.js";
import { addPending, createTask, getTask } from "../../memory/tasks.js";
import { settleQueryTasks } from "./settle.js";
import { setTmuxRunner } from "../tmux.js";
import { openSession, setLauncher } from "../sessions.js";
import { getTermSession } from "../../memory/termSessions.js";

describe("你自己在 Slack 回了", () => {
  it("挂着的查询任务收掉、草稿撤下", async () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    addInboxItems([
      { id: "S1:1", kind: "dm", channelId: "S1", channelName: "私聊", userId: "U1", userName: "拂晓", text: "在哪配", permalink: "p", ts: "1" },
    ]);
    markInboxDone("S1:1");
    let t = createTask({ title: "回答拂晓", kind: "slack", source: { conversation: "S1:1", channelId: "S1", headless: true }, status: "review" });
    t = addPending(t.id, { type: "slack_reply", label: "回复拂晓", detail: "草稿", payload: { channel: "S1", text: "草稿" } })!;

    expect(await settleQueryTasks()).toBe(1);
    const after = getTask(t.id)!;
    expect(after.status).toBe("done");
    expect(after.pending ?? []).toHaveLength(0);
  });

  it("没被读过的不动", async () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    addInboxItems([
      { id: "S2:1", kind: "dm", channelId: "S2", channelName: "私聊", userId: "U2", userName: "夕瑶", text: "在哪配", permalink: "p", ts: "1" },
    ]);
    const t = createTask({ title: "回答夕瑶", kind: "slack", source: { conversation: "S2:1", channelId: "S2", headless: true }, status: "review" });
    await settleQueryTasks();
    expect(getTask(t.id)!.status).toBe("review");
  });

  it("HUD 手动建成的任务不是 headless 查询，不被自动收掉", async () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    addInboxItems([
      { id: "S3:1", kind: "dm", channelId: "S3", channelName: "私聊", userId: "U3", userName: "千一", text: "在哪配", permalink: "p", ts: "1" },
    ]);
    markInboxDone("S3:1");
    const t = createTask({ title: "回答千一", kind: "verbal", source: { conversation: "S3:1", channelId: "S3" }, status: "review" });
    expect(await settleQueryTasks()).toBe(0);
    expect(getTask(t.id)!.status).toBe("review");
  });

  it("收工时连它的查询会话一起 kill", async () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const calls: string[][] = [];
    const alive = new Set<string>();
    setTmuxRunner(async (args) => {
      calls.push(args);
      if (args[0] === "-V") return "tmux 3.5a";
      const target = (args[args.indexOf("-t") + 1] ?? "").replace(/^=/, "").replace(/:.*$/, "");
      if (args[4] === "has-session" && !alive.has(target)) throw new Error("can't find session");
      if (args[4] === "kill-session") alive.delete(target);
      return "";
    });
    setLauncher(async (_req, name) => { alive.add(name); });
    addInboxItems([
      { id: "S4:1", kind: "dm", channelId: "S4", channelName: "私聊", userId: "U4", userName: "佳成", text: "在哪配", permalink: "p", ts: "1" },
    ]);
    markInboxDone("S4:1");
    const t = createTask({ title: "回答佳成", kind: "slack", source: { conversation: "S4:1", channelId: "S4", headless: true }, status: "processing" });
    const jobId = await openSession(t, t, { kind: "query", project: "app", repoDir: "/r/app", task: "查" });
    const name = getTermSession(t.id)!.tmuxName;
    await settleQueryTasks();
    expect(getTask(t.id)!.status).toBe("done");
    expect(calls.some((c) => c[4] === "kill-session" && c.includes(`=${name}`))).toBe(true);
    expect(getTermSession(t.id)!.status).toBe("closed");
    expect(jobId).toBeTruthy();
  });
});
