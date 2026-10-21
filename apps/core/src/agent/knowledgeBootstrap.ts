import { isQueryTask, type Feature, type Task } from "@friday/shared";
import { record } from "../memory/audit.js";
import { addFeatureHistory, createFeature, findFeatureByName, hasHistoryFor, listFeatures, matchFeatures, mergeFeature, writeKnowledge } from "../memory/features.js";
import { getCursor, setCursor } from "../memory/inbox.js";
import { getJob } from "../memory/jobs.js";
import { loadProjects, type Project } from "../memory/projects.js";
import { createTask, findTaskBySource, listTasks, updateTask } from "../memory/tasks.js";
import { UNTRUSTED_NOTE, untrusted } from "./fence.js";
import { cleanInput } from "./knowledge.js";
import { openSession } from "./sessions.js";
import { closeJobTerminal } from "./terminal.js";

export const BOOTSTRAP_KEY = (project: string) => `knowledge:bootstrapped:${project}`;

const MAX_BATCH = 200;
const HISTORY_DAYS = 365;

const anchorOf = (project: string): Task | undefined => findTaskBySource((s) => s.knowledgeBootstrap === project, true);
const running = (t: Task | undefined): boolean => Boolean(t?.source.jobId && getJob(t.source.jobId)?.status === "running");

export function bootstrapPrompt(project: Project, existing: Feature[]): string {
  return [
    `给项目 ${project.name}（${project.dir}）建功能知识库。这是一个**只读**任务：只读代码，不改任何文件、不建分支、不提交；改文件的工具会被守卫直接拒绝。`,
    "",
    "怎么找：先读路由表、菜单配置、页面目录，再按需深入。",
    "按「用户在界面上能叫出名字的功能」列（一个页面、一个弹窗、一条规则、一个流程），不是文件或函数。每条：",
    "- name：功能名，界面上怎么叫就怎么写",
    "- aliases：别的叫法（菜单名、路由名、常见简称）",
    "- where：在界面上哪里（菜单路径 / 入口）",
    "- paths：相关目录或文件，相对主仓写",
    "- routes：路由",
    "- summary：一句话说这个功能是干什么的",
    "",
    `用 friday_knowledge 工具分批报，参数 { features: [...] }，每批不超过 ${MAX_BATCH} 条。`,
    `已有的功能（名字一行一个）：同名的照报，Friday 会合并。\n${untrusted("knowledge", existing.map((f) => f.name).join("\n") || "（还没有）")}`,
    "",
    "全部报完直接退出：不写报告文件、不调 friday_done，也不要问用户问题——没人在终端前。",
    UNTRUSTED_NOTE,
  ].join("\n");
}

export function ingestBootstrap(project: string, repoDir: string, raw: unknown): { added: number; updated: number; dropped: number } {
  const list = (raw as { features?: unknown } | null)?.features;
  const items = Array.isArray(list) ? list.slice(0, MAX_BATCH) : [];
  const r = { added: 0, updated: 0, dropped: 0 };
  for (const it of items) {
    const input = cleanInput(it, repoDir);
    if (!input) {
      r.dropped++;
      continue;
    }
    const hit = findFeatureByName(project, input.name);
    if (hit) {
      mergeFeature(hit.id, { ...input, name: hit.name });
      r.updated++;
    } else {
      createFeature(project, input, "bootstrap");
      r.added++;
    }
  }
  writeKnowledge(project);
  return r;
}

export async function startKnowledgeBootstrap(name: string): Promise<{ taskId: string; jobId: string } | { error: string; status: 404 | 409 }> {
  const p = loadProjects().find((x) => x.name === name);
  if (!p) return { error: `注册表里没有项目「${name}」`, status: 404 };
  const found = anchorOf(name);
  if (running(found)) return { error: "这个项目的知识库正在扫", status: 409 };
  const anchor = found ?? createTask({ title: `知识库冷启动：${name}`, kind: "project", project: name, source: { knowledgeBootstrap: name, repoDir: p.dir, headless: true } });
  const jobId = await openSession(anchor, anchor, { kind: "query", project: name, repoDir: p.dir, task: bootstrapPrompt(p, listFeatures(name)) });
  // 开起来了才拉回 processing：先拉回而 openSession 失败，对账会拿旧 job 当卡住的收尾，记一次没扫过的冷启动
  updateTask(anchor.id, { status: "processing", source: { jobId } });
  record({ taskId: anchor.id, action: "knowledge_bootstrap_start", why: `给 ${name} 建功能知识库`, how: `在 ${p.dir} 里起只读后台会话，按界面上叫得出名字的功能列一遍`, evidence: { jobId, project: name }, risk: "read" });
  return { taskId: anchor.id, jobId };
}

export async function finishBootstrap(task: Task, jobId: string, exitCode: number): Promise<void> {
  const project = task.source.knowledgeBootstrap!;
  const since = new Date(Date.now() - HISTORY_DAYS * 86_400_000).toISOString();
  let filled = 0;
  for (const t of listTasks("done", 5000)) {
    if (t.project !== project || t.kind === "project" || isQueryTask(t.source) || t.updatedAt < since) continue;
    const f = matchFeatures(project, t.title, 1)[0];
    if (!f || hasHistoryFor(f.id, t.id)) continue;
    addFeatureHistory({ featureId: f.id, taskId: t.id, at: t.updatedAt, what: t.title, files: [] });
    filled++;
  }
  const features = listFeatures(project);
  const startedAt = getJob(jobId)?.startedAt;
  const ingested = !!startedAt && features.some((f) => f.updatedAt >= startedAt);
  // 异常退出又一条没报上来，算没扫过，项目页照旧给「建知识库」
  if (exitCode === 0 || ingested) setCursor(BOOTSTRAP_KEY(project), new Date().toISOString());
  writeKnowledge(project);
  const total = features.length;
  record({
    taskId: task.id,
    action: "knowledge_bootstrapped",
    why: `${project} 的知识库扫完了`,
    how: `共 ${total} 条功能，补了 ${filled} 条历史${exitCode === 0 ? "" : ingested ? "；会话异常退出，已入库的照留" : "；会话异常退出，一条都没报上来，没记成扫过"}`,
    evidence: { jobId, project, exitCode, features: total, history: filled },
    risk: "reversible",
    status: exitCode === 0 ? "done" : "failed",
  });
  await closeJobTerminal(jobId, "知识库扫完了", task.id);
  updateTask(task.id, { status: "done" });
}

export function bootstrapState(project: string): { bootstrappedAt?: string; bootstrapping: boolean } {
  const at = getCursor(BOOTSTRAP_KEY(project));
  return { ...(at ? { bootstrappedAt: at } : {}), bootstrapping: running(anchorOf(project)) };
}
