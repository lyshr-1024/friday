import { randomUUID } from "node:crypto";
import { closeTaskTerminal } from "./terminal.js";
import { currentBranchSync, commitsSinceSync, isMergedSync } from "./git.js";
import type { OkrWeeklyDraft, Task, RunRecord, RunTrigger } from "@friday/shared";
import { isQueryTask } from "@friday/shared";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { listAudit, record, setEventStatus, setEventUndo, updateEventEvidence } from "../memory/audit.js";
import { getJob } from "../memory/jobs.js";
import { resolveProject } from "../memory/projects.js";
import { addPending, findTaskBySource, getTask, updatePending, updateTask } from "../memory/tasks.js";
import { loadSlackCreds, postMessage, slackCaller } from "../connectors/slack.js";
import type { HandbookDraft } from "./handbook.js";
import { autonomousPrompt, jobLog } from "./runner.js";
import { baseBranchOf, continueRootSession, joinRootSession, openSession, resolveRoot } from "./sessions.js";
import { collectReport, queryReplyDraft } from "./report.js";
import { onSignal } from "./stage.js";
import { worktreeDirt } from "./git.js";
import { existsSync, readFileSync } from "node:fs";
import { closeRun, fillRunCost } from "./runLog.js";
import { createRun, pendingRunsForTask, runByJob, setRunOutcome } from "../memory/runs.js";

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Za-z0-9]|[\x00-\x08\x0b-\x1f]/g;

/** 终端日志最后几百字（去掉控制字符），用来解释任务为什么没交付。 */
export function logTail(jobId: string, chars = 300): string {
  const p = jobLog(jobId);
  if (!existsSync(p)) return "";
  const raw = readFileSync(p, "latin1").replace(ANSI, "");
  return Buffer.from(raw, "latin1").toString("utf8").replace(/\s+/g, " ").trim().slice(-chars);
}

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
  if (status === "ignored") return void setRunOutcome(r.id, "abandoned", why);
  const repo = t.source.repoDir || getJob(r.jobId)?.dir;
  if (!r.tipSha || !repo || !isMergedSync(repo, r.tipSha)) return void setRunOutcome(r.id, "closed_unverified", why);
  const extra = r.branch ? commitsSinceSync(repo, r.tipSha, r.branch) : undefined;
  if (extra) setRunOutcome(r.id, "merged_modified", `你在分支上又提交了 ${extra} 次`);
  else setRunOutcome(r.id, "merged_as_is", extra === undefined ? "分支已不在，只确认了交付的提交进了主干" : undefined);
}

export async function finishTask(id: string, status: "done" | "ignored", why: string, { keepTerminal = false } = {}): Promise<Task | undefined> {
  const t = updateTask(id, { status, pending: [], attention: undefined });
  if (t) for (const r of pendingRunsForTask(id)) if (r.kind === "autonomous") settleRun(r, t, status, why);
  if (t && !keepTerminal) await closeTaskTerminal(t, why);
  return t;
}

/**
 * 我自己做：在 tmux 会话里起交互式 Claude Code，准备段先按项目规则建好 worktree，再把这条任务的上下文交代给它。
 * 和自主开工的区别只有一处——没有自主提示词、没有 guard、没有自动收尾：
 * 分支、要不要测、什么时候算完，都是我在终端里说了算，Friday 只负责开会话和跟状态。
 */
