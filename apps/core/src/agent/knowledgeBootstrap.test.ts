import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { config } from "../config.js";
import { listAudit } from "../memory/audit.js";
import { getCursor } from "../memory/inbox.js";
import { db } from "../memory/db.js";
import { correctFeature, createFeature, featureHistory, findFeatureByName, getFeature, hasHistoryFor, listFeatures } from "../memory/features.js";
import { createJob } from "../memory/jobs.js";
import { createTask, findTaskBySource, getTask, updateTask } from "../memory/tasks.js";
import { bridgeToolsFor, callBridge } from "./bridge.js";
import { onJobExit } from "./pipeline.js";
import { closeJobTerminal } from "./terminal.js";
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
const listTasksBy = (p: string) => [findTaskBySource((s) => s.knowledgeBootstrap === p, true)].filter((t) => !!t);
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
    const p = { name: "p-pr", dir: repo, aliases: [], channels: [], urls: [], envs: [], protected: [], extra: {} };
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

  it("openSession 失败：锚点状态不动、不记水位", async () => {
    writeProjects("p-fail");
    const anchor = createTask({ title: "知识库冷启动：p-fail", kind: "project", status: "done", project: "p-fail", source: { knowledgeBootstrap: "p-fail", repoDir: repo, headless: true, jobId: "job-old" } });
    vi.mocked(openSession).mockRejectedValueOnce(new Error("内嵌终端需要 tmux"));
    await expect(startKnowledgeBootstrap("p-fail")).rejects.toThrow("tmux");
    expect(getTask(anchor.id)).toMatchObject({ status: "done", source: { jobId: "job-old" } });
    expect(getCursor("knowledge:bootstrapped:p-fail")).toBeUndefined();
  });

  it("openSession 失败：新建的锚点也不是 processing", async () => {
    writeProjects("p-fail2");
    vi.mocked(openSession).mockRejectedValueOnce(new Error("内嵌终端需要 tmux"));
    await expect(startKnowledgeBootstrap("p-fail2")).rejects.toThrow("tmux");
    expect(listTasksBy("p-fail2").every((t) => t.status !== "processing")).toBe(true);
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

  it("冷启动 job 调 friday_done / progress / blocked / finish：只回一句，不碰锚点", async () => {
    const boot = createTask({ title: "知识库冷启动：p-dn", kind: "project", status: "processing", project: "p-dn", source: { knowledgeBootstrap: "p-dn", repoDir: repo, headless: true } });
    createJob({ id: "job-dn", project: "p-dn", dir: repo, logPath: "/tmp/dn.log", taskId: boot.id });
    for (const name of ["friday_done", "friday_progress", "friday_blocked", "friday_finish"]) {
      const r = await callBridge("job-dn", name, { summary: "列完了", testResult: "无", text: "进展", reason: "卡住" });
      expect(r).toEqual({ text: "这个会话不用调这个，报完直接退出" });
    }
    const t = getTask(boot.id)!;
    expect(t.report).toBeUndefined();
    expect(t).toMatchObject({ status: "processing" });
    expect(t.progress).toBeFalsy();
    expect(t.attention).toBeUndefined();
  });

  it("onJobExit：冷启动 job 退出走收尾、不返回任务（不发交付通知）", async () => {
    const anchor = createTask({ title: "知识库冷启动：p-ex", kind: "project", status: "processing", project: "p-ex", source: { knowledgeBootstrap: "p-ex", repoDir: repo, headless: true, jobId: "job-ex" } });
    createJob({ id: "job-ex", project: "p-ex", dir: repo, logPath: "/tmp/ex.log", taskId: anchor.id });
    expect(onJobExit("job-ex", 0)).toBeUndefined();
    await vi.waitFor(() => expect(getTask(anchor.id)!.status).toBe("done"));
    expect(getCursor("knowledge:bootstrapped:p-ex")).toBeTruthy();
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

  it("finishBootstrap：只读查询任务不补进历史", async () => {
    ingestBootstrap("p-q", repo, { features: [{ name: "基金筛选" }] });
    const q = createTask({ title: "基金筛选怎么排序的", kind: "slack", project: "p-q", status: "done", source: { headless: true, conversation: "C1:1.0" } });
    const anchor = createTask({ title: "知识库冷启动：p-q", kind: "project", status: "processing", project: "p-q", source: { knowledgeBootstrap: "p-q", repoDir: repo, headless: true, jobId: "job-q" } });
    createJob({ id: "job-q", project: "p-q", dir: repo, logPath: "/tmp/job-q.log", taskId: anchor.id });
    await finishBootstrap(anchor, "job-q", 0);
    expect(hasHistoryFor(findFeatureByName("p-q", "基金筛选")!.id, q.id)).toBe(false);
  });

  it("finishBootstrap：异常退出且这次一条都没入库，不记水位，账记失败、锚点照样收", async () => {
    ingestBootstrap("p-nf", repo, { features: [{ name: "老功能" }] });
    const anchor = createTask({ title: "知识库冷启动：p-nf", kind: "project", status: "processing", project: "p-nf", source: { knowledgeBootstrap: "p-nf", repoDir: repo, headless: true, jobId: "job-nf" } });
    db().prepare("UPDATE features SET updated_at = ? WHERE project = ?").run(daysAgo(1), "p-nf");
    createJob({ id: "job-nf", project: "p-nf", dir: repo, logPath: "/tmp/job-nf.log", taskId: anchor.id });
    await finishBootstrap(anchor, "job-nf", 1);
    expect(getCursor("knowledge:bootstrapped:p-nf")).toBeUndefined();
    expect(listAudit({ taskId: anchor.id }).find((e) => e.action === "knowledge_bootstrapped")).toMatchObject({ status: "failed" });
    expect(getTask(anchor.id)!.status).toBe("done");
  });

  it("finishBootstrap：异常退出但这次入了库，照记水位", async () => {
    const anchor = createTask({ title: "知识库冷启动：p-pf", kind: "project", status: "processing", project: "p-pf", source: { knowledgeBootstrap: "p-pf", repoDir: repo, headless: true, jobId: "job-pf" } });
    createJob({ id: "job-pf", project: "p-pf", dir: repo, logPath: "/tmp/job-pf.log", taskId: anchor.id });
    ingestBootstrap("p-pf", repo, { features: [{ name: "订单列表" }] });
    await finishBootstrap(anchor, "job-pf", 1);
    expect(getCursor("knowledge:bootstrapped:p-pf")).toBeTruthy();
  });
});

describe("冷启动会话被手动关掉", () => {
  it("关终端也走收尾：入过库就记水位、锚点收工", async () => {
    const anchor = createTask({ title: "知识库冷启动：p-kc", kind: "project", status: "processing", project: "p-kc", source: { knowledgeBootstrap: "p-kc", repoDir: repo, headless: true, jobId: "job-kc" } });
    createJob({ id: "job-kc", project: "p-kc", dir: repo, logPath: "/tmp/job-kc.log", taskId: anchor.id });
    ingestBootstrap("p-kc", repo, { features: [{ name: "订单列表" }] });
    await closeJobTerminal("job-kc", "你在顶栏的终端列表里关了它", anchor.id);
    await vi.waitFor(() => expect(getTask(anchor.id)!.status).toBe("done"));
    expect(getCursor("knowledge:bootstrapped:p-kc")).toBeTruthy();
  });

  it("提示词：命令不许放后台", () => {
    expect(bootstrapPrompt({ name: "p-kp", dir: repo, aliases: [], channels: [], urls: [], envs: [], protected: [], extra: {} }, [])).toContain("不要放到后台");
  });
});

describe("重扫不覆盖纠正过的字段", () => {
  it("correctFeature where 后 ingestBootstrap 给旧值仍保留", () => {
    const f = createFeature("kb-corr", { name: "基金筛选", where: "A 仓" }, "bootstrap");
    correctFeature(f.id, { where: "B 仓" });
    ingestBootstrap("kb-corr", repo, { features: [{ name: "基金筛选", where: "A 仓", summary: "新说明" }] });
    expect(getFeature(f.id)).toMatchObject({ where: "B 仓", summary: "新说明" });
  });
});
