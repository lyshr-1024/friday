import { randomUUID } from "node:crypto";
import { closeSessionTerminal, closeTaskTerminal } from "./terminal.js";
import { finishBootstrap } from "./knowledgeBootstrap.js";
import { finishBriefJob, rejectBrief, withoutApprove } from "./briefJob.js";
import { briefBasis } from "./brief.js";
import { commitsAheadSync, currentBranchSync, commitsSinceSync, isMergedSync } from "./git.js";
import type { ExternalRef, OkrWeeklyDraft, PendingAction, Task, RunRecord, RunTrigger } from "@friday/shared";
import { briefable, conversationOf, isQueryTask, workItemOf } from "@friday/shared";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { listAudit, record, setEventStatus, setEventUndo, updateEventEvidence } from "../memory/audit.js";
import { getJob } from "../memory/jobs.js";
import { resolveProject } from "../memory/projects.js";
import { addPending, findTaskBySource, getTask, listTasks, removePending, taskTag, updatePending, updateTask } from "../memory/tasks.js";
import { addMessage, conversationExists } from "../memory/conversations.js";
import "../connectors/slack/index.js";
import { chatFor, role } from "../connectors/roles.js";
import type { HandbookDraft } from "./handbook.js";
import { autonomousPrompt, storyBugPrompt } from "./runner.js";
import { baseBranchOf, claudeGone, continueRootSession, joinRootSession, openSession, resolveRoot, resumeInSession, reviveSession, runInSession, sayToSession } from "./sessions.js";
import { hasSession } from "./tmux.js";
import { kickAutostart, state } from "../scheduler/index.js";
import { getTermSession } from "../memory/termSessions.js";
import { collectReport, collectShots, queryReplyDraft } from "./report.js";
import { onSignal } from "./stage.js";
import { sessionCost } from "./transcript.js";
import { onTaskDone } from "./knowledge.js";
import { clearHanded, settleHandedBugs } from "./handedBugs.js";
import { worktreeDirt } from "./git.js";
import { existsSync } from "node:fs";
import { closeRun, closeRunForTask, fillRunCost, startRound } from "./runLog.js";
import { createRun, pendingRunsForTask, runByJob, runsForTask, setRunOutcome } from "../memory/runs.js";

const execFileP = promisify(execFile);

/**
 * 任务收工的完整动作：标状态 + 关终端 + 收 worktree。
 * `/tasks/:id/done`、`/tasks/:id/ignore`、呼出模式 mark_done 都是这同一件事，
 * 不能有两套语义——漏关终端会留下孤儿 claude 进程（2026-09-14 已经踩过一次）。
 *
 * `keepTerminal`：Meegle 节点自己走完（提测、RESOLVED、FE 发布）不代表 MR 合了，
 * 用户要的是终端留到 MR 合并、本地 worktree 清理完——那由终端里的 Claude 调 friday_finish 来收。
 */
/**
 * 收工时这次交付算什么：多数时候你是在 MR 里合的，不经 Friday 的 git_merge，
 * 所以去本地主干里找交付时的那个提交。找不到不等于没合（squash、还没 pull），记成「没确认」而不是「白干」。
 */
function settleRun(r: RunRecord, t: Task, status: "done" | "ignored", why: string): void {
  if (t.source.handedAt) return void setRunOutcome(r.id, status === "ignored" ? "abandoned" : "merged_as_is", "在需求分支上交付，由测试环境验收");
  if (status === "ignored") return void setRunOutcome(r.id, "abandoned", why);
  const repo = t.source.repoDir || getJob(r.jobId)?.dir;
  if (!r.tipSha || !repo || !isMergedSync(repo, r.tipSha)) return void setRunOutcome(r.id, "closed_unverified", why);
  const extra = r.branch ? commitsSinceSync(repo, r.tipSha, r.branch) : undefined;
  if (extra) setRunOutcome(r.id, "merged_modified", `你在分支上又提交了 ${extra} 次`);
  else setRunOutcome(r.id, "merged_as_is", extra === undefined ? "分支已不在，只确认了交付的提交进了主干" : undefined);
}

/**
 * 需求名下还没收工的缺陷。需求一收工 liveRootId 就认不出它，缺陷各自散回列表，
 * 所以你收需求时要把它们一起收（2026-10-20，用户定）。
 */
export function openDefectsOf(story: Task): Task[] {
  const own = workItemOf(story.source)?.id;
  const ids = new Set([...(own ? [own] : []), ...(story.source.mergedIds ?? [])]);
  return listTasks(["collected", "understood", "processing", "review", "blocked"], 2000).filter((t) => {
    const parent = workItemOf(t.source)?.parent?.id;
    return t.id !== story.id && (t.source.rootId === story.id || Boolean(parent && ids.has(parent)));
  });
}

