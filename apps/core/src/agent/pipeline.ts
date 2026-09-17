import { randomUUID } from "node:crypto";
import { closeTaskTerminal, say } from "./terminal.js";
import { addWorktree, currentBranchSync, fridayWorktree, removeWorktree } from "./git.js";
import type { Task, Thread, ThreadBrief } from "@friday/shared";
import { AUTOSTART_CATEGORY, REPLY_CATEGORY_LABEL } from "@friday/shared";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { listAudit, record, setEventStatus, setEventUndo, updateEventEvidence } from "../memory/audit.js";
import { createJob, getJob } from "../memory/jobs.js";
import { resolveProject } from "../memory/projects.js";
import { addPending, createTask, findTaskBySource, getTask, updateTask } from "../memory/tasks.js";
import { meegleIds } from "./enrich.js";
import { getThreshold } from "../memory/thresholds.js";
import { markAutoDone, setThreadStatus, threadCategory } from "../memory/threads.js";
import { userSettings } from "../settings.js";
import { decide, decideStart } from "./gate.js";
import type { HandbookDraft } from "./handbook.js";
import { autonomousPrompt, jobLog, launchClaude } from "./runner.js";
import { collectReport } from "./report.js";
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
 * 线程做完功课后进任务中枢：
 * - 一条线程一条任务（理解 = 情境，方案 = 动作）。
 * - 需要回复且有草稿 → 挂一个待审核的 slack_reply（不可逆，等用户点）。
 * - 建议动作里有 run_claude 且能定位项目 → 自动在分支上开自主 Claude Code 任务（可逆），完成后交付报告进审核。
 */
export interface ThreadDeps {
  slackPost?: (channel: string, text: string, threadTs?: string) => Promise<{ ts: string; permalink?: string }>;
}

/**
 * 任务收工时把它的 Slack 线程一并关掉。
 * 不关的话线程一直 open，对方下一条消息会接回这条老线程，
 * 带着已经处理完的旧消息重做一遍功课——用户看到的就是「处理过的又回来了」。
 */
export function closeTaskThread(task: Task, status: "done" | "ignored" = "done"): void {
  if (task.source.threadId) setThreadStatus(task.source.threadId, status);
}

