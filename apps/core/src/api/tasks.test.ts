import { describe, expect, it, vi } from "vitest";
import type { Task, TaskBoard } from "@friday/shared";
import { createTask } from "../memory/tasks.js";
import { getEvent, listAudit } from "../memory/audit.js";

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
