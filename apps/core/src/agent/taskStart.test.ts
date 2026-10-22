import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { config } from "../config.js";
import { app } from "../api/index.js";
import { createJob } from "../memory/jobs.js";
import { createTask } from "../memory/tasks.js";
import { startTask } from "./taskStart.js";
import { getTermSession } from "../memory/termSessions.js";
import { getTask } from "../memory/tasks.js";
import { setTmuxRunner } from "./tmux.js";
import { setClaudeFinder } from "./runner.js";
import { setLauncher } from "./sessions.js";
import { mainRepo } from "./testRepos.js";

beforeEach(() => {
  setClaudeFinder(async () => "/bin/claude");
  setTmuxRunner(async (args) => (args[0] === "-V" ? "tmux 3.5a" : args[4] === "has-session" ? Promise.reject(new Error("no")) : ""));
  setLauncher(async () => {});
});

describe("开工：任务卡菜单、接口和会话里的 task_start 走同一套", () => {
  it("没定项目：拒绝，说清要先选项目", async () => {
    const t = createTask({ title: "没项目", kind: "meegle", status: "understood", source: { meegleType: "issue" } });
    expect(await startTask(t)).toEqual({ error: "任务没有关联项目，先选个项目", status: 400 });
  });

  it("开工一律是 Friday 驾驶：会话 kind autonomous，任务 source.autonomous", async () => {
    writeFileSync(join(config.dataDir, "projects.md"), `# 项目\n\n## tsfd\n- 目录：${mainRepo("tsfd")}\n`);
    const t = createTask({ title: "自己开工", kind: "verbal", status: "understood", project: "tsfd", source: {} });
    const r = await startTask(t);
    expect("task" in r).toBe(true);
    expect(getTermSession(t.id)!.kind).toBe("autonomous");
    expect(getTask(t.id)!.source.autonomous).toBe(true);
  });

  it("已经有终端在跑：不重复开", async () => {
    writeFileSync(join(config.dataDir, "projects.md"), `# 项目\n\n## demo\n- 目录：${mkdtempSync(join(tmpdir(), "friday-ts-"))}\n`);
    createJob({ id: "job-ts-1", project: "demo", dir: "/tmp", task: "x", logPath: "/tmp/x.log" });
    const t = createTask({ title: "在跑", kind: "code", status: "processing", project: "demo", source: { jobId: "job-ts-1" } });
    const r = await startTask(t);
    expect("error" in r && r.status).toBe(409);
  });

  it("「交给 Friday 改」的 /retry 已经并进 /start", async () => {
    const t = createTask({ title: "没项目 2", kind: "meegle", status: "understood", source: {} });
    expect((await app.request(`/tasks/${t.id}/retry`, { method: "POST" })).status).toBe(404);
    const res = await app.request(`/tasks/${t.id}/start`, { method: "POST" });
    expect(res.status).toBe(400);
  });
});