/** 你收需求时名下缺陷跟着收；缺陷先收，否则关需求终端时 settleHandedBugs 会把交代进去的缺陷标成卡住 */
export async function finishDefectsOf(story: Task, status: "done" | "ignored"): Promise<number> {
  const kids = openDefectsOf(story);
  if (!kids.length) return 0;
  const why = status === "done" ? `你把所属需求「${story.title}」标了完成，名下缺陷一起收` : `你忽略了所属需求「${story.title}」，名下缺陷一起收`;
  for (const d of kids) await finishTask(d.id, status, why);
  record({ taskId: story.id, action: "story_defects_finished", why, how: `${kids.length} 条缺陷一起标${status === "done" ? "完成" : "忽略"}，要接着改的单独重新打开`, evidence: { taskIds: kids.map((d) => d.id) }, risk: "reversible" });
  return kids.length;
}

export async function finishTask(id: string, status: "done" | "ignored", why: string, { keepTerminal = false, withDefects = false } = {}): Promise<Task | undefined> {
  const before = getTask(id);
  if (before && withDefects) await finishDefectsOf(before, status);
  const t = updateTask(id, { status, pending: [], attention: undefined });
  if (before && t) onTaskDone(before, t);
  if (t) for (const r of pendingRunsForTask(id)) if (r.kind === "autonomous" || r.kind === "story_bug") settleRun(r, t, status, why);
  if (t && !keepTerminal) await closeTaskTerminal(t, why);
  return t;
}

/**
 * 重新打开收工了的任务：回到进行中（没开过工的回待办），原来记成合并 / 收下的运行改记 reopened。
 * 它自己的会话被收工关掉了但 worktree 还在，就重建会话接回原来的对话。
 * `fresh`（定时任务重开长期卡）：上一轮是真收工了，结局不改记 reopened（会污染收下率和学手册的证据）；
 * 不接回会话、回待办等开工入口写新 jobId，分支 / worktree 清掉，新一轮从主干起。
 */
export class ReopenBusyError extends Error {}

export async function reopenTask(id: string, opts: { revive?: boolean; why?: string; fresh?: boolean } = {}): Promise<{ task: Task; terminal: boolean } | undefined> {
  const t = getTask(id);
  if (!t) return undefined;
  if (t.status !== "done" && t.status !== "ignored") return { task: t, terminal: false };
  // 清掉 jobId 后那一轮退出时就找不到卡、迟到的交付还会把旧 jobId 挂回来
  if (t.source.handedAt && t.source.jobId && getJob(t.source.jobId)?.status === "running") throw new ReopenBusyError("上一轮还在需求会话里跑，等它退出再重开");
  const before = getTermSession(id);
  // 阶段拖到「已上线」会标 done 却不关终端，不关的话开工入口会接进旧 worktree
  if (opts.fresh && before && before.status !== "closed") {
    await closeTaskTerminal(t, "定时任务新一轮从主干开始");
    if (getTermSession(id)?.status !== "closed") await closeSessionTerminal(id, "定时任务新一轮从主干开始");
  }
  const tree = t.source.worktree ?? before?.worktree;
  const repo = t.source.repoDir ?? before?.repoDir;
  const was = t.source.priorWorktrees ?? [];
  const kept = was.filter((w) => existsSync(w.path));
  const prior = tree && repo && !kept.some((w) => w.path === tree) ? [...kept, { path: tree, repoDir: repo }] : kept;
  // 交给需求会话修过的缺陷：旧 jobId 是需求会话里早退了的一次 -p，回待办让门禁重新交代
  const handed = Boolean(t.source.handedAt) && !opts.fresh;
  const story = handed ? resolveRoot(t) : undefined;
  const rehand = story && story.id !== t.id && story.stage === "testing";
  const task = updateTask(id, {
    status: t.source.jobId && !opts.fresh && !handed ? "processing" : "understood",
    attention: undefined,
    releasedAt: undefined,
    ...(opts.fresh ? { source: { branch: undefined, worktree: undefined, ...(prior.length !== was.length || prior.some((w, i) => w !== was[i]) ? { priorWorktrees: prior } : {}) } } : {}),
    ...(handed ? { source: { ...clearHanded(t).source, ...(rehand ? { handBackNote: "你在 Friday 里重新打开了它" } : {}) } } : {}),
    ...(rehand ? { stage: "todo" as const } : {}),
  })!;
  if (!opts.fresh) for (const r of runsForTask(id)) if (r.outcome === "merged_as_is" || r.outcome === "merged_modified" || r.outcome === "closed_unverified" || r.outcome === "abandoned") setRunOutcome(r.id, "reopened", "你在 Friday 里重新打开");
  record({ taskId: id, action: "task_reopened", why: opts.why ?? "你重新打开了这条任务", how: `从${t.status === "done" ? "已完成" : "已忽略"}回到${task.status === "processing" ? "进行中" : "待办"}`, evidence: { from: t.status }, risk: "reversible" });
  const s = getTermSession(id);
  const terminal = Boolean(opts.revive !== false && !opts.fresh && !handed && s && s.status === "closed" && t.source.jobId && (await reviveSession(id, t.source.jobId).catch(() => false)));
  return { task: getTask(id)!, terminal };
}

