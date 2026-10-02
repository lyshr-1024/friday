import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ProjectTerminal } from "@friday/shared";
import { app } from "../api/index.js";
import { config } from "../config.js";
import { getTask, taskBoard } from "../memory/tasks.js";
import { getTermSession, updateTermSession } from "../memory/termSessions.js";
import { runsDir, setClaudeFinder } from "./runner.js";
import { setLauncher } from "./sessions.js";
import { setTmuxRunner } from "./tmux.js";

let calls: string[][] = [];
let alive = new Set<string>();
let launched: Array<{ inRepo?: boolean; repoDir: string; task?: string }> = [];
const dir = mkdtempSync(join(tmpdir(), "friday-pt-"));
beforeEach(() => {
  calls = [];
  alive = new Set();
  launched = [];
  writeFileSync(join(config.dataDir, "projects.md"), `# 项目\n\n## pt-demo\n- 目录：${dir}\n`);
  setClaudeFinder(async () => "/bin/claude");
  setTmuxRunner(async (args) => {
    calls.push(args);
    if (args[0] === "-V") return "tmux 3.5a";
    const sub = args[4];
    const target = (args[args.indexOf("-t") + 1] ?? "").replace(/^=/, "").replace(/:.*$/, "");
    if (sub === "has-session" && !alive.has(target)) throw new Error("can't find session");
    if (sub === "new-session") alive.add(args[args.indexOf("-s") + 1]!);
    if (sub === "list-windows") return "0|claude|1\n";
    return "";
  });
  setLauncher(async (req, name) => { launched.push(req); alive.add(name); });
});

const open = async () => (await (await app.request("/projects/pt-demo/terminal", { method: "POST" })).json()) as Required<ProjectTerminal>;

describe("项目终端", () => {
  it("在主仓里直接开，不跑准备段；锚点不进任务列表；再点一次不重开", async () => {
    const r = await open();
    expect(r).toMatchObject({ name: "pt-demo", dir, status: "running", state: "idle" });
    expect(launched).toHaveLength(1);
    expect(launched[0]).toMatchObject({ inRepo: true, repoDir: dir, task: "" });
    expect(getTask(r.taskId)!.kind).toBe("project");
    expect(taskBoard().tasks.some((t) => t.id === r.taskId)).toBe(false);

    await open();
    expect(launched).toHaveLength(1);
    const list = (await (await app.request("/projects/terminals")).json()) as ProjectTerminal[];
    expect(list.find((p) => p.name === "pt-demo")).toMatchObject({ taskId: r.taskId, status: "running" });
  });

  it("会话被关了：在主仓里重建，--resume 接回", async () => {
    const r = await open();
    const s = getTermSession(r.taskId)!;
    alive.delete(s.tmuxName);
    updateTermSession(r.taskId, { status: "closed" });
    calls = [];
    launched = [];
    const again = await open();
    expect(again.status).toBe("running");
    expect(launched).toHaveLength(0);
    const ns = calls.find((a) => a[4] === "new-session")!;
    expect(ns[ns.indexOf("-c") + 1]).toBe(dir);
    expect(readFileSync(join(runsDir(), `${r.jobId}.resume.sh`), "utf8")).toContain(`cd '${dir}'`);
  });

  it("注册表里没有的项目报 404", async () => {
    expect((await app.request("/projects/nope/terminal", { method: "POST" })).status).toBe(404);
  });
});
