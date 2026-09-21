import { randomUUID } from "node:crypto";
import { closeTaskTerminal, say } from "./terminal.js";
import { addWorktree, currentBranchSync, fridayWorktree, removeWorktree } from "./git.js";
import type { Task } from "@friday/shared";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { listAudit, record, setEventStatus, setEventUndo, updateEventEvidence } from "../memory/audit.js";
import { createJob, getJob, setGhosttyId } from "../memory/jobs.js";
import { resolveProject } from "../memory/projects.js";
import { addPending, createTask, findTaskBySource, getTask, updateTask } from "../memory/tasks.js";
import { meegleIdsIn } from "../memory/infer.js";
import { userSettings } from "../settings.js";
import type { HandbookDraft } from "./handbook.js";
import { autonomousPrompt, jobLog, launchClaude } from "./runner.js";
import { collectReport, queryReplyDraft } from "./report.js";
import { untrusted } from "./fence.js";
import { worktreeDirt } from "./git.js";
import { existsSync, readFileSync } from "node:fs";

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
 */
export async function finishTask(id: string, status: "done" | "ignored", why: string): Promise<Task | undefined> {
  const t = updateTask(id, { status, pending: [], attention: undefined });
  if (t) {
    await closeTaskTerminal(t, why);
    await cleanupTaskWorktree(t, why);
  }
  return t;
}

/**
 * 同一个需求下的活要走同一个终端、同一个分支。
 * 两个缺陷各起一个终端各建一个分支去改同一片代码，合起来必冲突——所以缺陷不自己开工，
 * 而是把要改的内容转达给需求那条任务已有的终端。
 *
 * 返回 true 表示已经交给需求的终端了，调用方不必再开新的。
 */
export async function handOffToStory(task: Task, detail: string): Promise<boolean> {
  const storyId = task.source.linkedStoryId;
  if (!storyId) return false;
  const story = findTaskBySource((s) => s.meegleId === storyId, true);
  const jobId = story?.source.jobId;
  if (!story || !jobId) return false;
  const job = getJob(jobId);
  // 终端已经退出的不算：转达进去没人看，得让它自己开
  if (!job || job.status !== "running") return false;

  const r = await say(jobId, `顺带再改一条同需求下的缺陷：\n${detail}\n\n改完一并在同一个分支上交付，不要另起分支。`);
  if (r === "no-terminal") return false;
  const note = "已转达给需求的终端";
  updateTask(task.id, {
    status: "processing",
    progress: `${note}（和「${story.title.slice(0, 24)}」共用一个终端和分支）`,
    source: { jobId },
  });
  record({
    taskId: task.id,
    action: "handed_to_story_terminal",
    why: "同一个需求下的改动要走同一个分支，免得两个终端改同一片代码后合不上",
    how: `转达给需求任务 ${story.id.slice(0, 8)} 的终端（${r}）`,
    evidence: { storyId, jobId, detail: detail.slice(0, 300) },
    risk: "reversible",
  });
  return true;
}

/**
 * 我自己做：开一个交互式终端到项目目录，把这条任务的上下文交代给 Claude Code，然后就交给我了。
 * 和自主开工的区别只有一处——没有自主提示词、没有 guard、没有自动收尾：
 * 分支、要不要测、什么时候算完，都是我在终端里说了算，Friday 只负责开窗口和跟状态。
 * 也不开 worktree：自己做就在主仓里做，平时怎么干现在还怎么干。
 */
export async function startInteractiveJob(task: Task, project: string, dir: string, detail: string): Promise<Task> {
  const id = randomUUID();
  const { ghosttyId } = await launchClaude({ id, dir, terminal: userSettings().terminal, task: detail });
  createJob({ id, project, dir, task: detail.slice(0, 500), logPath: jobLog(id), taskId: task.id });
  if (ghosttyId) setGhosttyId(id, ghosttyId);
  record({
    taskId: task.id,
    action: "terminal_opened",
    why: "你点了「开始做」，这条需求自己动手",
    how: `在 ${dir} 开了一个交互式终端，把需求交代给 Claude Code`,
    evidence: { jobId: id, project, dir },
    risk: "reversible",
  });
  return updateTask(task.id, { status: "processing", source: { jobId: id, autonomous: false, repoDir: dir } })!;
}

