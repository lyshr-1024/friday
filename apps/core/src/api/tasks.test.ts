import { describe, expect, it, vi } from "vitest";
import type { Task, TaskBoard } from "@friday/shared";
import { createTask } from "../memory/tasks.js";
import { getEvent, listAudit } from "../memory/audit.js";
import { getTask, updateTask } from "../memory/tasks.js";
import { initMemory } from "../memory/db.js";
import { addInboxItems } from "../memory/inbox.js";
import { linkUp } from "../memory/links.js";
import { setTmuxRunner } from "../agent/tmux.js";
import { openSession, setLauncher, worktreeReady } from "../agent/sessions.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../connectors/keychain.js", () => ({ keychainGet: async () => undefined }));

const meegleMock = vi.hoisted(() => ({
  node: vi.fn(async () => ({ missing: [] as string[] })),
  confirmNode: vi.fn(async () => undefined),
  transitions: vi.fn(async () => [{ id: "1062795", stateKey: "IN PROGRESS", label: "开始处理" }]),
  rawTransitions: vi.fn(async () => [{ id: "1062799", state_key: "REOPENED", state_name: "Reopened", confirm_form: null }]),
  transition: vi.fn(async () => undefined),
}));

vi.mock("../connectors/meegle.js", async (orig) => ({
  ...(await orig<typeof import("../connectors/meegle.js")>()),
  MeegleConnector: class {
    source = "meegle" as const;
    fetchTodos = async () => {
      throw new Error("Meegle 未登录");
    };
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

const issue = () =>
  createTask({
    title: "Fund code 搜不出来",
    kind: "meegle",
    source: { meegleId: "24420780", meegleProject: "pk", meegleType: "issue", statusKey: "REOPENED", url: "https://m/x" },
    status: "understood",
  });

const story = () =>
  createTask({
    title: "客户资料新增人脸照片上传",
    kind: "meegle",
    source: { meegleId: "24333723", meegleProject: "pk", meegleType: "story", nodeKey: "state_16", url: "https://m/s" },
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
    expect(((await res.json()) as Task).source.statusKey).toBe("IN PROGRESS");
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

  it("没有 nodeKey 的任务不给流转", async () => {
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

let seq = 0;
describe("Friday 推断的归属", () => {
  let sent: string[] = [];
  async function guessed() {
    initMemory(process.env.FRIDAY_DATA_DIR!);
    writeFileSync(join(process.env.FRIDAY_DATA_DIR!, "projects.md"), "# 项目\n\n## rootproj\n- 目录：/r/rootproj\n");
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
    const root = createTask({ title: "计费对接", kind: "meegle", source: { meegleId: "S9", meegleType: "story" }, status: "processing", project: "rootproj" });
    const jobId = await openSession(root, root, { kind: "interactive", project: "rootproj", repoDir: "/r/rootproj", task: "x" });
    const wt = mkdtempSync(join(tmpdir(), "friday-wt-"));
    execFileSync("git", ["init", "-q", "-b", `feat-root-${process.pid}-${seq++}`, wt]);
    await worktreeReady(jobId, wt);
    const bug = createTask({ title: "导出按钮点两次重复下载", kind: "slack", source: { rootId: root.id, rootGuess: true }, status: "understood" });
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
    linkUp({ kind: "task", ref: t.id }, { kind: "slack", ref: "C9:9.1" }, "rule", "test");
    const board = (await (await app.request("/tasks")).json()) as TaskBoard;
    const conv = board.tasks.find((x) => x.id === t.id)!.conversations![0]!;
    expect(conv.items.map((i) => i.userName)).toEqual(["佳成 (Zhou Jiacheng)", "拂晓 (Chen Xiaofu)"]);
  });
});