export async function threadToTask(thread: Thread, brief: ThreadBrief, project?: string, deps: ThreadDeps = {}): Promise<Task> {
  // 含已收工的：同一条线程只能有一条任务。上一轮标了完成之后对方又催一句时，
  // 只找未完成的会找不到它、再建一条，同一件事就在板上出现两遍。
  let task = findTaskBySource((s) => s.threadId === thread.id, true);
  const title = `${thread.userName}：${brief.needs || brief.situation}`.slice(0, 80);
  const plan = brief.actions.map((a) => `${a.label}${a.detail ? `：${a.detail}` : ""}`).join("\n");
  if (!task) {
    task = createTask({ title, kind: "slack", source: { threadId: thread.id }, ...(project ? { project } : {}), priority: brief.urgency, understanding: brief.situation, plan, status: "understood" });
    record({ taskId: task.id, action: "task_create", why: "Slack 线程做完功课", how: "从情境卡建任务", evidence: { threadId: thread.id, situation: brief.situation }, risk: "read" });
  } else {
    // 收工过的线程又有新消息 = 这件事没完，拉回队列；用户手动忽略的不翻回来。
    const revive = task.status === "done";
    task = updateTask(task.id, { title, understanding: brief.situation, plan, priority: brief.urgency, ...(project ? { project } : {}), ...(revive ? { status: "understood" as const } : {}) })!;
    if (revive) record({ taskId: task.id, action: "task_reopen", why: "这条线程收工后对方又来消息", how: "拉回待办，不另建任务", evidence: { threadId: thread.id, situation: brief.situation }, risk: "read" });
  }

  // 消息里贴了 Meegle 工单链接就把线程接到那条工单上：聊的往往就是它，
  // 这样缺陷、需求、Slack 讨论能在一处看全。取任务板里已有的那个，没有就记 id 备查。
  const mentioned = meegleIds(thread.items.map((i) => i.text).join("\n"));
  if (mentioned.length && !task.source.linkedStoryId) {
    const hit = mentioned.map((id) => findTaskBySource((s) => s.meegleId === id, true)).find(Boolean);
    const storyId = hit?.source.meegleId ?? mentioned[0]!;
    task = updateTask(task.id, {
      source: { linkedStoryId: storyId, ...(hit?.title ? { linkedStoryName: hit.title } : {}) },
      // 顺带归项目：工单那条已经归好了就跟着它
      ...(!task.project && hit?.project ? { project: hit.project } : {}),
    })!;
  }

  const first = thread.items[0];
  const already = (task.pending ?? []).some((p) => p.type === "slack_reply");
  if (brief.needsReply && brief.reply && first && !already) {
    const category = threadCategory(thread);
    const threshold = getThreshold(category);
    const payload = { channel: first.channelId, text: brief.reply, ...(thread.kind === "mention" ? { threadTs: thread.items.at(-1)!.ts } : {}), userName: thread.userName };
    // 闸门必须在真正尝试发送之前过：同一线程自动发过一次后，即便又有新消息触发同一判断也不再重发，只排队等人看。
    const wouldAuto = decide(brief, threshold) === "auto";
    if (deps.slackPost && wouldAuto && markAutoDone(thread.id, "slack_reply_sent")) {
      const ev = record({
        taskId: task.id,
        action: "slack_reply_sent",
        why: `置信度 ${brief.confidence} 不低于 ${REPLY_CATEGORY_LABEL[category]} 的阈值 ${threshold}`,
        how: "Friday 正在自动回复，你可以撤回",
        evidence: { channel: payload.channel, text: payload.text, confidence: brief.confidence, threshold, category, auto: true },
        risk: "irreversible",
        status: "pending",
      });
      try {
        const res = await deps.slackPost(payload.channel, payload.text, payload.threadTs);
        if (!res.ts) throw new Error("Slack 没有返回消息 ts，发送结果不可信");
        setEventUndo(ev.id, { kind: "delete_slack_message", channel: payload.channel, ts: res.ts });
        setEventStatus(ev.id, "done");
        task = updateTask(task.id, { status: "done", progress: `Friday 已自动回复（置信度 ${brief.confidence} ≥ 阈值 ${threshold}）：${brief.reply}` })!;
      } catch (e) {
        updateEventEvidence(ev.id, { error: e instanceof Error ? e.message : String(e) });
        setEventStatus(ev.id, "failed");
        task = updateTask(task.id, { status: "blocked", progress: `自动回复可能已经发出，请去 Slack 核对后手动处理：${brief.reply}` })!;
      }
    } else {
      // 置信度够但闸门已经关了（这条线程自动回过一次）、没有注入发送能力、置信度本身不够，是三种不同的原因，账本要分开说，
      // 不能不管哪种都写「低于阈值」——置信度明明达标却这么说，用户点开账本会看出自相矛盾。
      const gateBlocked = Boolean(deps.slackPost) && wouldAuto;
      const noSendCapability = !deps.slackPost && wouldAuto;
      task = addPending(task.id, { type: "slack_reply", label: `回复 ${thread.userName}`, detail: brief.reply, payload })!;
      record({
        taskId: task.id,
        action: "slack_reply_prepared",
        why: gateBlocked ? "对方等回复，但这条线程已经自动回过一次" : "对方等回复",
        how: gateBlocked
          ? `置信度 ${brief.confidence} 达标，同一线程只自动回一次，这次等你确认`
          : noSendCapability
            ? `置信度 ${brief.confidence} 达标，但这轮没有发送能力，等你审核`
            : `置信度 ${brief.confidence}，低于阈值 ${threshold}，等你审核`,
        evidence: { text: brief.reply, confidence: brief.confidence, threshold, category, ...(gateBlocked ? { gateBlocked: true } : {}) },
        risk: "irreversible",
        status: "pending",
      });
    }
  }

  const wantsCode = brief.actions.some((a) => a.type === "run_claude");
  const dir = project ? resolveProject(project) : undefined;
  if (wantsCode && dir?.kind === "match" && !task.source.jobId) {
    const what = brief.actions.find((a) => a.type === "run_claude")?.detail ?? brief.needs;
    const detail = codeTaskDetail(thread, what);
    // 改代码比发一句话更重（而且项目可能判错，改的是哪个仓库得先让人看见），同一份情境卡的置信度
    // 既然拦得住回复，就也得拦得住开工。阈值表和回复共用，默认 100 = 全部等人点。
    const startThreshold = getThreshold(AUTOSTART_CATEGORY);
    const payload = { project: dir.project.name, dir: dir.project.dir, detail, confidence: brief.confidence };
    if (decideStart(brief.confidence, startThreshold) === "auto") {
      task = await startAutonomousJob(task, dir.project.name, dir.project.dir, detail);
    } else {
      // 状态不动：开工提案是「可以安排」，不是「卡住了等你」，别挤进「待我决定」
      task = addPending(task.id, { type: "start_job", label: `开工：${dir.project.name}`, detail: what, payload }, { keepStatus: true })!;
      record({
        taskId: task.id,
        action: "intake_start_pending",
        why: startThreshold >= 100 ? `开工闸门默认关着（阈值 ${startThreshold}），等你点` : `置信度 ${brief.confidence} 低于开工阈值 ${startThreshold}`,
        how: `拟在 ${dir.project.name} 上开工：${what.slice(0, 200)}`,
        evidence: payload,
        risk: "reversible",
        status: "pending",
      });
    }
  }
  return task;
}