/** 自主开工：在分支上改、跑测试、写报告，结束后由 job exit 回调收报告进审核。 */
export async function startAutonomousJob(task: Task, project: string, dir: string, detail: string): Promise<Task> {
  // 归在某个需求下、而那个需求已经有终端在跑：交给它，不要另起一个改同一片代码
  if (await handOffToStory(task, detail)) return getTask(task.id)!;
  const dirt = await worktreeDirt(dir);
  if (dirt) {
    record({ taskId: task.id, action: "claude_code_blocked", why: "开工前体检不通过", how: dirt, evidence: { dir, project }, risk: "read", status: "failed" });
    return updateTask(task.id, { status: "blocked", progress: `没有开工：${dirt}。提交或清掉这些改动后点「重新开工」。` })!;
  }
  const id = randomUUID();
  // 在独立 worktree 里干活，不占主仓：用户可以同时在主仓改自己的东西
  const tree = fridayWorktree(dir, id);
  // 二期在一期分支上接着开：基线任务还有分支就从那儿检出，而不是从主干拉新的
  const base = task.source.baseTaskId ? getTask(task.source.baseTaskId)?.source.branch : undefined;
  const failed = await addWorktree(dir, tree, base);
  if (failed) {
    record({ taskId: task.id, action: "claude_code_blocked", why: "开不出 worktree", how: failed, evidence: { dir, project, tree }, risk: "read", status: "failed" });
    return updateTask(task.id, { status: "blocked", progress: `没有开工：${failed}` })!;
  }
  const prompt = autonomousPrompt(id, detail, project, base);
  const { ghosttyId } = await launchClaude({ id, dir: tree, terminal: userSettings().terminal, task: prompt, autonomous: true });
  createJob({ id, project, dir: tree, task: detail.slice(0, 500), logPath: jobLog(id), taskId: task.id });
  if (ghosttyId) setGhosttyId(id, ghosttyId);
  record({
    taskId: task.id,
    action: "claude_code_start",
    why: "任务需要改代码，按策略自动在分支上完成再交审核",
    how: `在 worktree ${tree} 里跑 claude -p，按项目规范建分支，完成后写交付报告`,
    evidence: { jobId: id, project, dir, worktree: tree },
    risk: "reversible",
  });
  // task.progress 可能已经写了「Friday 已自动回复」之类的话（同一条线程既触发了回复又触发了改代码），
  // 这里是覆盖 progress 的地方，得接上而不是整句丢掉，不然工作台上那条已经发出去的回复就查无痕迹。
  const progress = [task.progress, `Claude Code 正在 ${project} 上处理`].filter(Boolean).join("\n");
  return updateTask(task.id, { status: "processing", progress, source: { ...task.source, jobId: id, autonomous: true, repoDir: dir, worktree: tree } })!;
}

/**
 * 任务收工：收掉 Friday 给它开的 worktree。
 * 目录一律删（只是个检出），分支只在已合并时删——没合并的改动可能还想捡回来，
 * 那个决定归用户，账本里写清楚分支留着了。
 */
export async function cleanupTaskWorktree(task: Task, why: string): Promise<void> {
  const tree = task.source.worktree;
  const repo = task.source.repoDir;
  if (!tree || !repo) return;
  const r = await removeWorktree(repo, tree);
  if (!r.removed) return;
  record({
    taskId: task.id,
    action: "worktree_removed",
    why,
    how: r.branchDeleted ? `收掉 worktree 并删了分支 ${r.branch}` : `收掉 worktree${r.branch ? `，${r.kept ?? "分支留着"}：${r.branch}` : ""}`,
    evidence: { worktree: tree, branch: r.branch ?? null, branchDeleted: r.branchDeleted },
    risk: "reversible",
  });
  updateTask(task.id, { source: { ...task.source, worktree: undefined } });
}

