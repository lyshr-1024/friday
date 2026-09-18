import type { Task } from "@friday/shared";
import { neighbors } from "../memory/links.js";
import { projectOfUrl, urlNode } from "../memory/infer.js";
import { getTask, listTasks } from "../memory/tasks.js";
import { getJob } from "../memory/jobs.js";
import { terminalState } from "./terminal.js";

export interface SurfaceContext {
  url: string;
  /** 这个地址属于哪个项目（projects.md 的地址字段做最长前缀匹配，认不出就是 null） */
  project: string | null;
  /** 这个项目上还没收工的事，正在跑的排前面 */
  tasks: Array<{ id: string; title: string; status: string; branch?: string; jobId?: string; terminal?: string }>;
  /** 唯一能收下反馈的终端：只有一个在跑时直接给，多个或没有就是 null，由用户点 */
  jobId: string | null;
}

const OPEN = ["collected", "understood", "processing", "review", "blocked"] as const;

/**
 * 你在浏览器里看着某个页面，Friday 知道些什么。
 *
 * 这是四端里最后一端的入口：URL → 项目 → 这个项目上在办的事 → 哪个终端能收下你的反馈。
 * 你说「这个下拉框没反应」时不用再解释是哪个任务。
 */
export function surfaceContext(url: string): SurfaceContext {
  const project = projectOfUrl(url) ?? null;
  // 这个 URL 自己被关联到的任务（比如缺陷正文里贴过这个地址）优先
  const pinned = new Set(neighbors(urlNode(url), "task").map((n) => n.ref));
  const open = listTasks([...OPEN]);
  const mine = open.filter((t) => pinned.has(t.id) || (project && t.project === project));
  const rows = mine
    .map((t) => ({ t, job: t.source.jobId ? getJob(t.source.jobId) : undefined }))
    .sort((a, b) => score(b) - score(a) || Date.parse(b.t.updatedAt) - Date.parse(a.t.updatedAt))
    .slice(0, 8)
    .map(({ t, job }) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      ...(t.source.branch ? { branch: t.source.branch } : {}),
      ...(job && job.status === "running" ? { jobId: job.id, terminal: terminalState(job.id) } : {}),
    }));
  // 只有一个终端在跑才敢替你决定转给谁；多个的话让你点，点过的会记进 links
  const live = rows.filter((r) => r.jobId);
  return { url, project, tasks: rows, jobId: live.length === 1 ? live[0]!.jobId! : null };
}

/** 排序：这个页面直接关联的 > 终端在跑的 > 处理中的 */
function score({ t, job }: { t: Task; job?: { status: string } }): number {
  return (job?.status === "running" ? 4 : 0) + (t.status === "processing" ? 2 : 0) + (t.status === "review" ? 1 : 0);
}

/** 你对着某个页面说了句话：找到该收下它的终端，找不到就说清楚为什么 */
export function relayTarget(url: string, taskId?: string): { jobId: string; taskId: string } | { why: string } {
  if (taskId) {
    const t = getTask(taskId);
    const job = t?.source.jobId ? getJob(t.source.jobId) : undefined;
    if (job?.status === "running") return { jobId: job.id, taskId };
    return { why: "这条任务的终端不在跑" };
  }
  const ctx = surfaceContext(url);
  if (!ctx.project) return { why: "不认识这个地址，projects.md 里补一条「地址：」就能认出来" };
  if (!ctx.jobId) {
    const live = ctx.tasks.filter((t) => t.jobId);
    return { why: live.length ? `${ctx.project} 上有 ${live.length} 个终端在跑，指定一个` : `${ctx.project} 上没有终端在跑` };
  }
  const owner = ctx.tasks.find((t) => t.jobId === ctx.jobId)!;
  return { jobId: ctx.jobId, taskId: owner.id };
}