/** 让 Friday 开工却没说做什么：不开空终端（你自己干活的终端在项目页） */
export const NO_TASK = "没说要做什么。想自己在项目里干活去项目页开 Claude；要 Friday 做就说做什么。";

/** 自主开工：在 worktree 里起 Friday 驾驶的交互式 Claude，做完用 friday_done 交付，中途你随时能插话。 */
export async function startAutonomousJob(task: Task, project: string, dir: string, detail: string, trigger: RunTrigger = "retry"): Promise<Task> {
  const root = resolveRoot(task);
  const exited = getTermSession(root.id)?.status === "exited";
  if (!exited && root.id !== task.id && (await joinRootSession(task, root, detail)) === "joined") return getTask(task.id)!;
  if (!exited && root.id === task.id && (await continueRootSession(task, detail))) {
    record({ taskId: task.id, action: "terminal_continued", why: "这条任务已经有会话，不再开第二个", how: "把这次的活送进原来的 tmux 会话", evidence: { project, dir }, risk: "reversible" });
    return updateTask(task.id, { status: "processing" })!;
  }
  const id = randomUUID();
  const reran = exited && (await runInSession(root.id, { id, repoDir: dir, kind: "autonomous", project, task: autonomousPrompt(id, detail, project) }, task.id));
  if (!reran) {
    const dirt = await worktreeDirt(dir);
    if (dirt) {
      record({ taskId: task.id, action: "claude_code_blocked", why: "开工前体检不通过", how: dirt, evidence: { dir, project }, risk: "read", status: "failed" });
      return updateTask(task.id, { status: "blocked", progress: `没有开工：${dirt}。提交或清掉这些改动后点「重新开工」。` })!;
    }
    const base = baseBranchOf(task).baseBranch;
    await openSession(root, task, { kind: "autonomous", project, repoDir: dir, task: autonomousPrompt(id, detail, project), jobId: id, ...(base ? { baseBranch: base } : {}) });
  }
  createRun({ id, jobId: id, taskId: task.id, project, kind: "autonomous", trigger, ...(task.source.intake?.confidence !== undefined ? { intakeConfidence: task.source.intake.confidence } : {}) });
  record({ taskId: task.id, action: "claude_code_start", why: "任务需要改代码，按策略自动在分支上完成再交审核", how: "在 tmux 会话里先按项目规则建 worktree，再跑 claude -p，完成后写交付报告", evidence: { jobId: id, project, dir }, risk: "reversible" });
  // task.progress 可能已经写了「Friday 已自动回复」之类的话（同一条线程既触发了回复又触发了改代码），
  // 这里是覆盖 progress 的地方，得接上而不是整句丢掉，不然工作台上那条已经发出去的回复就查无痕迹。
  const progress = [task.progress, `Claude Code 正在 ${project} 上处理`].filter(Boolean).join("\n");
  return updateTask(task.id, { status: "processing", progress, pending: withoutApprove(getTask(task.id)!), source: { jobId: id, autonomous: true, repoDir: dir } })!;
}

/** 终端任务退出：收交付报告，任务进审核，合并到主分支挂成待审核动作。 */
/** -1 是收尸时补的：窗口没了、没有真实退出码 */
const exitText = (code: number) => (code === -1 ? "会话已不在" : `退出码 ${code}`);

