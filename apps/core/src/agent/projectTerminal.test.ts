import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ProjectOverview, ProjectTerminal } from "@friday/shared";
import { app } from "../api/index.js";
import { config } from "../config.js";
import { createTask, getTask, taskBoard } from "../memory/tasks.js";
import { getJob } from "../memory/jobs.js";
import { getTermSession, updateTermSession } from "../memory/termSessions.js";
import { setClaudeFinder } from "./runner.js";
import { setLauncher } from "./sessions.js";
import { setTmuxRunner } from "./tmux.js";

let calls: string[][] = [];
let alive = new Set<string>();
let launched: Array<{ inRepo?: boolean; shell?: boolean; repoDir: string; task?: string }> = [];
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

const post = async (path: string, body?: unknown) => (await (await app.request(path, { method: "POST", ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) })).json()) as Required<ProjectTerminal>;
const open = (fresh?: boolean) => post("/projects/pt-demo/terminal", fresh ? { fresh } : undefined);

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

  it("会话被关了：全新开一段，不接回旧对话", async () => {
    const r = await open();
    const s = getTermSession(r.taskId)!;
    alive.delete(s.tmuxName);
    updateTermSession(r.taskId, { status: "closed" });
    launched = [];
    const again = await open();
    expect(again.status).toBe("running");
    expect(launched).toHaveLength(1);
    expect(again.jobId).not.toBe(r.jobId);
  });

  it("新开一段：关掉正在跑的那段，旧 job 收尾，再全新起一个", async () => {
    const r = await open();
    launched = [];
    const again = await open(true);
    expect(launched).toHaveLength(1);
    expect(again.jobId).not.toBe(r.jobId);
    expect(getJob(r.jobId)!.status).not.toBe("running");
    expect(calls.some((a) => a[4] === "kill-session")).toBe(true);
  });

  it("普通 shell 是另一个会话，不起 Claude，能关", async () => {
    const c = await open();
    const r = await post("/projects/pt-demo/shell");
    expect(launched.at(-1)).toMatchObject({ shell: true, repoDir: dir });
    expect(r.shell.taskId).not.toBe(c.taskId);
    expect(r.shell.status).toBe("running");
    expect(r.status).toBe("running");
    const closed = (await (await app.request("/projects/pt-demo/shell", { method: "DELETE" })).json()) as ProjectTerminal;
    expect(closed.shell?.status).toBeUndefined();
    expect(closed.status).toBe("running");
    const noClaude = (await (await app.request("/projects/pt-demo/terminal", { method: "DELETE" })).json()) as ProjectTerminal;
    expect(noClaude.status).toBeUndefined();
    expect(getJob(c.jobId)!.status).not.toBe("running");
  });

  it("概览：注册表简介 + 这个项目没收工的任务，锚点不算", async () => {
    writeFileSync(join(config.dataDir, "projects.md"), `# 项目\n\n## pt-demo\n- 目录：${dir}\n- 说明：演示项目\n- 环境：测试 demo.test/x/\n`);
    await open();
    const t = createTask({ title: "改个表单", kind: "verbal", project: "pt-demo", source: {}, status: "understood" });
    createTask({ title: "别的项目的", kind: "verbal", project: "other", source: {}, status: "understood" });
    const o = (await (await app.request("/projects/pt-demo/overview")).json()) as ProjectOverview;
    expect(o.note).toBe("演示项目");
    expect(o.envs).toEqual([{ name: "测试", url: "demo.test/x" }]);
    expect(o.open.map((x) => x.id)).toEqual([t.id]);
    expect((await app.request("/projects/nope/overview")).status).toBe(404);
  });

  it("注册表里没有的项目报 404", async () => {
    expect((await app.request("/projects/nope/terminal", { method: "POST" })).status).toBe(404);
  });
});
