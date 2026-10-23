import { describe, expect, it, vi } from "vitest";
import type { Task, TaskBoard } from "@friday/shared";
import { createTask } from "../memory/tasks.js";
import { getEvent, listAudit, record } from "../memory/audit.js";
import { deleteTask, getTask, updateTask } from "../memory/tasks.js";
import { initMemory } from "../memory/db.js";
import { addInboxItems } from "../memory/inbox.js";
import { linkUp } from "../memory/links.js";
import { setTmuxRunner } from "../agent/tmux.js";
import { openSession, setLauncher, worktreeReady } from "../agent/sessions.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { readMemoryFile, writeMemoryFile } from "../memory/files.js";
import { fridayToolList } from "../agent/tools.js";
import { updateSettings, userSettings } from "../settings.js";
import { subscribe } from "../bus.js";
import { join } from "node:path";
import { addTestWorktree, mainRepo } from "../agent/testRepos.js";

vi.mock("../connectors/slack/keychain.js", () => ({ keychainGet: async () => undefined }));

const meegleMock = vi.hoisted(() => ({
  node: vi.fn(async () => ({ missing: [] as string[] })),
  confirmNode: vi.fn(async () => undefined),
  transitions: vi.fn(async () => [{ id: "1062795", stateKey: "IN PROGRESS", label: "开始处理" }]),
  rawTransitions: vi.fn(async () => [{ id: "1062799", state_key: "REOPENED", state_name: "Reopened", confirm_form: null }]),
  transition: vi.fn(async () => undefined),
}));

vi.mock("../connectors/meegle/client.js", async (orig) => ({
  ...(await orig<typeof import("../connectors/meegle/client.js")>()),
  MeegleConnector: class {
    getWorkItem = async () => ({ name: "缺陷", typeKey: "issue", statusKey: "REOPENED", status: "Reopened" });
    source = "meegle" as const;
    fetchWorkItems = async () => {
      throw new Error("Meegle 未登录");
    };
    nodeReadiness = meegleMock.node;
    transitionNode = meegleMock.confirmNode;
    listTransitions = meegleMock.transitions;
    listRawTransitions = meegleMock.rawTransitions;
    transitionState = meegleMock.transition;
  },
}));

const { app } = await import("./index.js");
const { seedBuiltins } = await import("../connectors/builtin.js");
seedBuiltins();

const issue = () =>
  createTask({
    title: "Fund code 搜不出来",
    kind: "work_item",
    source: { external: { tool: "meegle", type: "work_item", id: "24420780", kind: "defect", state: { key: "REOPENED" }, attrs: { typeKey: "issue", space: "pk" } }, url: "https://m/x" },
    status: "understood",
  });

const story = () =>
  createTask({
    title: "客户资料新增人脸照片上传",
    kind: "work_item",
    source: { external: { tool: "meegle", type: "work_item", id: "24333723", kind: "story", step: { key: "state_16" }, attrs: { typeKey: "story", space: "pk" } }, url: "https://m/s" },
    status: "understood",
  });

const post = (p: string, body?: unknown) =>
  app.request(p, { method: "POST", headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });

describe("缺陷状态流转", () => {
  it("列出能在 Friday 里做的流转", async () => {
    const t = issue();
    const body = (await (await app.request(`/tasks/${t.id}/transitions`)).json()) as { transitions: Array<{ label: string }> };
    expect(body.transitions.map((x) => x.label)).toEqual(["开始处理"]);
    expect(meegleMock.transitions).toHaveBeenCalledWith("pk", "24420780");
  });

  it("流转后本地状态跟着走，并记一笔能转回去的账", async () => {
    const t = issue();
    const res = await post(`/tasks/${t.id}/transition`, { id: "1062795", stateKey: "IN PROGRESS", label: "开始处理" });
    expect(res.status).toBe(200);
    expect(meegleMock.transition).toHaveBeenCalledWith("pk", "24420780", "1062795");
    expect(((await res.json()) as Task).source.external?.state?.key).toBe("IN PROGRESS");
    const ev = listAudit({ taskId: t.id })[0]!;
    expect(ev.action).toBe("meegle_transition");
    expect(ev.reversible).toBe(true);
  });

  it("转到 Resolved 就不用再修了，任务直接完成", async () => {
    const t = issue();
    const res = await post(`/tasks/${t.id}/transition`, { id: "9", stateKey: "RESOLVED", label: "修完了" });
    expect(((await res.json()) as Task).status).toBe("done");
  });

  it("撤销把 Meegle 的状态转回原来那个", async () => {
    const t = issue();
    await post(`/tasks/${t.id}/transition`, { id: "1062795", stateKey: "IN PROGRESS", label: "开始处理" });
    meegleMock.transition.mockClear();
    const ev = listAudit({ taskId: t.id }).find((e) => e.action === "meegle_transition")!;
    expect((await post(`/audit/${ev.id}/undo`)).status).toBe(200);
    expect(meegleMock.transition).toHaveBeenCalledWith("pk", "24420780", "1062799");
    expect(getEvent(ev.id)!.status).toBe("undone");
  });

  it("Meegle 不让转回去时不谎报撤销成功", async () => {
    const t = issue();
    await post(`/tasks/${t.id}/transition`, { id: "1062795", stateKey: "IN PROGRESS", label: "开始处理" });
    meegleMock.rawTransitions.mockResolvedValueOnce([]);
    const ev = listAudit({ taskId: t.id }).find((e) => e.action === "meegle_transition")!;
    expect((await post(`/audit/${ev.id}/undo`)).status).toBe(409);
    expect(getEvent(ev.id)!.status).not.toBe("undone");
  });
});

describe("需求的节点流转", () => {
  it("必填项齐了才让点，缺什么如实说", async () => {
    const t = story();
    meegleMock.node.mockResolvedValueOnce({ missing: ["Server-side integration completed"] });
    const blocked = (await (await app.request(`/tasks/${t.id}/node`)).json()) as { canConfirm: boolean; missing: string[] };
    expect(blocked.canConfirm).toBe(false);
    expect(blocked.missing).toEqual(["Server-side integration completed"]);
    meegleMock.node.mockResolvedValueOnce({ missing: [] });
    expect(((await (await app.request(`/tasks/${t.id}/node`)).json()) as { canConfirm: boolean }).canConfirm).toBe(true);
  });

  it("流转后任务收掉，账本能回滚", async () => {
    const t = story();
    const res = await post(`/tasks/${t.id}/node/confirm`);
    expect(res.status).toBe(200);
    expect(meegleMock.confirmNode).toHaveBeenCalledWith("pk", "24333723", "state_16", "confirm");
    expect(((await res.json()) as Task).status).toBe("done");
    expect(listAudit({ taskId: t.id })[0]!.action).toBe("meegle_node_confirm");
  });

  it("撤销走 rollback，理由写明是 Friday 撤的", async () => {
    const t = story();
    await post(`/tasks/${t.id}/node/confirm`);
    meegleMock.confirmNode.mockClear();
    const ev = listAudit({ taskId: t.id }).find((e) => e.action === "meegle_node_confirm")!;
    expect((await post(`/audit/${ev.id}/undo`)).status).toBe(200);
    expect(meegleMock.confirmNode).toHaveBeenCalledWith("pk", "24333723", "state_16", "rollback", expect.stringContaining("Friday"));
  });

  it("没有当前节点的任务不给流转", async () => {
    const t = createTask({ title: "口头交代", kind: "verbal", source: {}, status: "understood" });
    expect((await app.request(`/tasks/${t.id}/node`)).status).toBe(400);
  });
});

describe("Slack 没接入要说出来", () => {
  it("钥匙串里没凭证时 slackConfigured 为 false，并带上 meegleSyncedAt", async () => {
    const board = (await (await app.request("/tasks")).json()) as TaskBoard;
    expect(board.slackConfigured).toBe(false);
    expect(board).toHaveProperty("meegleSyncedAt");
  });
});