export function onJobExit(jobId: string, exitCode: number): Task | undefined {
  const job = getTaskByJob(jobId);
  if (!job) return undefined;
  if (job.task.source.knowledgeBootstrap) {
    finishBootstrap(job.task, jobId, exitCode).catch((e) => console.error("[knowledge] finishBootstrap", e));
    return undefined;
  }
  if (job.task.source.briefFor) {
    finishBriefJob(job.task, jobId, exitCode).catch((e) => console.error("[brief] finishBriefJob", e));
    return undefined;
  }
  settleHandedBugs(job.task.id, "需求会话退出了，这条没交付");
  if (job.task.report && job.task.status === "review") {
    fillRunCost(jobId);
    if (!job.task.report.screenshots.length) {
      const shots = collectShots(jobId);
      if (shots.length) {
        updateTask(job.task.id, { report: { ...job.task.report, screenshots: shots } });
      }
    }
    record({ taskId: job.task.id, action: "claude_code_finish", why: "终端任务结束", how: `退出码 ${exitCode}，已经用 friday_done 交付过`, evidence: { jobId, exitCode }, risk: "read", status: exitCode === 0 ? "done" : "failed" });
    return job.task;
  }
  // 分支是关联的钥匙，收工时补一次实际值（终端里可能 switch 过）
  const exitBranch = currentBranchSync(job.task.source.worktree ?? job.dir) || undefined;
  if (!job.task.source.autonomous && !job.task.source.headless) {
    record({ taskId: job.task.id, action: "claude_code_finish", why: "终端会话结束", how: `退出码 ${exitCode}，任务仍由用户决定是否完成`, evidence: { jobId, exitCode }, risk: "read", status: exitCode === 0 ? "done" : "failed" });
    return updateTask(job.task.id, { progress: `终端会话已结束（${exitText(exitCode)}）`, ...(exitBranch ? { source: { branch: exitBranch } } : {}) })!;
  }
  if (job.task.source.handedAt) {
    closeRun(jobId, exitCode === -1 ? "window_closed" : "no_report");
    fillRunCost(jobId);
    if (job.task.status === "done" || job.task.status === "ignored") return job.task;
    const t = updateTask(job.task.id, { status: "blocked", progress: "需求会话退出了，这条没交付" })!;
    state.notices.push({ title: "缺陷没交付", body: t.title, taskId: t.id });
    return t;
  }
  // 收工了的（Meegle 自动收工会留着终端）：Claude 之后退出或会话没了，只收尾这次运行，不改卡
  if (job.task.status === "done" || job.task.status === "ignored") {
    closeRun(jobId, exitCode === -1 ? "window_closed" : "no_report");
    fillRunCost(jobId);
    return job.task;
  }
  const report = collectReport(jobId);
  closeRun(jobId, report ? "report" : exitCode === -1 ? "window_closed" : "no_report");
  fillRunCost(jobId);
  // 查询任务没有分支、不该挂 git_merge，要挂 chat_reply
  const conv = isQueryTask(job.task.source) ? conversationOf(job.task.source) : undefined;
  if (conv) {
    const draft = report ? queryReplyDraft(report) : undefined;
    let t = updateTask(job.task.id, {
      status: report ? "review" : "blocked",
      attention: "review",
      progress: report ? "查完了，等你看" : `没查出结果（退出码 ${exitCode}）`,
      ...(report ? { report } : {}),
    })!;
    if (draft && !(t.pending ?? []).some((p) => p.type === "chat_reply")) t = addPending(t.id, chatReply(conv, draft))!;
    record({ taskId: t.id, action: "slack_query_done", why: "查询任务结束", how: report ? "已生成答案与草稿" : `退出码 ${exitCode}，没有报告`, evidence: { jobId, exitCode }, risk: "read", status: report ? "done" : "failed" });
    return t;
  }
  // 分支名由终端里的 Claude 按项目规范起，这里读实际值（读不到就不挂合并动作）
  const branch = exitBranch ?? "";
  record({
    taskId: job.task.id,
    action: "claude_code_finish",
    why: "终端任务结束",
    how: `退出码 ${exitCode}${report ? "，已收到交付报告" : "，没有找到交付报告"}`,
    evidence: { jobId, exitCode, hasReport: Boolean(report), screenshots: report?.screenshots.length ?? 0 },
    risk: "read",
    status: exitCode === 0 ? "done" : "failed",
  });
  // Friday 驾驶的 Claude 交付后不退出，走到这里就是没交付就没了（你 /exit、它崩了、会话被关）。
  // 报告文件只给升级那一刻还在跑的老 -p 任务兜底
  let task = updateTask(job.task.id, {
    status: report ? "review" : "blocked",
    progress: report ? "交付报告已生成，等你审核" : exitCode === -1 ? "会话已不在，这一轮没交付" : "Claude 退出了，这一轮没交付，看终端",
    ...(report ? { report } : {}),
    ...(exitBranch ? { source: { branch: exitBranch } } : {}),
  })!;
  // 读不到分支名（不是 git 仓库、或它没建分支）就不挂合并动作，免得挂个假的
  // 合并要在主仓做，不能在 worktree 里（分支正被它检出着，merge 不了）
  const repo = task.source.repoDir || job.dir;
  const ahead = branch ? (commitsAheadSync(task.source.worktree ?? job.dir) ?? 0) : 0;
  if (report && branch && branch !== "main" && branch !== "master" && ahead > 0 && !(task.pending ?? []).some((p) => p.type === "git_merge")) {
    task = addPending(task.id, { type: "git_merge", label: `合并 ${branch}`, detail: `把 ${branch} 合并进主分支（不 push）`, payload: { dir: repo, branch, worktree: task.source.worktree ?? "" } })!;
  }
  if (task.status === "review" || task.status === "done") reportBackToOrigin(task);
  return task;
}


/** 回到 to 那段对话的待审回复：发给谁只认 to */
export function chatReply(to: ExternalRef, text: string): Omit<PendingAction, "id"> {
  return { type: "chat_reply", label: `回复 ${to.author ?? "对方"}`, detail: text, payload: { to, text } };
}

/** 任务来源那段对话，能回才给（老库的线程引用没有频道） */
export function replyTarget(t: Task): ExternalRef | undefined {
  const to = conversationOf(t.source);
  return to && chatFor(to)?.replyable(to) ? to : undefined;
}

