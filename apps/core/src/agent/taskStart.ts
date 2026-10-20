import type { Task } from "@friday/shared";
import { record } from "../memory/audit.js";
import { getJob } from "../memory/jobs.js";
import { resolveProject } from "../memory/projects.js";
import { getTask, updateTask } from "../memory/tasks.js";
import { finishRun, openRunForTask, pendingRunsForTask, setRunOutcome } from "../memory/runs.js";
import { clearHanded } from "./handedBugs.js";
import { handToStorySession, startAutonomousJob, startInteractiveJob } from "./pipeline.js";
import { resolveRoot } from "./sessions.js";
import { TmuxMissingError } from "./tmux.js";

export type StartResult = { task: Task } | { error: string; status: 400 | 409 };

/** 「开始做」：在这条任务的会话里开交互式终端，你自己驱动。任务卡菜单和会话里的 task_start 共用 */
export async function startTask(t: Task): Promise<StartResult> {
  if (t.source.handedAt && t.status === "processing") return { error: "这条缺陷在需求会话里由 Friday 修，要接手就在需求终端里说", status: 409 };
  const project = t.project ?? (t.source.rootId ? getTask(t.source.rootId)?.project : undefined);
  if (!project) return { error: "任务没有关联项目，先选个项目", status: 400 };
  const r = resolveProject(project);
  if (r.kind !== "match") return { error: `找不到项目 ${project}`, status: 400 };
  const running = t.source.jobId ? getJob(t.source.jobId) : undefined;
  if (running?.status === "running") return { error: "这条任务已经有终端在跑了", status: 409 };
  const docs = (t.source.docs ?? []).map((d) => d.url);
  const detail = [
    `我要开始做这条需求：${t.title}`,
    t.source.url ? `工单：${t.source.url}` : "",
    docs.length ? `文档：${docs.join(" ")}` : "",
    "",
    "先把需求和相关代码读一遍，跟我说你打算怎么改，别急着动手。",
  ].filter(Boolean).join("\n");
  // 交付过 / 卡住的缺陷你点了开始做：你接手，不再算交给需求会话的
  const mine = t.source.handedAt ? updateTask(t.id, clearHanded(t))! : t;
  try {
    return { task: await startInteractiveJob(mine, r.project.name, r.project.dir, detail) };
  } catch (e) {
    if (e instanceof TmuxMissingError) return { error: e.message, status: 400 };
    throw e;
  }
}

/** 「交给 Friday 改」：自主 claude -p 改完交审。重新开工也走这里 */
export async function handToFriday(t: Task): Promise<StartResult> {
  if (t.source.handedAt && t.status === "processing") return { error: "这条已经交代进需求会话了", status: 409 };
  if (!t.project) return { error: "任务没有关联项目，先选个项目", status: 400 };
  const r = resolveProject(t.project);
  if (r.kind !== "match") return { error: `找不到项目 ${t.project}`, status: 400 };
  const running = t.source.jobId ? getJob(t.source.jobId) : undefined;
  if (running?.status === "running") return { error: "这条任务已经在跑了，先关掉那个终端再重新开工", status: 409 };
  const root = resolveRoot(t);
  if (root.id !== t.id && root.stage === "testing") {
    const prev = t.source.handedAt ? openRunForTask(t.id) : undefined;
    const pending = t.source.handedAt && t.status === "review" ? pendingRunsForTask(t.id) : [];
    const h = await handToStorySession(t, root, { trigger: "retry" });
    if (h === "handed") {
      // 卡住的那轮不算被你打回，不进学手册的证据
      for (const run of pending) setRunOutcome(run.id, "rejected", "你让它重新修");
      if (prev) finishRun(prev.id, { exit: "report" });
      return { task: getTask(t.id)! };
    }
    return { error: { busy: "需求会话里的 Claude 还在跑，等它退出", asking: "需求终端在等你回答它的问题，答完再交", "no-session": "需求会话已不在，先给需求开终端" }[h], status: 409 };
  }
  // understanding 是「Meegle Requirement #x，节点「y」在等你」这种元信息复述，拿它当任务描述等于什么都没说；
  // intake 判过就用它写的描述，其次方案第一行，最后才是标题
  const detail = t.source.intake?.detail ?? t.plan?.split("\n").find((l) => l.trim()) ?? t.title;
  try {
    const next = await startAutonomousJob(t, r.project.name, r.project.dir, `${detail}\n\n背景：${t.understanding ?? ""}`);
    record({ taskId: t.id, action: "retry", why: "你让它重新开工", how: "重新拉起自主 Claude Code 任务", evidence: { previousJobId: t.source.jobId ?? null }, risk: "reversible" });
    return { task: next };
  } catch (e) {
    if (e instanceof TmuxMissingError) return { error: e.message, status: 400 };
    throw e;
  }
}