describe("只有老键的行读出来是新形状", () => {
  it("GET /tasks 对迁移前的行返回 external 与 work_item", async () => {
    const { db } = await import("../memory/db.js");
    const at = new Date().toISOString();
    db()
      .prepare("INSERT INTO tasks (id, seq, title, kind, source, status, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("legacy-row-1", 90001, "老缺陷", "meegle", JSON.stringify({ meegleId: "24499999", meegleType: "issue", statusKey: "OPEN" }), "understood", "normal", at, at);
    const board = (await (await app.request("/tasks")).json()) as TaskBoard;
    const t = board.tasks.find((x) => x.id === "legacy-row-1")!;
    expect(t.kind).toBe("work_item");
    expect(t.source.external).toMatchObject({ tool: "meegle", type: "work_item", id: "24499999", kind: "defect", state: { key: "OPEN" } });
  });
});

let seq = 0;
describe("Friday 推断的归属", () => {
  const R = mainRepo("rootproj");
  let sent: string[] = [];
  async function guessed() {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    writeFileSync(join(process.env.FRIDAY_DATA_DIR!, "projects.md"), `# 项目\n\n## rootproj\n- 目录：${R}\n`);
    const alive = new Set<string>();
    sent = [];
    setTmuxRunner(async (args) => {
      if (args[0] === "-V") return "tmux 3.5a";
      const sub = args[4];
      const target = (args[args.indexOf("-t") + 1] ?? "").replace(/^=/, "").replace(/:.*$/, "");
      if (sub === "has-session" && !alive.has(target)) throw new Error("can't find session");
      if (sub === "list-windows") return "0|claude|1\n";
      if (sub === "rename-session") { alive.delete(target); alive.add(args.at(-1)!); }
      if (sub === "send-keys" && args.includes("-l")) sent.push(args.at(-1)!);
      return "";
    });
    setLauncher(async (_req, name) => { alive.add(name); });
    const root = createTask({ title: "计费对接", kind: "work_item", source: { external: { tool: "meegle", type: "work_item", id: "S9", kind: "story", attrs: { typeKey: "story" } } }, status: "processing", project: "rootproj" });
    const jobId = await openSession(root, root, { kind: "interactive", project: "rootproj", repoDir: R, task: "x" });
    const wt = addTestWorktree(R, `rootproj-feat-${seq++}`);
    await worktreeReady(jobId, wt);
    const bug = createTask({ title: "导出按钮点两次重复下载", kind: "conversation", source: { rootId: root.id, rootGuess: true }, status: "understood" });
    return { root, bug };
  }

  it("是它：去掉推断标记，走 start 的实现进根的会话，记账", async () => {
    const { root, bug } = await guessed();
    const res = await post(`/tasks/${bug.id}/root`, { adopt: true });
    expect(res.status).toBe(200);
    const after = getTask(bug.id)!;
    expect(after.source.rootGuess).toBeUndefined();
    expect(after.source.rootId).toBe(root.id);
    expect(after.status).toBe("processing");
    expect(sent.at(-1)).toContain("导出按钮点两次重复下载");
    expect(listAudit({ taskId: bug.id }).map((e) => e.action)).toContain("root_adopted");
  });

  it("不是这条：rootId 和推断标记都去掉，记账，不进会话", async () => {
    const { bug } = await guessed();
    const res = await post(`/tasks/${bug.id}/root`, { adopt: false });
    expect(res.status).toBe(200);
    const after = getTask(bug.id)!;
    expect(after.source.rootId).toBeUndefined();
    expect(after.source.rootGuess).toBeUndefined();
    expect(after.status).toBe("understood");
    expect(sent).toEqual([]);
    expect(listAudit({ taskId: bug.id }).map((e) => e.action)).toContain("root_rejected");
  });

  it("没有待确认的归属就拒绝", async () => {
    const t = createTask({ title: "普通", kind: "verbal", source: {}, status: "understood" });
    expect((await post(`/tasks/${t.id}/root`, { adopt: true })).status).toBe(409);
    expect((await post(`/tasks/${t.id}/root`, {})).status).toBe(400);
  });

  it("开工失败时推断标记留着，可以再点", async () => {
    const { bug } = await guessed();
    updateTask(bug.source.rootId!, { project: "nowhere" });
    const res = await post(`/tasks/${bug.id}/root`, { adopt: true });
    expect(res.status).toBe(400);
    expect(getTask(bug.id)!.source.rootGuess).toBe(true);
  });
});

describe("Slack 对话里每条消息带自己的发送人", () => {
  it("两个人的 thread：各行是各自的显示名，不是头一条的", async () => {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    const t = createTask({ title: "两人对话", kind: "verbal", source: {}, status: "understood" });
    const mk = (ts: string, userName: string, text: string) => ({ id: `s-${ts}`, kind: "mention" as const, channelId: "C9", channelName: "#grp", userId: `U-${userName}`, userName, text, permalink: "https://s/x", ts, threadTs: "9.1" });
    addInboxItems([mk("9.1", "佳成 (Zhou Jiacheng)", "这个字段呢"), mk("9.2", "拂晓 (Chen Xiaofu)", "我看下")]);
    linkUp({ kind: "task", ref: t.id }, { kind: "ext", ref: "slack:conversation:C9:9.1" }, "rule", "test");
    const board = (await (await app.request("/tasks")).json()) as TaskBoard;
    const conv = board.tasks.find((x) => x.id === t.id)!.conversations![0]!;
    expect(conv.items.map((i) => i.userName)).toEqual(["佳成 (Zhou Jiacheng)", "拂晓 (Chen Xiaofu)"]);
  });
});

describe("GET /tasks/:id/related", () => {
  it("主对话里挂了它的 + 它旧会话的消息，按时间排；不相干的不出现", async () => {
    const { addMessage, createConversation } = await import("../memory/conversations.js");
    const { mainConversationId } = await import("../memory/mainConversation.js");
    const own = createConversation().id;
    const t = createTask({ title: "x", kind: "verbal", source: { conversationId: own } });
    const m1 = addMessage(own, { role: "user", kind: "ask", content: "own1" });
    await new Promise((r) => setTimeout(r, 3));
    const m2 = addMessage(mainConversationId(), { role: "user", kind: "ask", content: "hit", taskIds: [t.id] });
    addMessage(mainConversationId(), { role: "user", kind: "ask", content: "miss", taskIds: ["other"] });
    const res = await app.request(`/tasks/${t.id}/related`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Array<{ id: string }>).map((m) => m.id)).toEqual([m1.id, m2.id]);
  });

  it("任务不存在回 404", async () => {
    const res = await app.request("/tasks/nope/related");
    expect(res.status).toBe(404);
  });
});