/** 终端任务退出：收交付报告，任务进审核，合并到主分支挂成待审核动作。 */
export function onJobExit(jobId: string, exitCode: number): Task | undefined {
  const job = getTaskByJob(jobId);
  if (!job) return undefined;
  if (job.task.report && job.task.status === "review") {
    record({ taskId: job.task.id, action: "claude_code_finish", why: "终端任务结束", how: `退出码 ${exitCode}，已经用 friday_done 交付过`, evidence: { jobId, exitCode }, risk: "read", status: exitCode === 0 ? "done" : "failed" });
    return job.task;
  }
  // 分支是关联的钥匙，收工时补一次实际值（终端里可能 switch 过）
  const exitBranch = currentBranchSync(job.task.source.worktree ?? job.dir) || undefined;
  if (!job.task.source.autonomous && !job.task.source.headless) {
    record({ taskId: job.task.id, action: "claude_code_finish", why: "终端会话结束", how: `退出码 ${exitCode}，任务仍由用户决定是否完成`, evidence: { jobId, exitCode }, risk: "read", status: exitCode === 0 ? "done" : "failed" });
    return updateTask(job.task.id, { progress: `终端会话已结束（退出码 ${exitCode}）${job.task.progress ? `。之前：${job.task.progress.slice(0, 120)}` : ""}`, ...(exitBranch ? { source: { branch: exitBranch } } : {}) })!;
  }
  const report = collectReport(jobId);
  // 查询任务没有分支、不该挂 git_merge，要挂 slack_reply
  const conv = job.task.source.conversation;
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
        ? `终端会话已结束（退出码 ${exitCode}）`
        : `终端任务结束（退出码 ${exitCode}），未生成交付报告${tail ? `。终端最后输出：${tail}` : ""}`,
    ...(report ? { report } : {}),
    ...(exitBranch ? { source: { branch: exitBranch } } : {}),
  })!;
  // 读不到分支名（不是 git 仓库、或它没建分支）就不挂合并动作，免得挂个假的
  // 合并要在主仓做，不能在 worktree 里（分支正被它检出着，merge 不了）
  const repo = task.source.repoDir || job.dir;
  if (report && branch && branch !== "main" && branch !== "master" && !(task.pending ?? []).some((p) => p.type === "git_merge")) {
    task = addPending(task.id, { type: "git_merge", label: `合并 ${branch}`, detail: `把 ${branch} 合并进主分支（不 push），合完收掉 worktree`, payload: { dir: repo, branch, worktree: task.source.worktree ?? "" } })!;
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
      await startAutonomousJob(t0, p.project, p.dir, p.detail);
      record({ taskId, action: "intake_start", why: "你点了开工", how: `在 ${p.project} 上自主开工`, evidence: { project: p.project, confidence: p.confidence ?? null, detail: p.detail.slice(0, 500) }, risk: "reversible", status: "approved" });
      // 开工不是收尾：任务要留在「Friday 在做」，不能跟着下面的收尾逻辑标完成、关终端
      return getTask(taskId)!;
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
      await execFileP("git", ["-C", p.dir, "merge", "--no-ff", p.branch, "-m", `merge ${p.branch} (Friday, 已审核)`]);
      // 合完再收 worktree：分支这时已经进主干，removeWorktree 的 git branch -d 才删得掉
      const cleaned = p.worktree ? await removeWorktree(p.dir, p.worktree) : undefined;
      record({
        taskId,
        action: "git_merge",
        why: "你审核通过",
        how: `git merge --no-ff ${p.branch} 到 ${base}${cleaned?.removed ? `，已收掉 worktree${cleaned.branchDeleted ? " 和分支" : ""}` : ""}`,
        evidence: { ...p, ...(cleaned ? { worktreeRemoved: cleaned.removed, branchDeleted: cleaned.branchDeleted } : {}) },
        risk: "irreversible",
        status: "approved",
      });
    } else {
      record({ taskId, action: action.type, why: "你审核通过", how: action.detail, evidence: action.payload, risk: "irreversible", status: "approved" });
    }
  } catch (e) {
    // 没发出去的动作要放回去，不然用户改好的草稿随失败一起丢了
    const cur = getTask(taskId);
    if (cur) updateTask(taskId, { pending: [...(cur.pending ?? []), action], status: "review" });
    throw e;
  }
  const t = getTask(taskId)!;
  if (t.pending?.length) return t;
  const done = updateTask(taskId, { status: "done", progress: "全部动作已执行" })!;
  await closeTaskTerminal(done, "待审动作全部执行完，任务完成");
  return done;
}
