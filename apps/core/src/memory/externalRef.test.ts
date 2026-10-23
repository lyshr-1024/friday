import { describe, expect, it } from "vitest";
import type { PendingAction } from "@friday/shared";
import { extraConversationOf, migrateKind, migratePending, migrateTrigger, normalizeSource } from "./externalRef.js";

const meegleDefect = {
  meegleId: "24420780",
  meegleType: "issue",
  statusKey: "REOPENED",
  meegleProject: "projectlb",
  linkedStoryId: "24400001",
  linkedStoryName: "客户资料新增人脸照片上传",
  meegleTags: ["Backend Iteration"],
  feDue: "2026-10-30",
  beDue: "2026-10-28",
  nodeKey: "fe_dev",
  nodeName: "前端开发",
  reporter: "拂晓",
  mergedMeegleIds: ["24400002"],
  merged: [{ meegleId: "24400002", title: "二期", url: "https://m/2", docs: [{ url: "https://d/2", from: "meegle" }] }],
  storyContainer: true,
  meegleClosed: "已关闭",
  url: "https://m/24420780",
  docs: [{ url: "https://d/1", from: "meegle" }, { url: "https://d/3", from: "user" }],
  brief: { deps: [{ what: "设计稿", status: "ready", evidence: { at: "2026-10-20", source: "meegle" } }, { what: "接口", status: "pending", evidence: { at: "2026-10-20", source: "slack" } }] },
};

const slackQuery = { conversation: "C1:1.2", channelId: "C1", threadTs: "1.2", userName: "灵雨", headless: true, jobId: "j1" };

describe("normalizeSource", () => {
  it("老 Meegle 缺陷补出 external 与中性字段", () => {
    const s = normalizeSource(meegleDefect);
    expect(s.external).toEqual({
      tool: "meegle",
      type: "work_item",
      id: "24420780",
      kind: "defect",
      state: { key: "REOPENED" },
      parent: { id: "24400001", name: "客户资料新增人脸照片上传" },
      schedule: { frontend: "2026-10-30", backend: "2026-10-28" },
      tags: ["Backend Iteration"],
      step: { key: "fe_dev", name: "前端开发" },
      attrs: { typeKey: "issue", space: "projectlb", reporter: "拂晓" },
    });
    expect(s.mergedIds).toEqual(["24400002"]);
    expect(s.merged?.[0]?.id).toBe("24400002");
    expect(s.merged?.[0]?.docs?.[0]?.from).toBe("sync");
    expect(s.container).toBe(true);
    expect(s.closedExternally).toBe("已关闭");
    expect(s.docs?.[0]?.from).toBe("sync");
    expect(s.docs?.[1]?.from).toBe("user");
    expect(s.brief?.deps[0]?.evidence?.source).toBe("work_item");
    expect(s.brief?.deps[1]?.evidence?.source).toBe("conversation");
    expect(s.url).toBe("https://m/24420780");
  });

  it.each([
    ["story", "story"],
    ["issue", "defect"],
    ["defect", "defect"],
    ["bug", "defect"],
    ["project", "other"],
    [undefined, "other"],
  ])("工单类型 %s → %s", (typeKey, kind) => {
    expect(normalizeSource({ meegleId: "1", ...(typeKey ? { meegleType: typeKey } : {}) }).external?.kind).toBe(kind);
  });

  it("老 Slack 查询任务 → conversation", () => {
    const s = normalizeSource(slackQuery);
    expect(s.external).toEqual({ tool: "slack", type: "conversation", id: "C1:1.2", author: "灵雨", attrs: { channelId: "C1", threadTs: "1.2" } });
    expect(s.headless).toBe(true);
  });

  it("只有 threadId 的老行标 legacy thread", () => {
    const s = normalizeSource({ threadId: "T9" });
    expect(s.external).toEqual({ tool: "slack", type: "conversation", id: "T9", attrs: { legacy: "thread" } });
  });

  it("同时有工单号和对话键：工单优先，对话键交给 extraConversationOf", () => {
    const raw = { meegleId: "5", conversation: "C1:9.9" };
    expect(normalizeSource(raw).external?.tool).toBe("meegle");
    expect(extraConversationOf(raw)).toBe("C1:9.9");
    expect(extraConversationOf({ meegleId: "5" })).toBeUndefined();
    expect(extraConversationOf({ conversation: "C1:9.9" })).toBeUndefined();
  });

  it("已有新键时以新键为准", () => {
    const s = normalizeSource({ meegleId: "1", statusKey: "OPEN", external: { tool: "meegle", type: "work_item", id: "1", state: { key: "CLOSED" } } });
    expect(s.external?.state?.key).toBe("CLOSED");
  });

  it("没有来源的任务不加 external", () => {
    expect(normalizeSource({ note: "x" })).toEqual({ note: "x" });
  });

  it.each([["meegle", meegleDefect], ["slack", slackQuery], ["thread", { threadId: "T9" }], ["both", { meegleId: "5", conversation: "C1:9.9" }]])("幂等：%s", (_, raw) => {
    const once = normalizeSource(raw);
    expect(normalizeSource(once as Record<string, unknown>)).toEqual(once);
  });

  it("剥掉所有老键，留下新键与中性字段", () => {
    const s = normalizeSource(meegleDefect) as Record<string, unknown>;
    for (const k of ["meegleId", "meegleType", "statusKey", "meegleProject", "linkedStoryId", "linkedStoryName", "meegleTags", "feDue", "beDue", "nodeKey", "nodeName", "reporter", "mergedMeegleIds", "storyContainer", "meegleClosed"]) expect(s[k], k).toBeUndefined();
    for (const k of ["conversation", "channelId", "threadTs", "userName", "threadId"]) expect((normalizeSource(slackQuery) as Record<string, unknown>)[k], k).toBeUndefined();
    expect((s.merged as Array<Record<string, unknown>>)[0]!.meegleId).toBeUndefined();
    expect(s.external).toBeDefined();
    expect(s.url).toBe("https://m/24420780");
  });
});

describe("migrate*", () => {
  it("migrateKind", () => {
    expect(migrateKind("meegle")).toBe("work_item");
    expect(migrateKind("slack")).toBe("conversation");
    expect(migrateKind("code")).toBe("code");
  });

  it("migrateTrigger", () => {
    expect(migrateTrigger("slack")).toBe("chat");
    expect(migrateTrigger("retry")).toBe("retry");
  });

  it("migratePending：slack_reply → chat_reply，meegle_update → custom", () => {
    const old: PendingAction[] = [
      { id: "a", type: "slack_reply" as PendingAction["type"], label: "回复", detail: "d", payload: { channel: "C1", threadTs: "1.2", userName: "灵雨", text: "看到了" } },
      { id: "b", type: "meegle_update" as PendingAction["type"], label: "改状态", detail: "d", payload: { x: 1 } },
      { id: "c", type: "git_merge", label: "合并", detail: "d", payload: { branch: "b" } },
    ];
    const out = migratePending(old);
    expect(out[0]!.type).toBe("chat_reply");
    expect(out[0]!.payload).toEqual({ text: "看到了", to: { tool: "slack", type: "conversation", id: "C1:1.2", author: "灵雨", attrs: { channelId: "C1", threadTs: "1.2" } } });
    expect(out[1]!.type).toBe("custom");
    expect(out[2]).toEqual(old[2]);
    expect(migratePending(out)).toEqual(out);
  });
});
