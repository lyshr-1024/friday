import { describe, expect, it } from "vitest";
import type { PendingAction, TaskSource } from "@friday/shared";
import { extraConversationOf, legacyMirror, migrateKind, migratePending, migrateTrigger, normalizeSource, stripLegacy, syncSourcePatch } from "./externalRef.js";

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
      attrs: { typeKey: "issue", space: "projectlb", nodeKey: "fe_dev", nodeName: "前端开发", reporter: "拂晓" },
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
    expect(s.meegleId).toBe("24420780");
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

  it.each([["meegle", meegleDefect], ["slack", slackQuery]])("legacyMirror 还原老键：%s", (_, raw) => {
    const mirrored = legacyMirror(stripLegacy(normalizeSource(raw))) as Record<string, unknown>;
    for (const [k, v] of Object.entries(raw)) {
      if (k === "docs" || k === "brief" || k === "merged") continue;
      expect(mirrored[k], k).toEqual(v);
    }
    expect((mirrored.merged as Array<{ meegleId: string }> | undefined)?.[0]?.meegleId).toBe(raw === meegleDefect ? "24400002" : undefined);
  });

  it("stripLegacy 删掉所有老键，留下新键与中性字段", () => {
    const s = stripLegacy(normalizeSource(meegleDefect)) as Record<string, unknown>;
    for (const k of ["meegleId", "meegleType", "statusKey", "meegleProject", "linkedStoryId", "linkedStoryName", "meegleTags", "feDue", "beDue", "nodeKey", "nodeName", "reporter", "mergedMeegleIds", "storyContainer", "meegleClosed"]) expect(s[k], k).toBeUndefined();
    expect((s.merged as Array<Record<string, unknown>>)[0]!.meegleId).toBeUndefined();
    expect(s.external).toBeDefined();
    expect(s.url).toBe("https://m/24420780");
  });
});

