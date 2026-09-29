import { beforeEach, describe, expect, it } from "vitest";
import { app } from "./index.js";
import { setTmuxRunner } from "../agent/tmux.js";
import { setLauncher } from "../agent/sessions.js";
import { writeMemoryFile } from "../memory/files.js";
import { createTask, getTask, listTasks } from "../memory/tasks.js";
import { createConversation, listMessages } from "../memory/conversations.js";
import { createJob, getJob } from "../memory/jobs.js";
import { createTermSession, updateTermSession } from "../memory/termSessions.js";

let tmuxInstalled = true;
beforeEach(() => {
  tmuxInstalled = true;
  setTmuxRunner(async (args) => {
    if (args[0] === "-V") {
      if (!tmuxInstalled) throw Object.assign(new Error("spawn tmux ENOENT"), { code: "ENOENT" });
      return "tmux 3.5a";
    }
    return "";
  });
  setLauncher(async () => {});
  writeMemoryFile("projects", "## runproj\n- 目录：/tmp\n");
});

const post = (path: string, body?: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

describe("POST /run", () => {
  it("没装 tmux：返回 tmux 的错误，建出来的任务不是 processing", async () => {
    tmuxInstalled = false;
    const res = await post("/run", { project: "runproj", task: "查一下导出" });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain("brew install tmux");
    const t = listTasks().find((x) => x.title.includes("查一下导出"));
    expect(t).toBeTruthy();
    expect(t!.status).not.toBe("processing");
  });

  it("带 conversationId：job 记着它，退出时往那段会话追加 run 消息", async () => {
    const conv = createConversation();
    const res = await post("/run", { project: "runproj", task: "跑个测试", conversationId: conv.id });
    expect(res.status).toBe(200);
    const { jobId } = (await res.json()) as { jobId: string };
    expect(getJob(jobId)?.conversationId).toBe(conv.id);
    expect(getTask(getJob(jobId)!.taskId!)?.source.conversationId).toBe(conv.id);
    await post(`/jobs/${jobId}/exit`, { code: 0 });
    expect(listMessages(conv.id).some((m) => m.kind === "run" && m.content.includes("已结束"))).toBe(true);
  });
});

describe("POST /jobs/:id/reopen", () => {
  it("会话还在跑：409，不往运行中的 Claude 里敲命令", async () => {
    const t = createTask({ title: "reopen", kind: "code", source: {}, status: "processing" });
    const jobId = `job-${t.id}`;
    createJob({ id: jobId, project: "runproj", dir: "/tmp", logPath: "/tmp/x.log", taskId: t.id, sessionId: t.id });
    createTermSession({ id: t.id, project: "runproj", repoDir: "/tmp", tmuxName: `s-${t.id.slice(0, 6)}`, kind: "interactive", jobId });
    updateTermSession(t.id, { status: "running" });
    const res = await post(`/jobs/${jobId}/reopen`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("会话还在跑，不用接回");
  });
});
