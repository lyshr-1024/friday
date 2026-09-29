import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { rmSync as rmFile, writeFileSync as writeFile } from "node:fs";
import { app } from "../api/index.js";
import { createJob, getJob } from "../memory/jobs.js";
import { createTask, getTask } from "../memory/tasks.js";
import { subscribe } from "../bus.js";
import { contextFor, describeQuestion, setVerified, turnFinished } from "./bridge.js";

// JSON-RPC 的通知没有 id 字段；这里用 null 表示"不带 id"（显式传 undefined 会落到默认参数）
const rpc = (jobId: string, method: string, params?: unknown, id: number | null = 1) =>
  app.request(`/mcp/${jobId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params }) });

describe("终端 → Friday 的 MCP 桥", () => {
  it("initialize / tools/list 走 JSON-RPC，通知（无 id）回 202", async () => {
    createJob({ id: "job-mcp-1", project: "demo", dir: "/tmp", task: "加个按钮", logPath: "/tmp/x.log" });
    const init = (await (await rpc("job-mcp-1", "initialize", { protocolVersion: "2025-06-18" })).json()) as { result: { serverInfo: { name: string } } };
    expect(init.result.serverInfo.name).toBe("friday");
    const list = (await (await rpc("job-mcp-1", "tools/list")).json()) as { result: { tools: Array<{ name: string }> } };
    expect(list.result.tools.map((t) => t.name)).toEqual(["friday_context", "friday_progress", "friday_done", "friday_finish", "friday_blocked"]);
    expect((await rpc("job-mcp-1", "notifications/initialized", undefined, null)).status).toBe(202);
    expect((await rpc("nope", "ping")).status).toBe(404);
  });

  it("friday_progress 写进任务卡，friday_done 只标「这轮做完了」、通知、往会话追加消息；任务仍在 processing", async () => {
    const conv = (await (await app.request("/conversation/new", { method: "POST" })).json()) as { id: string };
    createJob({ id: "job-mcp-2", project: "demo", dir: "/tmp", task: "修登录", conversationId: conv.id, logPath: "/tmp/x.log" });
    const task = createTask({ title: "demo：修登录", kind: "code", source: { jobId: "job-mcp-2", conversationId: conv.id }, project: "demo", status: "processing" });

    await rpc("job-mcp-2", "tools/call", { name: "friday_progress", arguments: { text: "定位到是 token 过期没刷新" } });
    expect(getTask(task.id)!.progress).toBe("定位到是 token 过期没刷新");

    const done = (await (await rpc("job-mcp-2", "tools/call", { name: "friday_done", arguments: { summary: "补了 token 刷新", changes: ["auth.ts — 加 refresh"], testSteps: ["pnpm test → 通过"], testResult: "全部通过", verify: ["登录后放 1 小时再操作"] } })).json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(done.result.isError).toBeUndefined();
    const after = getTask(task.id)!;
    expect(after.status).toBe("processing");
    expect(after.attention).toBeUndefined();
    expect(after.progress).toBe("这轮做完了：补了 token 刷新");
    expect(after.report).toMatchObject({ summary: "补了 token 刷新", testResult: "全部通过", verify: ["登录后放 1 小时再操作"] });
    // 交互式终端交付一轮不关窗口，用户多半就在那儿接着追问
    expect(getJob("job-mcp-2")!.status).toBe("running");
    await rpc("job-mcp-2", "tools/call", { name: "friday_progress", arguments: { text: "按反馈继续改" } });
    expect(getTask(task.id)!.attention).toBeUndefined();

    const notices = (await (await app.request("/notifications")).json()) as Array<{ title: string; body: string; taskId?: string }>;
    // 点开通知要能定位回这条任务
    expect(notices.some((n) => n.title.includes("这轮做完了") && n.title.includes("demo") && n.taskId === task.id)).toBe(true);
    const c = (await (await app.request(`/conversation/${conv.id}`)).json()) as { messages: Array<{ kind: string; content: string }> };
    expect(c.messages.at(-1)).toMatchObject({ kind: "run" });
    expect(c.messages.at(-1)!.content).toContain("补了 token 刷新");
  });

  it("friday_finish：MR 合并、本地清理完才调，任务标完成、终端收尾", async () => {
    createJob({ id: "job-mcp-fin", project: "demo", dir: "/tmp", logPath: "/tmp/x.log" });
    const task = createTask({ title: "demo：收工", kind: "code", source: { jobId: "job-mcp-fin" }, project: "demo", status: "processing" });
    const r = (await (await rpc("job-mcp-fin", "tools/call", { name: "friday_finish", arguments: { summary: "!884 已合并，worktree 已删" } })).json()) as { result: { isError?: boolean } };
    expect(r.result.isError).toBeUndefined();
    await vi.waitFor(() => expect(getJob("job-mcp-fin")!.status).not.toBe("running"));
    expect(getTask(task.id)!.status).toBe("done");
  });

  it("friday_blocked 交互式只标 attention；没有任务的 job 会补建一条", async () => {
    createJob({ id: "job-mcp-3", project: "demo", dir: "/tmp", logPath: "/tmp/x.log" });
    await rpc("job-mcp-3", "tools/call", { name: "friday_blocked", arguments: { reason: "需要生产库只读权限" } });
    const board = (await (await app.request("/tasks")).json()) as { tasks: Array<{ status: string; attention?: string; progress?: string; source: { jobId?: string } }> };
    const t = board.tasks.find((x) => x.source.jobId === "job-mcp-3")!;
    expect(t.status).toBe("processing");
    expect(t.attention).toBe("blocked");
    expect(t.progress).toContain("生产库只读权限");
  });

  it("Friday 自主派出的任务（source.autonomous）friday_done 直接进 review，并挂上合并待审——分支在 worktree 里、合并在主仓做", async () => {
    // 真开一个仓库：分支名是从 worktree 里读出来的，不是 Friday 拼的
    const repo = mkdtempSync(join(tmpdir(), "friday-repo-"));
    const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" } });
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "init");
    git("switch", "-q", "-c", "fix/login-token");
    createJob({ id: "job-mcp-4", project: "demo", dir: repo, task: "自主改", logPath: "/tmp/x.log" });
    const task = createTask({ title: "demo：自主改", kind: "code", source: { jobId: "job-mcp-4", autonomous: true, repoDir: "/main/repo", worktree: repo }, project: "demo", status: "processing", plan: "改" });
    await rpc("job-mcp-4", "tools/call", { name: "friday_done", arguments: { summary: "改完了", testResult: "通过" } });
    const t = getTask(task.id)!;
    expect(t.status).toBe("review");
    expect(t.pending?.map((p) => p.type)).toEqual(["git_merge"]);
    expect(t.pending![0]!.payload).toMatchObject({ dir: "/main/repo", branch: "fix/login-token", worktree: repo });
  });

  it("自主任务停在主干上（没建分支）就不挂合并动作，免得挂个假的", async () => {
    const repo = mkdtempSync(join(tmpdir(), "friday-repo-"));
    execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
    createJob({ id: "job-mcp-4b", project: "demo", dir: repo, task: "自主改", logPath: "/tmp/x.log" });
    const task = createTask({ title: "demo：自主改 b", kind: "code", source: { jobId: "job-mcp-4b", autonomous: true }, project: "demo", status: "processing", plan: "改" });
    await rpc("job-mcp-4b", "tools/call", { name: "friday_done", arguments: { summary: "改完了", testResult: "通过" } });
    expect(getTask(task.id)!.pending ?? []).toEqual([]);
  });

  it("终端一轮说完（Stop）：只把进展换成它说的话，不打标记、不往会话追加消息，并推 tasks 事件", async () => {
    const conv = (await (await app.request("/conversation/new", { method: "POST" })).json()) as { id: string };
    createJob({ id: "job-turn", project: "demo", dir: "/tmp", task: "修登录", conversationId: conv.id, logPath: "/tmp/x.log" });
    const task = createTask({ title: "demo：修登录", kind: "code", source: { jobId: "job-turn", conversationId: conv.id }, project: "demo", status: "processing" });
    const seen: string[] = [];
    const off = subscribe((ev) => seen.push(ev.type));
    turnFinished("job-turn", "改好了 token 刷新，跑了测试都过，要我提交吗？");
    off();
    const after = getTask(task.id)!;
    expect(after.attention).toBeUndefined();
    expect(after.progress).toBe("这轮说完了：改好了 token 刷新，跑了测试都过，要我提交吗？");
    expect(seen).toContain("tasks");
    const c = (await (await app.request(`/conversation/${conv.id}`)).json()) as { messages: Array<{ kind: string; content: string }> };
    expect(c.messages.some((m) => m.content.includes("这轮说完了"))).toBe(false);
  });

  it("勾选验证点落在任务上；全部勾完记账并在会话里说下一步", async () => {
    const conv = (await (await app.request("/conversation/new", { method: "POST" })).json()) as { id: string };
    createJob({ id: "job-v", project: "demo", dir: "/tmp", task: "x", conversationId: conv.id, logPath: "/tmp/x.log" });
    // 会话只记在 job 上（/run 建的任务就是这样），留痕也要能落到会话里
    const task = createTask({ title: "demo：x", kind: "code", source: { jobId: "job-v" }, project: "demo", status: "processing" });
    await rpc("job-v", "tools/call", { name: "friday_done", arguments: { summary: "改完", testResult: "过", verify: ["看 A", "看 B"] } });
    let t = (await (await app.request(`/tasks/${task.id}/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ index: 0, checked: true }) })).json()) as { report: { checked: boolean[] }; attention?: string };
    expect(t.report.checked).toEqual([true, false]);
    expect(t.attention).toBeUndefined();
    t = (await (await app.request(`/tasks/${task.id}/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ index: 1, checked: true }) })).json()) as typeof t;
    expect(t.report.checked).toEqual([true, true]);
    // 没有活着的 PTY：说清楚终端已断，等你看的标记清掉
    expect(t.attention).toBeUndefined();
    const audit = (await (await app.request(`/audit?taskId=${task.id}`)).json()) as Array<{ action: string }>;
    expect(audit.some((e) => e.action === "verified_all")).toBe(true);
    const c = (await (await app.request(`/conversation/${conv.id}`)).json()) as { messages: Array<{ content: string }> };
    expect(c.messages.at(-1)!.content).toContain("确认全部验证点");
    expect(await setVerified("nope", 0, true)).toBeUndefined();
  });

  it("终端弹选项题（PreToolUse AskUserQuestion）：任务标 question、通知、会话留问题；PostToolUse 解除", async () => {
    const conv = (await (await app.request("/conversation/new", { method: "POST" })).json()) as { id: string };
    createJob({ id: "job-q", project: "demo", dir: "/tmp", task: "x", conversationId: conv.id, logPath: "/tmp/x.log" });
    const task = createTask({ title: "demo：q", kind: "code", source: { jobId: "job-q", conversationId: conv.id }, project: "demo", status: "processing" });
    const input = JSON.stringify({ questions: [{ question: "用哪个方案？", header: "方案", options: [{ label: "A 改前端" }, { label: "B 改后端" }] }] });
    expect(describeQuestion("AskUserQuestion", input)).toBe("用哪个方案？（选项：1. A 改前端 / 2. B 改后端）");
    expect(describeQuestion("ExitPlanMode", JSON.stringify({ plan: "先改 a 再改 b" }))).toContain("要不要按这个计划执行");
    const r = await app.request("/jobs/job-q/message", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: "PreToolUse", toolName: "AskUserQuestion", toolInput: input }) });
    expect(r.status).toBe(200);
    const after = getTask(task.id)!;
    expect(after.attention).toBe("question");
    expect(after.progress).toContain("用哪个方案");
    const notices = (await (await app.request("/notifications")).json()) as Array<{ title: string; taskId?: string }>;
    expect(notices.some((n) => n.title.includes("终端在等你回答") && n.taskId === task.id)).toBe(true);
    const c = (await (await app.request(`/conversation/${conv.id}`)).json()) as { messages: Array<{ content: string }> };
    expect(c.messages.at(-1)!.content).toContain("终端在问你");
    // 紧跟着来的泛化 Notification 不能把具体问题盖掉
    await app.request("/jobs/job-q/message", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: "Notification", notificationType: "permission_prompt", message: "Claude needs your permission" }) });
    expect(getTask(task.id)!.progress).toContain("用哪个方案");
    await app.request("/jobs/job-q/message", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: "PostToolUse", toolName: "AskUserQuestion", toolInput: input }) });
    expect(getTask(task.id)!.attention).toBeUndefined();
  });
});

describe("项目明确之后只做决定和转发", () => {
  it("给终端的背景不带 Friday 的方案，给 Friday 自己的带", () => {
    const task = createTask({
      title: "whale：改导出",
      kind: "code",
      source: { jobId: "job-ctx" },
      project: "whale",
      status: "processing",
      understanding: "拂晓说导出的日期筛选不对",
      plan: "改 ExportPanel.tsx 的 dayjs 时区",
    });
    const toTerminal = contextFor(getTask(task.id)!);
    expect(toTerminal).toContain("拂晓说导出的日期筛选不对");
    expect(toTerminal).not.toContain("ExportPanel.tsx");
    expect(toTerminal).toContain("没读过这个项目的代码");

    // 会话里 Friday 自己要记得你俩聊定的结论，否则下一轮就忘了你已经拍过板
    const toFriday = contextFor(getTask(task.id)!, undefined, "friday");
    expect(toFriday).toContain("ExportPanel.tsx");
    expect(toFriday).not.toContain("没读过这个项目的代码");
  });

});

describe("Friday 工具的返回提醒回复语言", () => {
  it("friday_done / friday_blocked / friday_progress 的返回末尾带一句用中文汇报", async () => {
    writeFile(process.env.FRIDAY_CLAUDE_SETTINGS!, JSON.stringify({ language: "chinese" }));
    try {
      createJob({ id: "job-lang", project: "demo", dir: "/tmp", task: "x", logPath: "/tmp/x.log" });
      createTask({ title: "demo：lang", kind: "code", source: { jobId: "job-lang" }, project: "demo", status: "processing" });
      for (const [name, args] of [["friday_progress", { text: "进展" }], ["friday_done", { summary: "好了", testResult: "过" }], ["friday_blocked", { reason: "卡了" }]] as const) {
        const r = (await (await rpc("job-lang", "tools/call", { name, arguments: args })).json()) as { result: { content: Array<{ text: string }> } };
        expect(r.result.content[0]!.text).toContain("用中文");
      }
    } finally {
      rmFile(process.env.FRIDAY_CLAUDE_SETTINGS!, { force: true });
    }
  });
});