/**
 * 干完活回流到来源：Slack 待办派生出代码任务，任务做完了那条待办还挂着，
 * 用户既没收到「可以回复了」也不知道该关掉它。把结果写回去并备好回复草稿。
 */
export function reportBackToOrigin(done: Task): void {
  const originId = done.source.fromTaskId;
  if (!originId) return;
  const origin = getTask(originId);
  if (!origin || origin.status === "done" || origin.status === "ignored") return;

  const summary = done.report?.summary ?? done.progress ?? "已处理完";
  const line = `派出去的活已完成：${done.title}。${summary.slice(0, 300)}`;
  let next = updateTask(origin.id, {
    status: "review",
    progress: line,
    attention: "review",
  })!;

  const to = replyTarget(origin);
  if (to && !(next.pending ?? []).some((p) => p.type === "chat_reply")) next = addPending(next.id, chatReply(to, summary.slice(0, 500)))!;

  record({
    taskId: origin.id,
    action: "job_reported_back",
    why: "派出去的活做完了，来源那条还挂着",
    how: line,
    evidence: { doneTaskId: done.id, hasReply: Boolean(to) },
    risk: "reversible",
  });
}

function getTaskByJob(jobId: string): { task: Task; dir: string } | undefined {
  const ev = findTaskBySource((s) => s.jobId === jobId, true);
  // dir 要指向终端实际干活的地方：自主任务在 worktree 里，分支名得去那儿读
  if (ev) return { task: ev, dir: ev.source.worktree ?? ev.source.repoDir ?? "" };
  // 兼容：通过账本里 claude_code_start 的证据反查
  const hit = listAudit({ limit: 500 }).find((e) => e.action === "claude_code_start" && e.evidence.jobId === jobId);
  const task = hit?.taskId ? getTask(hit.taskId) : undefined;
  return task ? { task, dir: String(hit!.evidence.dir ?? "") } : undefined;
}

/** 执行一个审核通过的不可逆动作。 */
export function rejectTask(id: string, reason?: string): Task | undefined {
  const t = getTask(id);
  if (!t) return undefined;
  if (briefable(t) && t.pending?.some((p) => p.type === "brief_approve")) return rejectBrief(id, reason ?? "无说明");
  record({ taskId: t.id, action: "review_rejected", why: reason ?? "你打回了", how: "任务退回处理中，待审核动作作废", evidence: { reason: reason ?? null, dropped: (t.pending ?? []).map((p) => p.label) }, risk: "read" });
  for (const r of pendingRunsForTask(t.id)) setRunOutcome(r.id, "rejected", reason ?? "无说明");
  const updated = updateTask(t.id, { status: "processing", pending: [], progress: `被打回：${reason ?? "无说明"}`, source: { rejectedAt: new Date().toISOString() } });
  const root = t.source.handedAt && t.source.rootId ? getTask(t.source.rootId) : undefined;
  if (updated && root) {
    closeRunForTask(t.id, "report");
    void handToStorySession(updated, root, { rejected: reason ?? "无说明", trigger: "retry" })
      .then((h) => {
        if (h === "handed") return;
        const why = { busy: "打回了，但需求会话里的 Claude 正在干活，没能重交，等它这一轮交付后点「开工」", asking: "打回了，但需求终端在等你回答，没能重交，答完点「开工」", "no-session": "打回了，但需求会话已不在，没能重交，先给需求开终端" }[h];
        updateTask(t.id, { status: "blocked", progress: why });
      })
      .catch((e) => {
        const message = e instanceof Error ? e.message : String(e);
        console.warn(`[story-bug] 打回后重交失败：${message}`);
        updateTask(t.id, { status: "blocked", progress: `打回了，但重交时出错：${message}` });
      });
  }
  const jobId = t.source.jobId;
  if (updated && !root && jobId && t.source.autonomous && !t.source.headless && !t.source.handedAt) {
    void continueAfterReject(updated, jobId, reason ?? "无说明").catch((e) => {
      const message = e instanceof Error ? e.message : String(e);
      console.warn(`[reject] 打回后续跑失败：${message}`);
      updateTask(t.id, { status: "blocked", progress: `打回了，但续跑时出错：${message}` });
    });
  }
  return updated;
}

/** Friday 自己做的任务被打回：原因敲进它还开着的终端，接着做下一轮，不另起会话 */
async function continueAfterReject(t: Task, jobId: string, reason: string): Promise<void> {
  // 先记这一轮再敲：它交付得快时 friday_done 要落在这一行上，不能被当成追问后的 followup
  startRound(jobId, t.id, t.project ?? getJob(jobId)?.project ?? "", "rejected");
  if (await continueRootSession(resolveRoot(t), `上一轮被打回：${reason}。按这个改，改完再调 friday_done。`)) return;
  closeRun(jobId, "window_closed");
  updateTask(t.id, { status: "blocked", progress: "打回了，但会话已不在，点「开工」重开" });
}

