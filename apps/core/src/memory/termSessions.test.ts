import { describe, expect, it } from "vitest";
import { createJob, getJob, setJobDir } from "./jobs.js";
import { createTermSession, getTermSession, markInput, markSeen, markStop, openTermSessions, termSessionByJob, updateTermSession } from "./termSessions.js";

describe("term_sessions", () => {
  it("交互式建出来是 preparing，job 挂上 session_id", () => {
    createJob({ id: "j-ts-1", project: "p", dir: "/r", logPath: "/l", taskId: "root-1", sessionId: "root-1" });
    const s = createTermSession({ id: "root-1", project: "p", repoDir: "/r", tmuxName: "r-root1", kind: "interactive", jobId: "j-ts-1" });
    expect(s).toMatchObject({ status: "preparing", kind: "interactive", tmuxName: "r-root1", jobId: "j-ts-1" });
    expect(s.lastInputAt).toBeTruthy();
    expect(getJob("j-ts-1")?.sessionId).toBe("root-1");
    expect(termSessionByJob("j-ts-1")?.id).toBe("root-1");
  });

  it("后台查询不走准备段，直接 running", () => {
    expect(createTermSession({ id: "q-1", project: "p", repoDir: "/r", tmuxName: "r-q1", kind: "query", jobId: "jq" }).status).toBe("running");
  });

  it("输入 / Stop / 看过 三个时间各记各的", async () => {
    markStop("root-1");
    await new Promise((r) => setTimeout(r, 5));
    markSeen("root-1");
    const s = getTermSession("root-1")!;
    expect(s.lastStopAt).toBeTruthy();
    expect(s.seenAt! > s.lastStopAt!).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    markInput("root-1");
    expect(getTermSession("root-1")!.lastInputAt! > s.seenAt!).toBe(true);
  });

  it("closed 的不在开着的列表里；同一个根再开一次覆盖成新会话", () => {
    updateTermSession("q-1", { status: "closed" });
    expect(openTermSessions().map((s) => s.id)).not.toContain("q-1");
    const again = createTermSession({ id: "q-1", project: "p", repoDir: "/r", tmuxName: "r-q1b", kind: "query", jobId: "jq2" });
    expect(again).toMatchObject({ status: "running", tmuxName: "r-q1b", jobId: "jq2" });
    expect(again.lastStopAt).toBeUndefined();
  });

  it("worktree 建好后 job 的目录跟着换，transcript 路径才找得到", () => {
    setJobDir("j-ts-1", "/r-feat-x");
    expect(getJob("j-ts-1")?.dir).toBe("/r-feat-x");
  });
});
