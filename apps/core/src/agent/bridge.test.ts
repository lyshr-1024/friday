import { describe, expect, it } from "vitest";
import { app } from "../api/index.js";
import { createJob } from "../memory/jobs.js";
import { createTask, getTask } from "../memory/tasks.js";
import { subscribe } from "../bus.js";
import { describeQuestion, setVerified, turnFinished } from "./bridge.js";

// JSON-RPC 的通知没有 id 字段；这里用 null 表示"不带 id"（显式传 undefined 会落到默认参数）
const rpc = (jobId: string, method: string, params?: unknown, id: number | null = 1) =>
  app.request(`/mcp/${jobId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params }) });

describe("终端 → Friday 的 MCP 桥", () => {
  it("initialize / tools/list 走 JSON-RPC，通知（无 id）回 202", async () => {
    createJob({ id: "job-mcp-1", project: "demo", dir: "/tmp", task: "加个按钮", logPath: "/tmp/x.log" });
    const init = (await (await rpc("job-mcp-1", "initialize", { protocolVersion: "2025-06-18" })).json()) as { result: { serverInfo: { name: string } } };
    expect(init.result.serverInfo.name).toBe("friday");
    const list = (await (await rpc("job-mcp-1", "tools/list")).json()) as { result: { tools: Array<{ name: string }> } };
    expect(list.result.tools.map((t) => t.name)).toEqual(["friday_context", "friday_progress", "friday_done", "friday_blocked"]);
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
    expect(after.attention).toBe("review");
    expect(after.report).toMatchObject({ summary: "补了 token 刷新", testResult: "全部通过", verify: ["登录后放 1 小时再操作"] });
    // 再报进展 = 新一轮开始，标记清掉
    await rpc("job-mcp-2", "tools/call", { name: "friday_progress", arguments: { text: "按反馈继续改" } });
    expect(getTask(task.id)!.attention).toBeUndefined();

    const notices = (await (await app.request("/notifications")).json()) as Array<{ title: string; body: string }>;
    expect(notices.some((n) => n.title.includes("这轮做完了") && n.title.includes("demo"))).toBe(true);
    const c = (await (await app.request(`/conversation/${conv.id}`)).json()) as { messages: Array<{ kind: string; content: string }> };
    expect(c.messages.at(-1)).toMatchObject({ kind: "run" });
    expect(c.messages.at(-1)!.content).toContain("补了 token 刷新");
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

  it("Friday 自主派出的任务（source.autonomous）friday_done 仍直接进 review", async () => {
    createJob({ id: "job-mcp-4", project: "demo", dir: "/tmp", task: "自主改", logPath: "/tmp/x.log" });
    const task = createTask({ title: "demo：自主改", kind: "code", source: { jobId: "job-mcp-4", autonomous: true }, project: "demo", status: "processing", plan: "改" });
    await rpc("job-mcp-4", "tools/call", { name: "friday_done", arguments: { summary: "改完了", testResult: "通过" } });
    expect(getTask(task.id)!.status).toBe("review");
  });

  it("终端一轮说完（Stop）：任务标黄、进展换成它说的话、回流到任务会话，并推 tasks 事件", async () => {
    const conv = (await (await app.request("/conversation/new", { method: "POST" })).json()) as { id: string };
    createJob({ id: "job-turn", project: "demo", dir: "/tmp", task: "修登录", conversationId: conv.id, logPath: "/tmp/x.log" });
    const task = createTask({ title: "demo：修登录", kind: "code", source: { jobId: "job-turn", conversationId: conv.id }, project: "demo", status: "processing" });
    const seen: string[] = [];
    const off = subscribe((ev) => seen.push(ev.type));
    turnFinished("job-turn", "改好了 token 刷新，跑了测试都过，要我提交吗？");
    off();
    const after = getTask(task.id)!;
    expect(after.attention).toBe("review");
    expect(after.progress).toContain("这轮说完了：改好了 token 刷新");
    expect(seen).toContain("tasks");
    const c = (await (await app.request(`/conversation/${conv.id}`)).json()) as { messages: Array<{ kind: string; content: string }> };
    expect(c.messages.at(-1)!.content).toContain("终端里的 Claude 这轮说完了");
    expect(c.messages.at(-1)!.content).toContain("要我提交吗");
  });

  it("勾选验证点落在任务上；全部勾完记账并在会话里说下一步", async () => {
    const conv = (await (await app.request("/conversation/new", { method: "POST" })).json()) as { id: string };
    createJob({ id: "job-v", project: "demo", dir: "/tmp", task: "x", conversationId: conv.id, logPath: "/tmp/x.log" });
    // 会话只记在 job 上（/run 建的任务就是这样），留痕也要能落到会话里
    const task = createTask({ title: "demo：x", kind: "code", source: { jobId: "job-v" }, project: "demo", status: "processing" });
    await rpc("job-v", "tools/call", { name: "friday_done", arguments: { summary: "改完", testResult: "过", verify: ["看 A", "看 B"] } });
    let t = (await (await app.request(`/tasks/${task.id}/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ index: 0, checked: true }) })).json()) as { report: { checked: boolean[] }; attention?: string };
    expect(t.report.checked).toEqual([true, false]);
    expect(t.attention).toBe("review");
    t = (await (await app.request(`/tasks/${task.id}/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ index: 1, checked: true }) })).json()) as typeof t;
    expect(t.report.checked).toEqual([true, true]);
    // 没有活着的 PTY：说清楚终端已断，等你看的标记清掉
    expect(t.attention).toBeUndefined();
    const audit = (await (await app.request(`/audit?taskId=${task.id}`)).json()) as Array<{ action: string }>;
    expect(audit.some((e) => e.action === "verified_all")).toBe(true);
    const c = (await (await app.request(`/conversation/${conv.id}`)).json()) as { messages: Array<{ content: string }> };
    expect(c.messages.at(-1)!.content).toContain("确认全部验证点");
    expect(setVerified("nope", 0, true)).toBeUndefined();
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
    const notices = (await (await app.request("/notifications")).json()) as Array<{ title: string }>;
    expect(notices.some((n) => n.title.includes("终端在等你回答"))).toBe(true);
    const c = (await (await app.request(`/conversation/${conv.id}`)).json()) as { messages: Array<{ content: string }> };
    expect(c.messages.at(-1)!.content).toContain("终端在问你");
    // 紧跟着来的泛化 Notification 不能把具体问题盖掉
    await app.request("/jobs/job-q/message", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: "Notification", notificationType: "permission_prompt", message: "Claude needs your permission" }) });
    expect(getTask(task.id)!.progress).toContain("用哪个方案");
    await app.request("/jobs/job-q/message", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: "PostToolUse", toolName: "AskUserQuestion", toolInput: input }) });
    expect(getTask(task.id)!.attention).toBeUndefined();
  });
});
