import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config.js";
import { app } from "../api/index.js";
import { createJob } from "../memory/jobs.js";
import { createTask, updateTask } from "../memory/tasks.js";
import { startTask } from "./taskStart.js";
import { startAutonomousJob } from "./pipeline.js";
import { briefBasis } from "./brief.js";
import type { Brief } from "@friday/shared";
import { getTermSession } from "../memory/termSessions.js";
import { getTask } from "../memory/tasks.js";
import { setTmuxRunner } from "./tmux.js";
import { setClaudeFinder } from "./runner.js";
import { setLauncher } from "./sessions.js";
import { mainRepo } from "./testRepos.js";

vi.mock("./pipeline.js", async (orig) => {
  const m = await orig<typeof import("./pipeline.js")>();
  return { ...m, startAutonomousJob: vi.fn(m.startAutonomousJob) };
});

const card = (over: Partial<Brief> = {}): Brief => ({
  todo: "给导出加 CSV 列", deps: [], acceptance: { source: "own", cases: ["导出含新列"] }, release: "走 canary", plan: "改 export.ts", size: "small", sizeWhy: "一个文件",
  review: "approved", basis: "x", at: "2026-10-22T00:00:00.000Z", features: [], ...over,
});

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

  it("理解卡审过：开工的交代内容是理解卡正文；过期、项目不一致、待审的不用", async () => {
    writeFileSync(join(config.dataDir, "projects.md"), `# 项目\n\n## tsb\n- 目录：${mainRepo("tsb")}\n`);
    const mk = (b: Brief, title: string) => {
      const t = createTask({ title, kind: "verbal", status: "understood", project: "tsb", source: { description: "d" } });
      return updateTask(t.id, { source: { brief: { ...b, basis: b.basis === "x" ? briefBasis(t) : b.basis } } })!;
    };
    const detailOf = () => String(vi.mocked(startAutonomousJob).mock.lastCall![3]);
    await startTask(mk(card(), "用审过的卡"));
    expect(detailOf()).toContain("给导出加 CSV 列");
    expect(detailOf()).not.toContain("## 要做什么\n\n");
    await startTask(mk(card({ review: "none", project: "tsb" }), "不用审的卡"));
    expect(detailOf()).toContain("给导出加 CSV 列");
    await startTask(mk(card({ stale: true }), "过期的卡"));
    expect(detailOf()).not.toContain("给导出加 CSV 列");
    await startTask(mk(card({ project: "别的" }), "项目不一致的卡"));
    expect(detailOf()).not.toContain("给导出加 CSV 列");
    await startTask(mk(card({ review: "pending" }), "待审的卡"));
    expect(detailOf()).not.toContain("给导出加 CSV 列");
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
