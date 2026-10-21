import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { config } from "../config.js";
import { db } from "../memory/db.js";
import { createFeature, featureHistory, findFeatureByName, listFeatures } from "../memory/features.js";
import { createJob } from "../memory/jobs.js";
import { createTask, getTask, updateTask } from "../memory/tasks.js";
import { bridgeToolsFor, callBridge } from "./bridge.js";
import { bootstrapPrompt, bootstrapState, finishBootstrap, ingestBootstrap, startKnowledgeBootstrap } from "./knowledgeBootstrap.js";
import { openSession } from "./sessions.js";

vi.mock("./sessions.js", async (orig) => ({ ...(await orig<typeof import("./sessions.js")>()), openSession: vi.fn(async () => "job-1") }));

let repo: string;
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "kb-boot-"));
  mkdirSync(join(repo, "src/funds"), { recursive: true });
  mkdirSync(join(repo, "src/orders"), { recursive: true });
});

const writeProjects = (...names: string[]) => writeFileSync(join(config.dataDir, "projects.md"), `# 项目\n\n${names.map((n) => `## ${n}\n- 目录：${repo}\n`).join("\n")}`);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const setUpdatedAt = (id: string, at: string) => db().prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(at, id);

describe("知识库冷启动", () => {
  it("ingestBootstrap：校验名字和路径，超 200 条截断，统计新建 / 合并 / 丢弃", () => {
    const raw = { features: [{ name: "基金筛选", paths: ["src/funds", "nope"] }, { name: "" }, ...Array.from({ length: 205 }, (_, i) => ({ name: `F${i}` }))] };
    const r = ingestBootstrap("p-ib", repo, raw);
    expect(r.added).toBe(199);
    expect(r.dropped).toBe(1);
    expect(findFeatureByName("p-ib", "基金筛选")).toMatchObject({ origin: "bootstrap", paths: ["src/funds"] });
  });

  it("ingestBootstrap：features 不是数组当空", () => {
    expect(ingestBootstrap("p-bad", repo, { features: "x" })).toEqual({ added: 0, updated: 0, dropped: 0 });
    expect(ingestBootstrap("p-bad", repo, null)).toEqual({ added: 0, updated: 0, dropped: 0 });
  });

  it("重扫按名字合并不重复建", () => {
    ingestBootstrap("p-re", repo, { features: [{ name: "订单列表", paths: ["src/orders"] }] });
    const r = ingestBootstrap("p-re", repo, { features: [{ name: "订单 列表", routes: ["/orders"] }] });
    expect(r).toMatchObject({ added: 0, updated: 1 });
    expect(listFeatures("p-re")).toHaveLength(1);
    expect(listFeatures("p-re")[0]).toMatchObject({ name: "订单列表", paths: ["src/orders"], routes: ["/orders"] });
  });

  it("bootstrapPrompt：附上已有功能名单，名单过围栏", () => {
    const p = { name: "p-pr", dir: repo, aliases: [], channels: [], urls: [], envs: [], extra: {} };
    const text = bootstrapPrompt(p, [createFeature("p-pr", { name: "基金筛选" }, "bootstrap")]);
    expect(text).toContain("friday_knowledge");
    expect(text).toContain("200");
    expect(text).toMatch(/<untrusted[^>]*>[\s\S]*基金筛选[\s\S]*<\/untrusted>/);
  });

  it("已有运行中的冷启动回 busy", async () => {
    writeProjects("p-busy");
    const first = await startKnowledgeBootstrap("p-busy");
    expect(first).toMatchObject({ jobId: "job-1" });
    const anchor = getTask((first as { taskId: string }).taskId)!;
    expect(anchor).toMatchObject({ kind: "project", status: "processing", project: "p-busy", source: { knowledgeBootstrap: "p-busy", jobId: "job-1", headless: true } });
    expect(vi.mocked(openSession)).toHaveBeenCalledWith(expect.objectContaining({ id: anchor.id }), expect.objectContaining({ id: anchor.id }), expect.objectContaining({ kind: "query", project: "p-busy", repoDir: repo }));
    createJob({ id: "job-1", project: "p-busy", dir: repo, logPath: "/tmp/job-1.log", taskId: anchor.id, sessionId: anchor.id });
    expect(bootstrapState("p-busy").bootstrapping).toBe(true);
    expect(await startKnowledgeBootstrap("p-busy")).toMatchObject({ status: 409 });
  });

  it("注册表里没有的项目回 404", async () => {
    writeProjects("p-busy");
    expect(await startKnowledgeBootstrap("nope")).toMatchObject({ status: 404 });
  });

  it("bridgeToolsFor：只有冷启动 job 看得到 friday_knowledge", () => {
    const boot = createTask({ title: "知识库冷启动：p-bt", kind: "project", status: "processing", project: "p-bt", source: { knowledgeBootstrap: "p-bt", repoDir: repo, headless: true } });
    const other = createTask({ title: "改列宽", kind: "code", source: {} });
    createJob({ id: "job-boot", project: "p-bt", dir: repo, logPath: "/tmp/job-boot.log", taskId: boot.id });
    createJob({ id: "job-other", project: "p-bt", dir: repo, logPath: "/tmp/job-other.log", taskId: other.id });
    expect(bridgeToolsFor("job-boot").map((t) => t.name)).toContain("friday_knowledge");
    expect(bridgeToolsFor("job-other").map((t) => t.name)).not.toContain("friday_knowledge");
  });

  it("callBridge friday_knowledge：冷启动 job 入库，非冷启动 job 回错", async () => {
    const boot = createTask({ title: "知识库冷启动：p-cb", kind: "project", status: "processing", project: "p-cb", source: { knowledgeBootstrap: "p-cb", repoDir: repo, headless: true } });
    const other = createTask({ title: "改列宽", kind: "code", source: {} });
    createJob({ id: "job-cb-boot", project: "p-cb", dir: repo, logPath: "/tmp/a.log", taskId: boot.id });
    createJob({ id: "job-cb-other", project: "p-cb", dir: repo, logPath: "/tmp/b.log", taskId: other.id });
    expect(await callBridge("job-cb-other", "friday_knowledge", { features: [] })).toMatchObject({ isError: true });
    const r = await callBridge("job-cb-boot", "friday_knowledge", { features: [{ name: "基金筛选", paths: ["src/funds"] }, { name: "" }] });
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain("新建 1");
    expect(r.text).toContain("丢弃 1");
    expect(findFeatureByName("p-cb", "基金筛选")).toBeTruthy();
  });

  it("finishBootstrap：按标题把近一年收工的任务补进历史、记水位、锚点收工", async () => {
    ingestBootstrap("p-fb", repo, { features: [{ name: "基金筛选" }] });
    const recent = createTask({ title: "基金筛选加个排序", kind: "code", project: "p-fb", status: "done", source: {} });
    setUpdatedAt(recent.id, daysAgo(300));
    const old = createTask({ title: "基金筛选改文案", kind: "code", project: "p-fb", status: "done", source: {} });
    setUpdatedAt(old.id, daysAgo(400));
    createTask({ title: "基金筛选没做完", kind: "code", project: "p-fb", status: "processing", source: {} });
    createTask({ title: "基金筛选别的项目", kind: "code", project: "p-other", status: "done", source: {} });
    const anchor = createTask({ title: "知识库冷启动：p-fb", kind: "project", status: "processing", project: "p-fb", source: { knowledgeBootstrap: "p-fb", repoDir: repo, headless: true, jobId: "job-fb" } });
    createJob({ id: "job-fb", project: "p-fb", dir: repo, logPath: "/tmp/job-fb.log", taskId: anchor.id });
    await finishBootstrap(anchor, "job-fb", 0);
    const f = findFeatureByName("p-fb", "基金筛选")!;
    expect(featureHistory(f.id).map((h) => h.taskId)).toEqual([recent.id]);
    expect(bootstrapState("p-fb")).toMatchObject({ bootstrapping: false });
    expect(bootstrapState("p-fb").bootstrappedAt).toBeTruthy();
    expect(getTask(anchor.id)!.status).toBe("done");

    updateTask(anchor.id, { status: "processing" });
    await finishBootstrap(getTask(anchor.id)!, "job-fb", 1);
    expect(featureHistory(f.id)).toHaveLength(1);
  });
});
