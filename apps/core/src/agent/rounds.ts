import type { Task } from "@friday/shared";
import { record } from "../memory/audit.js";
import { clearAwaiting, getJob, isFridayInput, markNudged } from "../memory/jobs.js";
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
  if (!job.nudgedAt) {
    if ((await sayToSession(job.sessionId, NUDGE_TEXT)) === "no-terminal") return "none";
    // sayToSession 会重新标「欠交付」并清掉催过的时间，必须在它之后记
    markNudged(jobId);
    record({ taskId: owner.id, action: "round_nudged", why: "这一轮停下来了，没调 friday_done 也没调 friday_blocked", how: "往终端里敲一句让它继续或交付", evidence: { jobId }, risk: "reversible" });
    return "nudged";
  }
  clearAwaiting(jobId);
  // 交代进需求会话的缺陷借的是需求的 job：卡住的是那几条缺陷，不是需求
  const handed = listTasks("processing").filter((t) => t.source.rootId === owner.id && t.source.handedAt && !t.source.jobId);
  for (const t of handed.length ? handed : [owner]) {
    updateTask(t.id, { status: "blocked", progress: "停下来了没交付，看终端" });
    state.notices.push({ title: "停下来了没交付", body: t.title, taskId: t.id });
    record({ taskId: t.id, action: "round_stalled", why: "催过一次还是停下来没交付", how: "标卡住，等你看终端", evidence: { jobId }, risk: "read" });
  }
  closeRun(jobId, "no_report");
  return "blocked";
}
