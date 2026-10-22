import type { Task } from "@friday/shared";
import { record } from "../memory/audit.js";
import { clearAwaiting, getJob, isFridayInput, markNudged, runningJobs } from "../memory/jobs.js";
import { getTermSession } from "../memory/termSessions.js";
import { getTask, listTasks, updateTask } from "../memory/tasks.js";
import { state } from "../scheduler/index.js";
import { closeRun } from "./runLog.js";
import { sayToSession } from "./sessions.js";

export const NUDGE_TEXT = "继续。做完调 friday_done 交付，卡住调 friday_blocked。";

const fridayDriven = (t: Task | undefined): t is Task => Boolean(t?.source.autonomous && !t.source.headless);

/** 你在 Friday 驾驶的终端里自己打了一句：这一轮是你的，Claude 答完不交付是正常的 */
export function userPrompted(jobId: string, prompt?: string): void {
  if (!prompt || !getJob(jobId)?.awaitingDelivery) return;
  if (!isFridayInput(jobId, prompt)) clearAwaiting(jobId);
}

/** Friday 发起的一轮停了却没交付：先催一次，再停就标卡住。交互式进程不会自己退出，不催就一直挂着 */
export async function roundStopped(jobId: string): Promise<"none" | "nudged" | "blocked"> {
  const job = getJob(jobId);
  const owner = job?.taskId ? getTask(job.taskId) : undefined;
  if (!job?.awaitingDelivery || !job.sessionId || !fridayDriven(owner)) return "none";
  // 交代进需求会话的缺陷借的是需求的 job：卡住的是那几条缺陷，不是需求
  const handed = listTasks("processing").filter((t) => t.source.rootId === owner.id && t.source.handedAt && !t.source.jobId);
  // 交付过（待验收）、收工了的卡上你插一句话，Claude 答完不交付是正常的：不催也不改卡
  if (!handed.length && owner.status !== "processing") {
    clearAwaiting(jobId);
    return "none";
  }
  if (!job.nudgedAt) {
    if ((await sayToSession(job.sessionId, NUDGE_TEXT)) === "no-terminal") return "none";
    // sayToSession 会重新标「欠交付」并清掉催过的时间，必须在它之后记
    markNudged(jobId);
    record({ taskId: owner.id, action: "round_nudged", why: "这一轮停下来了，没调 friday_done 也没调 friday_blocked", how: "往终端里敲一句让它继续或交付", evidence: { jobId }, risk: "reversible" });
    return "nudged";
  }
  clearAwaiting(jobId);
  for (const t of handed.length ? handed : [owner]) {
    updateTask(t.id, { status: "blocked", progress: "停下来了没交付，看终端" });
    state.notices.push({ title: "停下来了没交付", body: t.title, taskId: t.id });
    record({ taskId: t.id, action: "round_stalled", why: "催过一次还是停下来没交付", how: "标卡住，等你看终端", evidence: { jobId }, risk: "read" });
  }
  closeRun(jobId, "no_report");
  return "blocked";
}

const START_GRACE_MS = 20 * 60_000;

/**
 * 开工好一阵了还没回报会话 id：干活段的 Claude 没起来（卡在信任目录、登录过期这类弹框上），
 * 既不会有 Stop 也不会退出，不收的话一直占着自主开工的名额。对账时跑
 */
export function stalledStarts(now = Date.now()): string[] {
  const out: string[] = [];
  for (const job of runningJobs()) {
    if (!job.awaitingDelivery || job.claudeSessionId || now - Date.parse(job.startedAt) < START_GRACE_MS) continue;
    if (!job.sessionId || getTermSession(job.sessionId)?.status === "preparing") continue;
    const owner = job.taskId ? getTask(job.taskId) : undefined;
    if (!fridayDriven(owner) || owner.status !== "processing") continue;
    clearAwaiting(job.id);
    updateTask(owner.id, { status: "blocked", progress: "Claude 没起来（开工 20 分钟没回报会话），看终端：多半卡在信任目录、登录这类弹框上" });
    closeRun(job.id, "no_report");
    state.notices.push({ title: "Claude 没起来", body: owner.title, taskId: owner.id });
    record({ taskId: owner.id, action: "round_not_started", why: "开工 20 分钟还没回报会话 id", how: "标卡住，等你看终端", evidence: { jobId: job.id }, risk: "read" });
    out.push(job.id);
  }
  return out;
}
