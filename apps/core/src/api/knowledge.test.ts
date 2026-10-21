import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectKnowledge } from "@friday/shared";
import { describe, expect, it, vi } from "vitest";
import { config } from "../config.js";
import { listAudit } from "../memory/audit.js";
import { addFeatureHistory, createFeature, listFeatures, readKnowledge, writeKnowledge } from "../memory/features.js";
import { knowledge } from "./knowledge.js";

vi.mock("../memory/features.js", async (orig) => {
  const m = await orig<typeof import("../memory/features.js")>();
  return { ...m, writeKnowledge: vi.fn(m.writeKnowledge) };
});

vi.mock("../agent/knowledgeBootstrap.js", async (orig) => ({
  ...(await orig<typeof import("../agent/knowledgeBootstrap.js")>()),
  startKnowledgeBootstrap: vi.fn(async (name: string) => {
    if (name === "炸了") throw new Error("内嵌终端需要 tmux：brew install tmux");
    if (name === "在扫") return { error: "这个项目的知识库正在扫", status: 409 };
    return { taskId: "t1", jobId: "j1" };
  }),
}));

const writeProjects = (...names: string[]) => {
  const repo = mkdtempSync(join(tmpdir(), "kb-api-"));
  writeFileSync(join(config.dataDir, "projects.md"), `# 项目\n\n${names.map((n) => `## ${n}\n- 目录：${repo}\n`).join("\n")}`);
};

describe("/projects/:name/knowledge", () => {
  it("GET 返回功能和历史，按 updatedAt 倒序", async () => {
    writeProjects("kb-a");
    const older = createFeature("kb-a", { name: "基金筛选" }, "bootstrap", "2026-10-01T00:00:00.000Z");
    createFeature("kb-a", { name: "订单列表" }, "bootstrap", "2026-10-02T00:00:00.000Z");
    addFeatureHistory({ featureId: older.id, taskId: "task-1", at: "2026-10-03T00:00:00.000Z", what: "加了筛选项", files: ["src/funds/a.ts"] });
    const r = await knowledge.request(`/projects/${encodeURIComponent("kb-a")}/knowledge`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as ProjectKnowledge;
    expect(body.features.map((f) => f.name)).toEqual(["订单列表", "基金筛选"]);
    expect(body.features[0]!.history).toEqual([]);
    expect(body.features[1]!.history).toMatchObject([{ taskId: "task-1", what: "加了筛选项" }]);
    expect(body.bootstrapping).toBe(false);
  });

  it("GET 注册表里没有的项目 404", async () => {
    writeProjects("kb-a");
    expect((await knowledge.request("/projects/nope/knowledge")).status).toBe(404);
  });

  it("POST bootstrap 按 status 回错误，开会话抛错回 500", async () => {
    writeProjects("kb-a", "在扫", "炸了");
    const ok = await knowledge.request("/projects/kb-a/knowledge/bootstrap", { method: "POST" });
    expect(await ok.json()).toEqual({ taskId: "t1", jobId: "j1" });
    expect((await knowledge.request(`/projects/${encodeURIComponent("在扫")}/knowledge/bootstrap`, { method: "POST" })).status).toBe(409);
    const boom = await knowledge.request(`/projects/${encodeURIComponent("炸了")}/knowledge/bootstrap`, { method: "POST" });
    expect(boom.status).toBe(500);
    expect(await boom.json()).toEqual({ error: "内嵌终端需要 tmux：brew install tmux" });
  });
});

describe("/features/:id", () => {
  it("DELETE 删掉并重渲染文件、记一条账", async () => {
    const f = createFeature("kb-del", { name: "持仓页" }, "task");
    addFeatureHistory({ featureId: f.id, at: "2026-10-03T00:00:00.000Z", what: "改了排序", files: [] });
    writeKnowledge("kb-del");
    expect(readKnowledge("kb-del")).toContain("持仓页");
    const r = await knowledge.request(`/features/${f.id}`, { method: "DELETE" });
    expect(await r.json()).toEqual({ ok: true });
    expect(listFeatures("kb-del")).toEqual([]);
    expect(readKnowledge("kb-del")).not.toContain("持仓页");
    const ev = listAudit({ limit: 20 }).find((e) => e.action === "feature_deleted" && (e.evidence as { feature?: { id: string } }).feature?.id === f.id);
    expect(ev).toMatchObject({ risk: "irreversible", reversible: false });
    expect((ev!.evidence as { history: unknown[] }).history).toHaveLength(1);
    expect((await knowledge.request(`/features/${f.id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("DELETE 渲染文件出错也先把证据记下（删掉的内容只剩账上这一份）", async () => {
    const f = createFeature("kb-del2", { name: "资金流水" }, "task");
    vi.mocked(writeKnowledge).mockImplementationOnce(() => {
      throw new Error("磁盘满了");
    });
    expect((await knowledge.request(`/features/${f.id}`, { method: "DELETE" })).status).toBe(500);
    expect(listAudit({ limit: 20 }).find((e) => e.action === "feature_deleted" && (e.evidence as { feature?: { id: string } }).feature?.id === f.id)).toBeTruthy();
  });
});
