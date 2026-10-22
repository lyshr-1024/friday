import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { fridayToolList, fridayTools } from "./tools.js";
import { addFeatureHistory, createFeature, writeKnowledge } from "../memory/features.js";
import { addMessage, createConversation, listMessages } from "../memory/conversations.js";
import { addPending, createTask, getTask, listTasks, updateTask } from "../memory/tasks.js";
import { mainConversationId } from "../memory/mainConversation.js";

const sayMock = vi.hoisted(() => vi.fn(async () => "sent"));
const approveMock = vi.hoisted(() => vi.fn());
const startMock = vi.hoisted(() => vi.fn());
const touchMock = vi.hoisted(() => vi.fn());
vi.mock("./runs.js", async (orig) => ({ ...(await orig<typeof import("./runs.js")>()), touchTask: touchMock }));
vi.mock("./terminal.js", async (orig) => ({ ...(await orig<typeof import("./terminal.js")>()), say: sayMock }));
vi.mock("./pipeline.js", async (orig) => ({ ...(await orig<typeof import("./pipeline.js")>()), approvePending: approveMock, startAutonomousJob: startMock }));

const call = async (name: string, args: Record<string, unknown>) => {
  const t = fridayToolList().find((x) => x.name === name)!;
  return ((await t.handler(args as never, {})).content[0] as { text: string }).text;
};

const callIn = async (conv: string, name: string, args: Record<string, unknown>) => {
  const t = fridayToolList(conv).find((x) => x.name === name)!;
  return ((await t.handler(args as never, {})).content[0] as { text: string }).text;
};

describe("Friday MCP server", () => {
  // tools/list 一次返回全部工具，一个 schema 转不了整个列表就失败，会话里一个工具都没有（2026-10-13 z.record 踩过）
  it("tools/list 能列出全部工具", async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await fridayTools().instance.connect(a);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(b);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(fridayToolList().map((t) => t.name).sort());
    await client.close();
  });

  it("memory_read knowledge:<项目> 读整份，没有时列出有知识库的项目", async () => {
    const f = createFeature("p-tk", { name: "对账单", where: "资金 › 对账" }, "task");
    writeKnowledge("p-tk");
    expect(await call("memory_read", { file: "knowledge:p-tk" })).toMatch(/^<untrusted source="knowledge">[\s\S]*## 对账单[\s\S]*<\/untrusted>$/);
    const none = await call("memory_read", { file: "knowledge:p-none" });
    expect(none).toContain("没有 p-none 的知识库");
    expect(none).toContain("p-tk");
    expect(f.id).toBeTruthy();
  });

  it("knowledge_search 返回命中条目和最近一条历史", async () => {
    const f = createFeature("p-ks", { name: "优惠券", where: "营销 › 券", paths: ["src/coupon"], routes: ["/coupon"], summary: "发券核销" }, "task");
    addFeatureHistory({ featureId: f.id, at: "2026-10-01T00:00:00Z", what: "加了过期提醒", files: [] });
    const out = await call("knowledge_search", { project: "p-ks", query: "优惠券怎么核销" });
    for (const s of ["优惠券", "营销 › 券", "src/coupon", "/coupon", "发券核销", "加了过期提醒"]) expect(out).toContain(s);
    expect(await call("knowledge_search", { project: "p-ks", query: "毫不相干" })).toContain("没有");
  });
});

describe("run_claude", () => {
  it("没给任务：不开终端，指去项目页", async () => {
    const out = await call("run_claude", { project: "whatever" });
    expect(out).toBe("没说要做什么。想自己在项目里干活去项目页开 Claude；要 Friday 做就说做什么。");
  });
});

