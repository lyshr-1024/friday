import { describe, expect, it, vi } from "vitest";
import { fallbackTitle, larkTitle, mergeDocs, normUrl, pageTitle, syncDocs, fillMissingTitles } from "./docTitle.js";
import { createTask, getTask, updateTask } from "../memory/tasks.js";
import { migrateDocs } from "../memory/db.js";

describe("资料链接", () => {
  it("归一化：去掉 hash、跟踪参数和末尾斜杠，host 小写", () => {
    expect(normUrl("https://Longbridge.feishu.cn/docx/AbC/?from=from_copylink#part")).toBe("https://longbridge.feishu.cn/docx/AbC");
  });
  it("合并去重，用户加的不被同步覆盖，已有标题保留", () => {
    const a = [{ url: "https://x.feishu.cn/docx/A", title: "PRD", from: "user" as const }];
    const b = [{ url: "https://x.feishu.cn/docx/A/", from: "meegle" as const }, { url: "https://figma.com/file/B", from: "meegle" as const }];
    expect(mergeDocs(a, b)).toEqual([a[0], b[1]]);
  });
  it("合并时补上没有的标题", () => {
    expect(mergeDocs([{ url: "https://a/1", from: "meegle" }], [{ url: "https://a/1", title: "T", from: "meegle" }])).toEqual([{ url: "https://a/1", title: "T", from: "meegle" }]);
  });
  it("取不到标题时显示域名 + 末段路径", () => {
    expect(fallbackTitle("https://www.figma.com/file/B123/Export-Center")).toBe("figma.com / Export-Center");
  });
  it("从 lark-cli 的返回里取文档标题", () => {
    expect(larkTitle('<title>导出中心 PRD</title><p>正文</p>')).toBe("导出中心 PRD");
    expect(larkTitle("<p>没有标题</p>")).toBeUndefined();
    expect(larkTitle("<title>  </title>")).toBeUndefined();
  });
  it("旧的四槽 docs 迁成数组", () => {
    expect(migrateDocs({ req: "https://a/1", design: "https://b/2" })).toEqual([{ url: "https://a/1", from: "meegle" }, { url: "https://b/2", from: "meegle" }]);
    expect(migrateDocs({ meegle: "https://c/3" })).toEqual([{ url: "https://c/3", from: "user" }]);
    expect(migrateDocs([{ url: "https://d/4", from: "user" }])).toEqual([{ url: "https://d/4", from: "user" }]);
  });
  it("同步进来的资料绕开你删过的（墓碑），其余照加", () => {
    const incoming = [{ url: "https://a/1/", from: "meegle" as const }, { url: "https://a/2", from: "meegle" as const }];
    expect(syncDocs([], incoming, [normUrl("https://a/1")])).toEqual([incoming[1]]);
    expect(syncDocs([], incoming, undefined)).toEqual(incoming);
  });
  it("非 2xx 的页面（登录页）不取标题", async () => {
    vi.stubGlobal("fetch", async () => new Response("<title>Sign in · GitLab</title>", { status: 401 }));
    expect(await pageTitle("https://gitlab.example/x")).toBeUndefined();
    vi.unstubAllGlobals();
  });
  it("启动补标题：只补没有标题的开着的任务，已有的不动", async () => {
    const t = createTask({ title: "补标题", kind: "verbal", source: { docs: [{ url: "https://a/has", title: "已有", from: "user" }, { url: "https://a/none", from: "meegle" }] } });
    const done = createTask({ title: "收工的", kind: "verbal", source: { docs: [{ url: "https://a/done", from: "user" }] } });
    updateTask(done.id, { status: "done" });
    const asked: string[] = [];
    await fillMissingTitles(async (u) => { asked.push(u); return `T:${u}`; }, 2);
    expect(asked).toContain("https://a/none");
    expect(asked).not.toContain("https://a/has");
    expect(asked).not.toContain("https://a/done");
    expect(getTask(t.id)!.source.docs).toEqual([{ url: "https://a/has", title: "已有", from: "user" }, { url: "https://a/none", title: "T:https://a/none", from: "meegle" }]);
  });
});