/** 交给 Claude Code 的任务描述：Friday 的指令在外，Slack 原文只作素材。 */
export function codeTaskDetail(thread: Thread, detail: string): string {
  return `${detail}\n\n来源：${thread.userName} 在 Slack 说：\n${untrusted("slack", thread.items.map((i) => i.text).join(" / ").slice(0, 800))}`;
}

/**
 * 同一个需求下的活要走同一个终端、同一个分支。
 * 两个缺陷各起一个终端各建一个分支去改同一片代码，合起来必冲突——所以缺陷不自己开工，
 * 而是把要改的内容转达给需求那条任务已有的终端。
 *
 * 返回 true 表示已经交给需求的终端了，调用方不必再开新的。
 */
export function handOffToStory(task: Task, detail: string): boolean {
  const storyId = task.source.linkedStoryId;
  if (!storyId) return false;
  const story = findTaskBySource((s) => s.meegleId === storyId, true);
  const jobId = story?.source.jobId;
  if (!story || !jobId) return false;
  const job = getJob(jobId);
  // 终端已经退出的不算：转达进去没人看，得让它自己开
  if (!job || job.status !== "running") return false;

  const r = say(jobId, `顺带再改一条同需求下的缺陷：\n${detail}\n\n改完一并在同一个分支上交付，不要另起分支。`);
  const note = r === "queued" ? "已排队，等它这轮说完就转达" : "已转达给需求的终端";
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

/** 自主开工：在分支上改、跑测试、写报告，结束后由 job exit 回调收报告进审核。 */
export async function startAutonomousJob(task: Task, project: string, dir: string, detail: string): Promise<Task> {
  // 归在某个需求下、而那个需求已经有终端在跑：交给它，不要另起一个改同一片代码
  if (handOffToStory(task, detail)) return getTask(task.id)!;
  const dirt = await worktreeDirt(dir);
  if (dirt) {
    record({ taskId: task.id, action: "claude_code_blocked", why: "开工前体检不通过", how: dirt, evidence: { dir, project }, risk: "read", status: "failed" });
    return updateTask(task.id, { status: "blocked", progress: `没有开工：${dirt}。提交或清掉这些改动后点「重新开工」。` })!;
  }
  const id = randomUUID();
  // 在独立 worktree 里干活，不占主仓：用户可以同时在主仓改自己的东西
  const tree = fridayWorktree(dir, id);
  const failed = await addWorktree(dir, tree);
  if (failed) {
    record({ taskId: task.id, action: "claude_code_blocked", why: "开不出 worktree", how: failed, evidence: { dir, project, tree }, risk: "read", status: "failed" });
    return updateTask(task.id, { status: "blocked", progress: `没有开工：${failed}` })!;
  }
  const prompt = autonomousPrompt(id, detail, project);
  await launchClaude({ id, dir: tree, terminal: userSettings().terminal, task: prompt, autonomous: true });
  createJob({ id, project, dir: tree, task: detail.slice(0, 500), logPath: jobLog(id) });
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
  if (!job.task.source.autonomous) {
    record({ taskId: job.task.id, action: "claude_code_finish", why: "终端会话结束", how: `退出码 ${exitCode}，任务仍由用户决定是否完成`, evidence: { jobId, exitCode }, risk: "read", status: exitCode === 0 ? "done" : "failed" });
    return updateTask(job.task.id, { progress: `终端会话已结束（退出码 ${exitCode}）${job.task.progress ? `。之前：${job.task.progress.slice(0, 120)}` : ""}` })!;
  }
  const report = collectReport(jobId);
  // 分支名由终端里的 Claude 按项目规范起，这里读实际值（读不到就不挂合并动作）
  const branch = currentBranchSync(job.dir);
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
  })!;
  // 读不到分支名（不是 git 仓库、或它没建分支）就不挂合并动作，免得挂个假的
  // 合并要在主仓做，不能在 worktree 里（分支正被它检出着，merge 不了）
  const repo = task.source.repoDir || job.dir;
  if (report && branch && branch !== "main" && branch !== "master" && !(task.pending ?? []).some((p) => p.type === "git_merge")) {
    task = addPending(task.id, { type: "git_merge", label: `合并 ${branch}`, detail: `把 ${branch} 合并进主分支（不 push），合完收掉 worktree`, payload: { dir: repo, branch, worktree: task.source.worktree ?? "" } })!;
  }
  return task;
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
  closeTaskTerminal(done, "待审动作全部执行完，任务完成");
  return done;
}