describe("会话工具点名任务", () => {
  const open = () => {
    const c = createConversation().id;
    return c;
  };
  const mk = (title: string, extra: Record<string, unknown> = {}) => createTask({ title, kind: "code", source: { ...extra }, status: "review" });
  const said = (c: string, content: string) => addMessage(c, { role: "user", kind: "ask", content });
  beforeEach(() => {
    sayMock.mockClear();
    approveMock.mockReset();
    approveMock.mockImplementation(async (id: string) => updateTask(id, { status: "done" })!);
  });

  it("terminal_say 按 #N 找任务，会话里留「→ #N 标题：已转给终端」", async () => {
    const c = open();
    const t = mk("导出中心改版", { jobId: "job-x" });
    const out = await callIn(c, "terminal_say", { taskId: `#${t.seq}`, text: "接着把筛选也做了" });
    expect(sayMock).toHaveBeenCalledWith("job-x", "接着把筛选也做了");
    expect(out).toContain("已敲进终端");
    const m = listMessages(c).find((x) => x.kind === "run")!;
    expect(m.content).toBe(`→ #${t.seq} 导出中心改版：已转给终端：接着把筛选也做了`);
    expect(m.taskIds).toEqual([t.id]);
  });

  it("找不到的 taskId：不动，提示先 tasks_list", async () => {
    const c = open();
    const out = await callIn(c, "terminal_say", { taskId: "#99999", text: "hi" });
    expect(out).toBe("没有这条任务：#99999。先用 tasks_list 找，或问用户是哪条");
    expect(sayMock).not.toHaveBeenCalled();
    expect(listMessages(c).filter((x) => x.kind === "run")).toHaveLength(0);
  });

  it("jobs_activity 两个都没给就报错", async () => {
    expect(await callIn(open(), "jobs_activity", {})).toContain("taskId");
  });

  it("jobs_activity 同时给 jobId 和 taskId 也算碰过这条任务", async () => {
    const c = open();
    const t = mk("看进度");
    touchMock.mockClear();
    await callIn(c, "jobs_activity", { taskId: `#${t.seq}`, jobId: "no-such-job" });
    expect(touchMock).toHaveBeenCalledWith(c, t.id);
  });

  it("task_update 点名任务，留痕写改了什么", async () => {
    const c = open();
    const t = mk("改文案");
    await callIn(c, "task_update", { taskId: String(t.seq), progress: "改完一半" });
    expect(getTask(t.id)!.progress).toBe("改完一半");
    expect(listMessages(c).find((x) => x.kind === "run")!.content).toMatch(new RegExp(`^→ #${t.seq} 改文案：改了 .*进展`));
  });

  const pend = (title: string, type: "git_merge" | "brief_approve") => {
    const t = mk(title);
    addPending(t.id, { type, label: `${title}动作`, detail: "d", payload: {} });
    return getTask(t.id)!;
  };
  const closeAll = (...ts: { id: string }[]) => ts.forEach((t) => updateTask(t.id, { status: "done" }));

  it("裸「通过」、同时两条在等点头：拒绝并列出两条", async () => {
    const c = open();
    const a = pend("甲", "git_merge");
    const b = pend("乙", "brief_approve");
    said(c, "通过");
    const out = await callIn(c, "task_approve", { taskId: `#${a.seq}` });
    expect(out).toContain("现在有 2 条在等你点头");
    expect(out).toContain(`#${a.seq}「甲动作」`);
    expect(out).toContain(`#${b.seq}「乙动作」`);
    expect(approveMock).not.toHaveBeenCalled();
    closeAll(a, b);
  });

  it("「#N 通过」只批 #N，点错号拒绝", async () => {
    const c = open();
    const a = pend("甲", "git_merge");
    const b = pend("乙", "brief_approve");
    said(c, `#${a.seq} 通过`);
    expect(await callIn(c, "task_approve", { taskId: `#${b.seq}` })).toContain("不是");
    expect(approveMock).not.toHaveBeenCalled();
    const out = await callIn(c, "task_approve", { taskId: `#${a.seq}` });
    expect(out).toContain("已执行");
    expect(approveMock).toHaveBeenCalledTimes(1);
    expect(listMessages(c).find((x) => x.kind === "run")!.content).toBe(`→ #${a.seq} 甲：已执行「甲动作」`);
    closeAll(a, b);
  });

  it("task_reject 点名并留痕", async () => {
    const c = open();
    const t = mk("丙");
    await callIn(c, "task_reject", { taskId: `#${t.seq}`, reason: "按钮颜色不对" });
    expect(listMessages(c).find((x) => x.kind === "run")!.content).toBe(`→ #${t.seq} 丙：已打回：按钮颜色不对`);
  });

  it("task_add 在主对话里建的任务不挂主对话", async () => {
    const c = open();
    await callIn(c, "task_add", { title: "新来的一条" });
    const t = (await import("../memory/tasks.js")).listTasks().find((x) => x.title === "新来的一条")!;
    expect(t.source.conversationId).toBeUndefined();
  });

  it("主对话 id 不会出现在任何任务上：task_add / todo_add / run_claude 都不挂", async () => {
    const main = mainConversationId();
    startMock.mockImplementation(async (t: { id: string }) => getTask(t.id)!);
    await callIn(main, "task_add", { title: "主对话建的任务" });
    await callIn(main, "todo_add", { text: "主对话记的待办" });
    await callIn(main, "run_claude", { project: process.cwd(), task: "主对话派的活" });
    expect(startMock).toHaveBeenCalled();
    const all = listTasks(undefined, 1000);
    expect(all.some((x) => x.title.includes("主对话派的活"))).toBe(true);
    expect(all.some((x) => x.source.conversationId === main)).toBe(false);
  });

  const clearWaiting = () => listTasks(["collected", "understood", "processing", "review", "blocked"], 1000).filter((x) => x.pending?.length).forEach((x) => updateTask(x.id, { status: "done" }));

  it("只有这一条在等点头：裸「通过」直接批", async () => {
    clearWaiting();
    const c = open();
    const a = pend("甲", "git_merge");
    said(c, "通过");
    expect(await callIn(c, "task_approve", { taskId: `#${a.seq}` })).toContain("已执行");
    expect(approveMock).toHaveBeenCalledTimes(1);
    closeAll(a);
  });

  it("手册卡也在等 handbook_apply：不算在内，裸「通过」照样批真任务", async () => {
    clearWaiting();
    const c = open();
    const a = pend("甲", "git_merge");
    const h = createTask({ title: "手册", kind: "handbook", source: {}, status: "review" });
    addPending(h.id, { type: "handbook_apply", label: "应用手册", detail: "d", payload: {} });
    said(c, "通过");
    expect(await callIn(c, "task_approve", { taskId: `#${a.seq}` })).toContain("已执行");
    closeAll(a, h);
  });

  it("terminal_say 终端已关：提示对该任务 task_start，不提 run_claude", async () => {
    sayMock.mockResolvedValueOnce("no-terminal");
    const t = mk("丁", { jobId: "job-gone" });
    const out = await callIn(open(), "terminal_say", { taskId: `#${t.seq}`, text: "hi" });
    expect(out).toBe(`这条任务的终端已经关掉了，转达不进去。要继续就对 #${t.seq} 丁 调 task_start 重开。`);
  });
});

describe("task_get 短号", () => {
  it("两位数短号 #12 能查到", async () => {
    let t = createTask({ title: "短号任务", kind: "verbal", source: {} });
    while (t.seq < 12) t = createTask({ title: `填充${t.seq}`, kind: "verbal", source: {} });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await fridayTools().instance.connect(a);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(b);
    const r = await client.callTool({ name: "task_get", arguments: { id: "#12" } });
    await client.close();
    expect(r.isError).toBeFalsy();
    expect((r.content as { text: string }[])[0]!.text).toContain("#12");
  });
});