/** 审核通过一条待审动作：按钮和会话里的「合并吧 / 发」走同一条路。text 是改过的要发原文 */
export async function approvePending(taskId: string, actionId: string, text?: string): Promise<Task> {
  const action = getTask(taskId)?.pending?.find((p) => p.id === actionId);
  const edited = text?.trim();
  if (edited && action) updatePending(taskId, action.id, { detail: edited, payload: { ...action.payload, text: edited } });
  const finalText = edited || action?.detail || "";
  try {
    return await executePending(taskId, actionId, finalText ? { text: finalText } : undefined);
  } catch (e) {
    record({ taskId, action: "approve_failed", why: "执行审核通过的动作失败", how: e instanceof Error ? e.message : String(e), risk: "irreversible", status: "failed" });
    throw e;
  }
}

export async function executePending(
  taskId: string,
  actionId: string,
  override?: { text?: string },
): Promise<Task> {
  const { takePending } = await import("../memory/tasks.js");
  const taken = takePending(taskId, actionId);
  if (!taken) throw new Error("待审核动作不存在");
  const { action } = taken;
  try {
    if (action.type === "chat_reply") {
      const p = action.payload as { to: ExternalRef; text: string };
      // 记账（slack_reply_sent、撤回用的 ts）由工具的 post 做
      await role("chat").post({ to: p.to, text: p.text }, { kind: "friday", why: "你审核通过", taskId, approvedPendingId: action.id });
    } else if (action.type === "start_job") {
      const p = action.payload as { project: string; dir: string; detail: string; confidence?: number };
      const t0 = getTask(taskId);
      if (!t0) throw new Error("任务不存在了");
      await startAutonomousJob(t0, p.project, p.dir, p.detail, "approve");
      record({ taskId, action: "intake_start", why: "你点了开工", how: `在 ${p.project} 上自主开工`, evidence: { project: p.project, confidence: p.confidence ?? null, detail: p.detail.slice(0, 500) }, risk: "reversible", status: "approved" });
      // 开工不是收尾：任务要留在「Friday 在做」，不能跟着下面的收尾逻辑标完成、关终端
      return getTask(taskId)!;
    } else if (action.type === "brief_approve") {
      const cur = getTask(taskId)!;
      const b = cur.source.brief;
      if (!b) return cur;
      // 只有过期的卡批准才算你认了新正文；没过期时刷指纹会把你没看到的改动一起认掉
      const t = updateTask(taskId, { progress: "理解卡你看过了，照它开工", source: { brief: { ...b, review: "approved", stale: undefined, basis: b.stale ? briefBasis(cur) : b.basis, ...(b.stale ? { project: cur.project } : {}) } } })!;
      record({ taskId, action: "brief_approved", why: "你审核通过", how: "理解卡标成已审，开工照它做", evidence: { size: b.size, rejections: b.rejections ?? 0 }, risk: "reversible", status: "approved" });
      // 审过理解卡不是收尾：需求还没开工
      kickAutostart();
      return t;
    } else if (action.type === "reproject") {
      const { rollbackAndRestart } = await import("./reproject.js");
      // 回退完直接在新项目上重开：任务回到「Friday 在做」，不走下面的收尾
      return await rollbackAndRestart(taskId, String((action.payload as { to: string }).to));
    } else if (action.type === "discard_changes") {
      const { discardClosedDefect } = await import("./reproject.js");
      return await discardClosedDefect(taskId, String((action.payload as { status?: string }).status ?? "终态"));
    } else if (action.type === "okr_submit") {
      const { submitRows, SubmitPartialError, OKR_SUBMIT_LABEL, submittable } = await import("./weekly/submit.js");
      try {
        const { draft, failed, conflicts } = await submitRows(taskId, action.payload as unknown as OkrWeeklyDraft, action.id);
        // 部分失败不抛：抛了会把旧 payload 放回去，已经交成功的会被当成没交再交一遍。
        // 预查发现平台上已经有用户自己填的也不收工：卡片要留着让用户看到那几条没交上去
        if (failed || conflicts) {
          const cur = getTask(taskId)!;
          const label = failed ? `重试剩下的 ${failed} 条` : OKR_SUBMIT_LABEL(submittable(draft));
          return updateTask(taskId, { status: "review", pending: [...(cur.pending ?? []), { ...action, label, payload: draft as unknown as Record<string, unknown> }] })!;
        }
      } catch (e) {
        // 记账失败不能落到下面的通用 catch：那里放回去的是没更新过的旧 payload，已经交成功的行会被当成没交，重试再交一次
        if (e instanceof SubmitPartialError) {
          const cur = getTask(taskId)!;
          updateTask(taskId, { status: "review", pending: [...(cur.pending ?? []), { ...action, payload: e.draft as unknown as Record<string, unknown> }] });
        }
        throw e;
      }
    } else if (action.type === "handbook_apply") {
      const { applyHandbookDraft, pickDraft, pickedCount } = await import("./handbook.js");
      const p = action.payload as { draft: HandbookDraft; cursor?: string; skip?: string[] };
      const picked = pickDraft(p.draft, p.skip ?? []);
      if (!pickedCount(picked)) throw new Error("一条都没勾：要写进手册的勾上，整批都不要就点「这批不要」");
      const { snapshot, wrote } = applyHandbookDraft(picked);
      const skipped = pickedCount(p.draft) - pickedCount(picked);
      record({
        taskId,
        action: "handbook_applied",
        why: "你审核通过",
        how: `写了 ${wrote.join("、")}${skipped ? `；你勾掉了 ${skipped} 条` : ""}`,
        evidence: { wrote, groups: p.draft.groups.map((g) => g.project), skipped },
        risk: "reversible",
        status: "approved",
        undo: { kind: "restore_memory", snapshot },
      });
    } else if (action.type === "tool_call") {
      const { invokeTool } = await import("../connectors/invoke.js");
      const p = action.payload as { tool: string; op: string; args: Record<string, unknown> };
      const r = await invokeTool({ kind: "friday", why: "你审核通过", taskId, approvedPendingId: action.id }, p.tool, p.op, p.args);
      if (r.kind !== "ok") throw new Error(r.kind === "refused" ? r.why : `${p.tool}.${p.op} 没执行：${r.kind}`);
      const out = r.text.slice(0, 2000);
      tellRequester(taskId, action.payload, `用户批了，${p.tool}.${p.op} 已执行：${out}`, `批了，${p.tool}.${p.op} 已执行：\n${out}`);
      // 模型在干活中途要的一次调用，批了不等于任务收工
      return getTask(taskId)!;
    } else if (action.type === "git_merge") {
      const p = action.payload as { dir: string; branch: string; worktree?: string };
      const base = (await execFileP("git", ["-C", p.dir, "branch", "--show-current"])).stdout.trim() || "main";
      // 合并前先比：分支头还是不是交付时那个提交。你在上面又改过，说明这次交付没被原样收下
      const jobId = getTask(taskId)?.source.jobId;
      const run = jobId ? runByJob(jobId) : undefined;
      const extra = run?.tipSha ? commitsSinceSync(p.dir, run.tipSha, p.branch) : undefined;
      await execFileP("git", ["-C", p.dir, "merge", "--no-ff", p.branch, "-m", `merge ${p.branch} (Friday, 已审核)`]);
      if (run) {
        const why = !run.tipSha ? "交付时没记下提交，无法比对" : extra === undefined ? "分支被改写，无法比对" : extra ? `你在分支上又提交了 ${extra} 次` : undefined;
        setRunOutcome(run.id, extra === 0 ? "merged_as_is" : "merged_modified", why);
      }
      record({
        taskId,
        action: "git_merge",
        why: "你审核通过",
        how: `git merge --no-ff ${p.branch} 到 ${base}`,
        evidence: p,
        risk: "irreversible",
        status: "approved",
      });
    } else {
      record({ taskId, action: action.type, why: "你审核通过", how: action.detail, evidence: action.payload, risk: "irreversible", status: "approved" });
    }
  } catch (e) {
    // 没发出去的动作要放回去，不然用户改好的草稿随失败一起丢了；
    // 有些分支（比如 okr_submit）失败前已经把更新过的动作放回去了，这里不重复放一遍旧的
    const cur = getTask(taskId);
    if (cur && !(cur.pending ?? []).some((p) => p.id === action.id)) {
      // tool_call 是干活中途挂的，执行失败不能把在跑的任务翻成待审、提前让出并发名额
      updateTask(taskId, { pending: [...(cur.pending ?? []), action], ...(action.type === "tool_call" ? {} : { status: "review" as const }) });
    }
    throw e;
  }
  const t = getTask(taskId)!;
  if (t.pending?.length) return t;
  const done = updateTask(taskId, { status: "done", progress: "全部动作已执行" })!;
  onTaskDone(t, done);
  await closeTaskTerminal(done, "待审动作全部执行完，任务完成");
  return done;
}

