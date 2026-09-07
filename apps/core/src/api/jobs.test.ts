import { describe, expect, it } from "vitest";
import { app } from "./index.js";
import { createJob } from "../memory/jobs.js";

describe("终端任务", () => {
  it("hook 回报最后一轮，退出回报改状态并进通知队列", async () => {
    const conv = (await (await app.request("/conversation/new", { method: "POST" })).json()) as { id: string };
    createJob({ id: "job-t", project: "demo", dir: "/tmp", task: "修 bug", conversationId: conv.id, logPath: "/tmp/nope.log" });
    const msg = await app.request("/jobs/job-t/message", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "改好了，跑了测试都过" }) });
    expect(msg.status).toBe(200);
    const exit = await app.request("/jobs/job-t/exit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: 0 }) });
    const job = (await exit.json()) as { status: string; exitCode: number; lastMessage: string };
    expect(job).toMatchObject({ status: "done", exitCode: 0, lastMessage: "改好了，跑了测试都过" });
    const c = (await (await app.request(`/conversation/${conv.id}`)).json()) as { messages: Array<{ kind: string; content: string }> };
    expect(c.messages.at(-1)).toMatchObject({ kind: "run" });
    expect(c.messages.at(-1)!.content).toContain("退出码 0");
    const notices = (await (await app.request("/notifications")).json()) as Array<{ title: string }>;
    expect(notices.some((n) => n.title.includes("demo"))).toBe(true);
    expect((await app.request("/jobs/job-t/log")).status).toBe(200);
  });
});