describe("syncSourcePatch", () => {
  const cur = normalizeSource(meegleDefect);

  it("老键补丁带动新键", () => {
    const patch = { statusKey: "IN PROGRESS", linkedStoryId: "999", storyContainer: false } as Partial<TaskSource>;
    const s = syncSourcePatch(cur, patch);
    expect(s.external?.state?.key).toBe("IN PROGRESS");
    expect(s.external?.parent).toEqual({ id: "999", name: "客户资料新增人脸照片上传" });
    expect(s.container).toBe(false);
    expect(s.external?.schedule).toEqual(cur.external?.schedule);
  });

  it("老键清空时新键也清", () => {
    const patch = { linkedStoryId: undefined, linkedStoryName: undefined, meegleClosed: undefined } as Partial<TaskSource>;
    const s = syncSourcePatch(cur, patch);
    expect(s.external?.parent).toBeUndefined();
    expect(s.closedExternally).toBeUndefined();
  });

  it("新键补丁反写老键", () => {
    const patch: Partial<TaskSource> = { external: { ...cur.external!, state: { key: "CLOSED" }, tags: ["x"] }, mergedIds: ["1", "2"], container: false, closedExternally: "已终止" };
    const s = syncSourcePatch(cur, patch);
    expect(s.statusKey).toBe("CLOSED");
    expect(s.meegleTags).toEqual(["x"]);
    expect(s.mergedMeegleIds).toEqual(["1", "2"]);
    expect(s.storyContainer).toBe(false);
    expect(s.meegleClosed).toBe("已终止");
    expect(s.feDue).toBe("2026-10-30");
  });

  it("merged 两种形状互补", () => {
    const legacy = { merged: [{ meegleId: "7", title: "t" }] } as Partial<TaskSource>;
    expect(syncSourcePatch(cur, legacy).merged).toEqual([{ id: "7", meegleId: "7", title: "t" }]);
    const fresh: Partial<TaskSource> = { merged: [{ id: "8", title: "u" }] };
    expect(syncSourcePatch(cur, fresh).merged).toEqual([{ id: "8", meegleId: "8", title: "u" }]);
  });

  it("补丁没碰的键两边都不变", () => {
    const patch: Partial<TaskSource> = { note: "hi" };
    expect(syncSourcePatch(cur, patch)).toEqual({ ...cur, note: "hi" });
  });

  it("对话老键补丁带动 external", () => {
    const c = normalizeSource(slackQuery);
    const patch = { threadTs: "3.4", userName: "千一" } as Partial<TaskSource>;
    const s = syncSourcePatch(c, patch);
    expect(s.external?.attrs).toEqual({ channelId: "C1", threadTs: "3.4" });
    expect(s.external?.author).toBe("千一");
  });

  it("新建时只给老键也补出新键", () => {
    const patch = { meegleId: "1", meegleType: "story" } as Partial<TaskSource>;
    const s = syncSourcePatch({ note: "n" }, patch);
    expect(s.external).toMatchObject({ tool: "meegle", type: "work_item", id: "1", kind: "story" });
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
      { id: "a", type: "slack_reply", label: "回复", detail: "d", payload: { channel: "C1", threadTs: "1.2", userName: "灵雨", text: "看到了" } },
      { id: "b", type: "meegle_update", label: "改状态", detail: "d", payload: { x: 1 } },
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

describe("syncSourcePatch 边界", () => {
  it("给工单的 external 打补丁不动对话老键", () => {
    const cur = normalizeSource({ meegleId: "5", conversation: "C1:9.9" });
    const s = syncSourcePatch(cur, { external: { ...cur.external!, state: { key: "CLOSED" } } });
    expect(s.conversation).toBe("C1:9.9");
    expect(s.statusKey).toBe("CLOSED");
  });
});

describe("老键清空不留旧值", () => {
  it("带 meegleId 的整组补丁把 attrs 清成 undefined 的键一起清掉，重读一致", () => {
    const cur = normalizeSource(meegleDefect);
    const patch = { meegleId: "24420780", nodeKey: undefined, nodeName: undefined, reporter: undefined, linkedStoryId: undefined, linkedStoryName: undefined, feDue: undefined, beDue: undefined, meegleTags: undefined, statusKey: undefined } as Partial<TaskSource>;
    const s = syncSourcePatch(cur, patch);
    expect(s.external?.attrs).toEqual({ typeKey: "issue", space: "projectlb" });
    for (const k of ["parent", "schedule", "tags", "state"] as const) expect(s.external?.[k], k).toBeUndefined();
    const reread = normalizeSource(JSON.parse(JSON.stringify(s)) as Record<string, unknown>);
    expect(reread.external).toEqual(s.external);
  });

  it("工具自己加的 attrs 在重建时留着", () => {
    const cur = normalizeSource({ ...meegleDefect, external: { ...normalizeSource(meegleDefect).external!, attrs: { ...normalizeSource(meegleDefect).external!.attrs, extra: "x" } } });
    const s = syncSourcePatch(cur, { meegleId: "24420780", reporter: undefined } as Partial<TaskSource>);
    expect(s.external?.attrs?.extra).toBe("x");
    expect(s.external?.attrs?.reporter).toBeUndefined();
  });

  it("对话侧：channelId / threadTs / userName 清空后 external 里也没有", () => {
    const cur = normalizeSource(slackQuery);
    const patch = { channelId: undefined, threadTs: undefined, userName: undefined } as Partial<TaskSource>;
    const s = syncSourcePatch(cur, patch);
    expect(s.external).toEqual({ tool: "slack", type: "conversation", id: "C1:1.2" });
    expect(normalizeSource(JSON.parse(JSON.stringify(s)) as Record<string, unknown>).external).toEqual(s.external);
    const s2 = syncSourcePatch(cur, { conversation: "C1:1.2", channelId: undefined, userName: undefined } as Partial<TaskSource>);
    expect(s2.external).toEqual({ tool: "slack", type: "conversation", id: "C1:1.2", attrs: { threadTs: "1.2" } });
  });
});
