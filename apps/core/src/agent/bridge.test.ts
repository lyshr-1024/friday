import { describe, expect, it } from "vitest";
import { app } from "../api/index.js";
import { createJob } from "../memory/jobs.js";
import { createTask, getTask } from "../memory/tasks.js";
import { subscribe } from "../bus.js";
import { turnFinished } from "./bridge.js";

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
});