export async function startInteractiveJob(task: Task, project: string, dir: string, detail: string, conversationId?: string): Promise<Task> {
  const root = resolveRoot(task);
  if (root.id !== task.id) {
    if ((await joinRootSession(task, root, detail)) === "joined") return getTask(task.id)!;
    if (!root.project) updateTask(root.id, { project });
    if (await continueRootSession(root, `我要开始做这条需求：${root.title}\n\n先做名下这条缺陷：\n${detail}`)) return updateTask(task.id, { status: "processing", progress: `在需求「${root.title.slice(0, 24)}」的会话里改`, source: { rootId: root.id } })!;
    const jobId = await openSession(root, root, { kind: "interactive", project, repoDir: dir, task: `我要开始做这条需求：${root.title}\n\n先做名下这条缺陷：\n${detail}`, ...baseBranchOf(root) });
    updateTask(root.id, { status: "processing", source: { jobId, autonomous: false, repoDir: dir } });
    record({ taskId: root.id, action: "terminal_opened", why: "你点了名下缺陷的「开始做」，需求还没有会话", how: "在 tmux 会话里起交互式 Claude Code，先按项目规则建 worktree", evidence: { jobId, project, dir }, risk: "reversible" });
    return updateTask(task.id, { status: "processing", progress: `在需求「${root.title.slice(0, 24)}」的会话里改`, source: { rootId: root.id } })!;
  }
  if (await continueRootSession(task, detail)) {
    record({ taskId: task.id, action: "terminal_continued", why: "这条任务已经有会话，不再开第二个", how: "把这次的话送进原来的 tmux 会话", evidence: { project, dir }, risk: "reversible" });
    return updateTask(task.id, { status: "processing" })!;
  }
  const jobId = await openSession(task, task, { kind: "interactive", project, repoDir: dir, task: detail, ...(conversationId ? { conversationId } : {}), ...baseBranchOf(task) });
  record({ taskId: task.id, action: "terminal_opened", why: "你点了「开始做」，这条需求自己动手", how: "在 tmux 会话里起交互式 Claude Code，先按项目规则建 worktree", evidence: { jobId, project, dir }, risk: "reversible" });
  return updateTask(task.id, { status: "processing", source: { jobId, autonomous: false, repoDir: dir } })!;
}

/** 自主开工：在分支上改、跑测试、写报告，结束后由 job exit 回调收报告进审核。 */
export async function startAutonomousJob(task: Task, project: string, dir: string, detail: string, trigger: RunTrigger = "retry"): Promise<Task> {
  const root = resolveRoot(task);
  if (root.id !== task.id && (await joinRootSession(task, root, detail)) === "joined") return getTask(task.id)!;
  if (root.id === task.id && (await continueRootSession(task, detail))) {
    record({ taskId: task.id, action: "terminal_continued", why: "这条任务已经有会话，不再开第二个", how: "把这次的活送进原来的 tmux 会话", evidence: { project, dir }, risk: "reversible" });
    return updateTask(task.id, { status: "processing" })!;
  }
  const dirt = await worktreeDirt(dir);
  if (dirt) {
    record({ taskId: task.id, action: "claude_code_blocked", why: "开工前体检不通过", how: dirt, evidence: { dir, project }, risk: "read", status: "failed" });
    return updateTask(task.id, { status: "blocked", progress: `没有开工：${dirt}。提交或清掉这些改动后点「重新开工」。` })!;
  }
  const id = randomUUID();
  const base = baseBranchOf(task).baseBranch;
  await openSession(root, task, { kind: "autonomous", project, repoDir: dir, task: autonomousPrompt(id, detail, project), jobId: id, ...(base ? { baseBranch: base } : {}) });
  createRun({ id, jobId: id, taskId: task.id, project, kind: "autonomous", trigger, ...(task.source.intake?.confidence !== undefined ? { intakeConfidence: task.source.intake.confidence } : {}) });
  record({ taskId: task.id, action: "claude_code_start", why: "任务需要改代码，按策略自动在分支上完成再交审核", how: "在 tmux 会话里先按项目规则建 worktree，再跑 claude -p，完成后写交付报告", evidence: { jobId: id, project, dir }, risk: "reversible" });
  // task.progress 可能已经写了「Friday 已自动回复」之类的话（同一条线程既触发了回复又触发了改代码），
  // 这里是覆盖 progress 的地方，得接上而不是整句丢掉，不然工作台上那条已经发出去的回复就查无痕迹。
  const progress = [task.progress, `Claude Code 正在 ${project} 上处理`].filter(Boolean).join("\n");
  return updateTask(task.id, { status: "processing", progress, source: { jobId: id, autonomous: true, repoDir: dir } })!;
}

/** 终端任务退出：收交付报告，任务进审核，合并到主分支挂成待审核动作。 */
/** -1 是收尸时补的：窗口没了、没有真实退出码 */
const exitText = (code: number) => (code === -1 ? "会话已不在" : `退出码 ${code}`);