describe("撤销项目登记、设置", () => {
  const callTool = async (name: string, args: Record<string, unknown>) => {
    const t = fridayToolList().find((x) => x.name === name)!;
    return ((await t.handler(args as never, {})).content[0] as { text: string }).text;
  };
  const dir = mkdtempSync(join(tmpdir(), "undo-proj-"));
  const seed = `# 项目\n\n## A\n- 目录：${dir}\n- 别名：老\n\n## B\n- 目录：${dir}\n`;
  const lastEvent = (action: string) => listAudit({ limit: 100 }).find((e) => e.action === action)!;

  it("只还原这一段，之后别处的改动留着", async () => {
    writeMemoryFile("projects", seed);
    writeMemoryFile("people", "# 人物\n");
    await callTool("project_update", { project: "A", fields: { 说明: "改了" } });
    const ev = lastEvent("project_updated");
    writeMemoryFile("people", `${readMemoryFile("people")}- 甲：同事\n`);
    await callTool("project_update", { project: "B", fields: { 说明: "B 的" } });
    expect((await post(`/audit/${ev.id}/undo`)).status).toBe(200);
    const md = readMemoryFile("projects");
    expect(md).not.toContain("改了");
    expect(md).toContain("- 别名：老");
    expect(md).toContain("- 说明：B 的");
    expect(readMemoryFile("people")).toContain("- 甲：同事");
    expect(getEvent(ev.id)!.status).toBe("undone");
  });

  it("新建项目的撤销是删掉那一段", async () => {
    writeMemoryFile("projects", seed);
    await callTool("project_update", { project: "C", create: true, fields: { 目录: dir } });
    expect(readMemoryFile("projects")).toContain("## C");
    const ev = lastEvent("project_updated");
    expect((await post(`/audit/${ev.id}/undo`)).status).toBe(200);
    expect(readMemoryFile("projects")).toBe(seed);
  });

  it("改名后撤销：409、文件不变、不多出重复段", async () => {
    writeMemoryFile("projects", seed);
    await callTool("project_update", { project: "A", fields: { 说明: "改了" } });
    const ev = lastEvent("project_updated");
    writeMemoryFile("projects", readMemoryFile("projects").replace("## A\n", "## A2\n"));
    const before = readMemoryFile("projects");
    const res = await post(`/audit/${ev.id}/undo`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("项目「A」已经不在登记里（可能改了名），没法撤销这次改动");
    expect(readMemoryFile("projects")).toBe(before);
    expect(readMemoryFile("projects").match(/^## /gm)).toHaveLength(2);
    expect(getEvent(ev.id)!.status).not.toBe("undone");
  });

  it("撤销只能执行一次：第二次 409，中间改过的设置不被覆盖", async () => {
    updateSettings({ model: "" });
    await callTool("settings_update", { patch: { model: "opus" } });
    const ev = lastEvent("settings_changed");
    expect((await post(`/audit/${ev.id}/undo`)).status).toBe(200);
    expect(userSettings().model).toBe("");
    updateSettings({ model: "sonnet" });
    const res = await post(`/audit/${ev.id}/undo`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("这条已经撤销过了");
    expect(userSettings().model).toBe("sonnet");
  });

  it("设置撤销发 settings 事件", async () => {
    updateSettings({ model: "" });
    await callTool("settings_update", { patch: { model: "opus" } });
    const ev = lastEvent("settings_changed");
    const seen: string[] = [];
    const stop = subscribe((e) => seen.push(e.type));
    expect((await post(`/audit/${ev.id}/undo`)).status).toBe(200);
    stop();
    expect(seen).toContain("settings");
  });
});

describe("合并的撤销", () => {
  const workItem = (id: string, title: string) =>
    createTask({ title, kind: "work_item", source: { external: { tool: "meegle", type: "work_item", id, kind: "story", attrs: { typeKey: "story", space: "pk" } } }, status: "understood" });

  it("撤销把被并掉的工单号从宿主上摘掉", async () => {
    const into = workItem("30000001", "一期");
    const from = workItem("30000002", "二期");
    expect((await post(`/tasks/${into.id}/merge`, { fromTaskId: from.id })).status).toBe(200);
    expect(getTask(into.id)!.source.mergedIds).toContain("30000002");
    const ev = listAudit({ taskId: into.id }).find((e) => e.action === "task_merged")!;
    expect((await post(`/audit/${ev.id}/undo`)).status).toBe(200);
    expect(getTask(from.id)).toBeTruthy();
    const host = getTask(into.id)!;
    expect(host.source.mergedIds ?? []).not.toContain("30000002");
    expect((host.source.merged ?? []).map((m) => m.id)).not.toContain("30000002");
  });

  it("老账（evidence 写的是 fromMeegleId）撤销同样摘掉", async () => {
    const into = workItem("30000011", "一期");
    const from = workItem("30000012", "二期");
    updateTask(into.id, { source: { mergedIds: ["30000012"], merged: [{ id: "30000012", title: "二期" }] } });
    const row = deleteTask(from.id)!;
    const ev = record({
      taskId: into.id,
      action: "task_merged",
      why: "旧版合并",
      how: "旧版合并",
      evidence: { fromTaskId: from.id, fromMeegleId: "30000012", mergedIds: ["30000012"] },
      risk: "reversible",
      undo: { kind: "restore_task", row },
    });
    expect((await post(`/audit/${ev.id}/undo`)).status).toBe(200);
    expect(getTask(from.id)).toBeTruthy();
    const host = getTask(into.id)!;
    expect(host.source.mergedIds ?? []).not.toContain("30000012");
    expect((host.source.merged ?? []).map((m) => m.id)).not.toContain("30000012");
  });
});