/** 待审的 tool_call 有了结果：告诉当初要它的终端（jobId）和主对话（conversationId） */
function tellRequester(taskId: string, payload: Record<string, unknown>, toTerminal: string, toConversation: string): void {
  const jobId = typeof payload.jobId === "string" ? payload.jobId : undefined;
  const sessionId = jobId ? getJob(jobId)?.sessionId : undefined;
  if (sessionId) void sayToSession(sessionId, toTerminal).catch((e) => console.warn(`[tool_call] 结果没敲进终端：${e instanceof Error ? e.message : String(e)}`));
  const conv = typeof payload.conversationId === "string" ? payload.conversationId : undefined;
  if (conv && conversationExists(conv)) {
    const t = getTask(taskId);
    addMessage(conv, { role: "assistant", kind: "run", content: `→ ${t ? taskTag(t) : taskId.slice(0, 8)}：${toConversation}`, taskIds: [taskId] });
  }
}

/** 你没批一条挂着的 tool_call：只撤这一条，任务状态和运行结局都不动（不是打回） */
export function dismissToolCall(taskId: string, actionId: string, why = "你没批"): Task | { error: string; status: 400 | 404 } {
  const t = getTask(taskId);
  const action = t?.pending?.find((p) => p.id === actionId);
  if (!t || !action) return { error: "待审核动作不存在", status: 404 };
  if (action.type !== "tool_call") return { error: "只有外部工具调用能「不执行」", status: 400 };
  const p = action.payload as { tool: string; op: string; args: Record<string, unknown> };
  const updated = removePending(taskId, actionId) ?? t;
  record({ taskId, action: "tool_call_dismissed", why, how: `撤掉待审：执行 ${p.tool}.${p.op}，不执行`, evidence: { tool: p.tool, op: p.op, args: p.args }, risk: "read" });
  tellRequester(taskId, action.payload, `用户没批 ${p.tool}.${p.op}，换个做法或在交付里写明`, `没批 ${p.tool}.${p.op}，不执行`);
  return updated;
}