export function onJobExit(jobId: string, exitCode: number): Task | undefined {
  const job = getTaskByJob(jobId);
  if (!job) return undefined;
  if (job.task.report && job.task.status === "review") {
    fillRunCost(jobId);
    record({ taskId: job.task.id, action: "claude_code_finish", why: "终端任务结束", how: `退出码 ${exitCode}，已经用 friday_done 交付过`, evidence: { jobId, exitCode }, risk: "read", status: exitCode === 0 ? "done" : "failed" });
    return job.task;
  }
  // 分支是关联的钥匙，收工时补一次实际值（终端里可能 switch 过）
  const exitBranch = currentBranchSync(job.task.source.worktree ?? job.dir) || undefined;
  if (!job.task.source.autonomous && !job.task.source.headless) {
    record({ taskId: job.task.id, action: "claude_code_finish", why: "终端会话结束", how: `退出码 ${exitCode}，任务仍由用户决定是否完成`, evidence: { jobId, exitCode }, risk: "read", status: exitCode === 0 ? "done" : "failed" });
    return updateTask(job.task.id, { progress: `终端会话已结束（${exitText(exitCode)}）`, ...(exitBranch ? { source: { branch: exitBranch } } : {}) })!;
  }
  const report = collectReport(jobId);
  closeRun(jobId, report ? "report" : exitCode === -1 ? "window_closed" : "no_report");
  fillRunCost(jobId);
  // 查询任务没有分支、不该挂 git_merge，要挂 slack_reply
  const conv = isQueryTask(job.task.source) ? job.task.source.conversation : undefined;
  if (conv) {
    const draft = report ? queryReplyDraft(report) : undefined;
    let t = updateTask(job.task.id, {
      status: report ? "review" : "blocked",
      attention: "review",
      progress: report ? "查完了，等你看" : `没查出结果（退出码 ${exitCode}）`,
      ...(report ? { report } : {}),
    })!;
    if (draft && !(t.pending ?? []).some((p) => p.type === "slack_reply")) {
      t = addPending(t.id, {
        type: "slack_reply",
        label: `回复 ${job.task.source.userName ?? "对方"}`,
        detail: draft,
        payload: {
          channel: job.task.source.channelId ?? "",
          text: draft,
          ...(job.task.source.threadTs ? { threadTs: job.task.source.threadTs } : {}),
          ...(job.task.source.userName ? { userName: job.task.source.userName } : {}),
        },
      })!;
    }
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
  // 自主任务必须有交付报告才算交付；交互式会话（你自己在终端里聊的）退出即完成。
  const interactive = !job.task.plan && !report;
  const tail = !report && exitCode !== 0 ? logTail(jobId) : "";
  let task = updateTask(job.task.id, {
    status: report ? "review" : interactive && exitCode === 0 ? "done" : exitCode === 0 ? "review" : "blocked",
    progress: report
      ? "交付报告已生成，等你审核"
      : interactive
        ? `终端会话已结束（${exitText(exitCode)}）`
        : `终端任务结束（${exitText(exitCode)}），未生成交付报告${tail ? `。终端最后输出：${tail}` : ""}`,
    ...(report ? { report } : {}),
    ...(exitBranch ? { source: { branch: exitBranch } } : {}),
  })!;
  // 读不到分支名（不是 git 仓库、或它没建分支）就不挂合并动作，免得挂个假的
  // 合并要在主仓做，不能在 worktree 里（分支正被它检出着，merge 不了）
  const repo = task.source.repoDir || job.dir;
  if (report && branch && branch !== "main" && branch !== "master" && !(task.pending ?? []).some((p) => p.type === "git_merge")) {
    task = addPending(task.id, { type: "git_merge", label: `合并 ${branch}`, detail: `把 ${branch} 合并进主分支（不 push）`, payload: { dir: repo, branch, worktree: task.source.worktree ?? "" } })!;
  }
  if (task.status === "review" || task.status === "done") reportBackToOrigin(task);
  return task;
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

  const channel = origin.source.channelId;
  const already = (next.pending ?? []).some((p) => p.type === "slack_reply");
  if (origin.source.conversation && channel && !already) {
    const reply = `${summary.slice(0, 500)}`;
    next = addPending(next.id, {
      type: "slack_reply",
      label: `回复 ${origin.source.userName ?? "对方"}`,
      detail: reply,
      payload: {
        channel,
        text: reply,
        ...(origin.source.threadTs ? { threadTs: origin.source.threadTs } : {}),
        ...(origin.source.userName ? { userName: origin.source.userName } : {}),
      },
    })!;
  }

  record({
    taskId: origin.id,
    action: "job_reported_back",
    why: "派出去的活做完了，来源那条还挂着",
    how: line,
    evidence: { doneTaskId: done.id, hasReply: Boolean(origin.source.conversation && channel) },
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
  record({ taskId: t.id, action: "review_rejected", why: reason ?? "你打回了", how: "任务退回处理中，待审核动作作废", evidence: { reason: reason ?? null, dropped: (t.pending ?? []).map((p) => p.label) }, risk: "read" });
  for (const r of pendingRunsForTask(t.id)) setRunOutcome(r.id, "rejected", reason ?? "无说明");
  return updateTask(t.id, { status: "processing", pending: [], progress: `被打回：${reason ?? "无说明"}` });
}

/** 审核通过一条待审动作：按钮和会话里的「合并吧 / 发」走同一条路。text 是改过的要发原文 */
export async function approvePending(taskId: string, actionId: string, text?: string): Promise<Task> {
  const action = getTask(taskId)?.pending?.find((p) => p.id === actionId);
  const edited = text?.trim();
  if (edited && action) updatePending(taskId, action.id, { detail: edited, payload: { ...action.payload, text: edited } });
  const finalText = edited || action?.detail || "";
  const creds = await loadSlackCreds();
  const call = creds ? slackCaller(creds) : undefined;
  try {
    return await executePending(
      taskId,
      actionId,
      {
        slackPost: async (channel, body, threadTs) => {
          if (!call) throw new Error("Slack 未接入");
          return postMessage(call, channel, body, threadTs);
        },
      },
      finalText ? { text: finalText } : undefined,
    );
  } catch (e) {
    record({ taskId, action: "approve_failed", why: "执行审核通过的动作失败", how: e instanceof Error ? e.message : String(e), risk: "irreversible", status: "failed" });
    throw e;
  }
}

export async function executePending(
  taskId: string,
  actionId: string,
  deps: { slackPost: (channel: string, text: string, threadTs?: string) => Promise<{ ts: string; permalink?: string }> },
  override?: { text?: string },
): Promise<Task> {
  const { takePending } = await import("../memory/tasks.js");
  const taken = takePending(taskId, actionId);
  if (!taken) throw new Error("待审核动作不存在");
  const { action } = taken;
  try {
    if (action.type === "slack_reply") {
      const p = action.payload as { channel: string; text: string; threadTs?: string; userName?: string };
      const res = await deps.slackPost(p.channel, p.text, p.threadTs);
      // 没有 ts 就没法撤回，也说明发送结果不可信，不能记成已发出
      if (!res.ts) throw new Error("Slack 没有返回消息 ts，发送结果不可信");
      record({
        taskId,
        action: "slack_reply_sent",
        why: "你审核通过",
        how: "chat.postMessage",
        evidence: { channel: p.channel, text: p.text, ts: res.ts, permalink: res.permalink ?? null },
        risk: "irreversible",
        status: "approved",
        undo: { kind: "delete_slack_message", channel: p.channel, ts: res.ts },
      });
    } else if (action.type === "start_job") {
      const p = action.payload as { project: string; dir: string; detail: string; confidence?: number };
      const t0 = getTask(taskId);
      if (!t0) throw new Error("任务不存在了");
      await startAutonomousJob(t0, p.project, p.dir, p.detail, "approve");
      record({ taskId, action: "intake_start", why: "你点了开工", how: `在 ${p.project} 上自主开工`, evidence: { project: p.project, confidence: p.confidence ?? null, detail: p.detail.slice(0, 500) }, risk: "reversible", status: "approved" });
      // 开工不是收尾：任务要留在「Friday 在做」，不能跟着下面的收尾逻辑标完成、关终端
      return getTask(taskId)!;
    } else if (action.type === "okr_submit") {
      const { submitRows, SubmitPartialError, OKR_SUBMIT_LABEL, submittable } = await import("./weekly/submit.js");
      try {
        const { draft, failed, conflicts } = await submitRows(taskId, action.payload as unknown as OkrWeeklyDraft);
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
      const { applyHandbookDraft } = await import("./handbook.js");
      const p = action.payload as { draft: HandbookDraft; cursor?: string };
      const { snapshot, wrote } = applyHandbookDraft(p.draft);
      record({
        taskId,
        action: "handbook_applied",
        why: "你审核通过",
        how: `写了 ${wrote.join("、")}`,
        evidence: { wrote, groups: p.draft.groups.map((g) => g.project) },
        risk: "reversible",
        status: "approved",
        undo: { kind: "restore_memory", snapshot },
      });
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
      updateTask(taskId, { pending: [...(cur.pending ?? []), action], status: "review" });
    }
    throw e;
  }
  const t = getTask(taskId)!;
  if (t.pending?.length) return t;
  const done = updateTask(taskId, { status: "done", progress: "全部动作已执行" })!;
  await closeTaskTerminal(done, "待审动作全部执行完，任务完成");
  return done;
}
