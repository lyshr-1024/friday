import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { config } from "../config.js";
import { app } from "../api/index.js";
import { createJob } from "../memory/jobs.js";
import { createTask } from "../memory/tasks.js";
import { handToFriday, startTask } from "./taskStart.js";

describe("开工：任务卡菜单、接口和会话里的 task_start 走同一套", () => {
  it("没定项目：两种开工都拒绝，说清要先选项目", async () => {
    const t = createTask({ title: "没项目", kind: "meegle", status: "understood", source: { meegleType: "issue" } });
    expect(await startTask(t)).toEqual({ error: "任务没有关联项目，先选个项目", status: 400 });
    expect(await handToFriday(t)).toEqual({ error: "任务没有关联项目，先选个项目", status: 400 });
  });

  it("已经有终端在跑：不重复开", async () => {
    writeFileSync(join(config.dataDir, "projects.md"), `# 项目\n\n## demo\n- 目录：${mkdtempSync(join(tmpdir(), "friday-ts-"))}\n`);
    createJob({ id: "job-ts-1", project: "demo", dir: "/tmp", task: "x", logPath: "/tmp/x.log" });
    const t = createTask({ title: "在跑", kind: "code", status: "processing", project: "demo", source: { jobId: "job-ts-1" } });
    const r = await handToFriday(t);
    expect("error" in r && r.status).toBe(409);
  });

  it("/tasks/:id/retry 仍是同一套判断", async () => {
    const t = createTask({ title: "没项目 2", kind: "meegle", status: "understood", source: {} });
    const res = await app.request(`/tasks/${t.id}/retry`, { method: "POST" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("任务没有关联项目，先选个项目");
  });
});