/** 需求在测试中：缺陷交代进需求自己的会话，Claude 空闲就敲进去、在干活就等，退出了就在需求自己的 Claude 会话上接回 */
export async function handToStorySession(task: Task, root: Task, opts: { rejected?: string; trigger?: RunTrigger } = {}): Promise<"handed" | "busy" | "asking" | "no-session"> {
  const trigger = opts.trigger ?? "autostart";
  const gone = (why: string) => {
    record({ taskId: task.id, action: "story_session_gone", why, how: "这条缺陷没交代出去，卡片不动", evidence: { rootId: root.id }, risk: "read" });
    return "no-session" as const;
  };
  const s = getTermSession(root.id);
  if (!s || s.status === "closed" || !s.worktree || !(await hasSession(s.tmuxName))) return gone(`需求「${root.title.slice(0, 24)}」的会话已不在`);
  const project = s.project;
  const prompt = storyBugPrompt(task, root, project, opts.rejected ?? task.source.handBackNote);
  const alive = s.status === "running" && !(await claudeGone(s));
  // 敲字带回车，会替你选中弹窗里高亮的那个选项
  if (alive && root.attention === "question") {
    console.log(`[story-bug] ${task.title.slice(0, 40)}：需求终端在等你回答，不往里敲`);
    return "asking";
  }
  // 在一轮里就等它交付：敲进去它也只是排队，交付归属会乱
  if (alive && s.lastInputAt && (!s.lastStopAt || s.lastInputAt > s.lastStopAt)) {
    console.log(`[story-bug] ${task.title.slice(0, 40)}：需求会话里的 Claude 正在干活，等这一轮交付`);
    return "busy";
  }
  const job = s.jobId ? getJob(s.jobId) : undefined;
  // 缺陷这一轮的成本从此刻需求会话的累计起算
  const costBase = sessionCost(s.worktree, job?.claudeSessionId)?.costUsd;
  if (alive) {
    if ((await sayToSession(root.id, prompt)) === "no-terminal") return gone("需求会话里敲不进去");
  } else {
    // 你自己开的需求会话接回来是交互式：不带模型（继承你的默认）、不挂守卫，不能在里面无人值守地跑
    if (!root.source.autonomous) return gone("需求会话是你自己开的、Claude 已退出：先在需求终端里接回，Friday 不在你的会话里无人值守地跑");
    if (!(await resumeInSession(root.id, prompt))) return gone("需求会话里接不回 Claude");
  }
  const run = { id: randomUUID(), jobId: `${s.jobId}#${task.id.slice(0, 8)}` };
  updateTask(task.id, {
    status: "processing",
    attention: undefined,
    pending: withoutApprove(task),
    progress: `在需求「${root.title.slice(0, 24)}」的会话里修`,
    source: { rootId: root.id, autonomous: true, handedAt: new Date().toISOString(), handBackNote: undefined, repoDir: s.repoDir, worktree: s.worktree, ...(s.branch ? { branch: s.branch } : {}), jobId: undefined },
  });
  createRun({ ...run, taskId: task.id, project, kind: "story_bug", trigger, ...(costBase !== undefined ? { costBase } : {}) });
  record({
    taskId: task.id,
    action: trigger === "autostart" ? "autostart" : "retry",
    why: trigger === "autostart" ? `需求「${root.title.slice(0, 24)}」在测试中，缺陷直接在它的分支上修` : opts.rejected ? "打回后重交" : "你让它重新开工",
    how: alive ? "敲进需求的会话" : "在需求的会话上接回 Claude 再交代",
    evidence: { rootId: root.id, workItemId: workItemOf(task.source)?.id ?? null, mode: alive ? "say" : "resume" },
    risk: "reversible",
  });
  if (trigger === "autostart") state.notices.push({ title: `Friday 接手了一条缺陷 · ${project}`, body: task.title.slice(0, 120), taskId: task.id });
  return "handed";
}
