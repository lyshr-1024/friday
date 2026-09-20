import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DeliveryReport, Job, Task } from "@friday/shared";
import { record } from "../memory/audit.js";
import { lessonFromRelay } from "./lessons.js";
import { addMessage, conversationExists } from "../memory/conversations.js";
import { getJob, setJobMessage } from "../memory/jobs.js";
import { loadProjects } from "../memory/projects.js";
import { addPending, createTask, findTaskBySource, getTask, updateTask } from "../memory/tasks.js";
import { listThreads } from "../memory/threads.js";
import { state } from "../scheduler/index.js";
import { personNote } from "./enrich.js";
import { readResearchNote } from "../memory/research.js";
import { say, closeJobTerminal } from "./terminal.js";
import { currentBranchSync } from "./git.js";

const execFileP = promisify(execFile);

/** 终端里的 Claude Code 通过 MCP 调回 Friday 的工具。按 jobId 绑到任务，不需要它自己知道任务 id。 */
export interface BridgeTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const str = (description: string) => ({ type: "string", description });
const list = (description: string) => ({ type: "array", items: { type: "string" }, description });

export const BRIDGE_TOOLS: BridgeTool[] = [
  {
    name: "friday_context",
    description: "拿这条任务的背景：交代的原话、Slack 原文、关联工单、项目与人物、等用户点头的动作。都是 Friday 收集的事实，不含技术方案——改哪里怎么改由你看代码定。开工前先调一次。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "friday_progress",
    description: "报一句阶段进展（不超过 200 字），用户在 Friday 的任务卡上实时看到。每完成一个阶段调一次，不要每步都调。起好分支后第一次调用要带上 branch。",
    inputSchema: { type: "object", properties: { text: str("一句话进展"), branch: str("当前分支名，起好或切换后报一次") }, required: ["text"] },
  },
  {
    name: "friday_done",
    description: "任务做完了，交付给用户验收。这是用户收到验收提醒的唯一途径，做完必须调。",
    inputSchema: {
      type: "object",
      properties: {
        summary: str("一句话说做了什么"),
        changes: list("每个文件一条：路径 — 改了什么"),
        testSteps: list("每一步一条：跑了什么命令 / 做了什么操作 → 结果"),
        testResult: str("一句话：全部通过 / 哪些没过"),
        verify: list("用户应该亲自确认的点，写清楚打开哪里看什么"),
      },
      required: ["summary", "testResult"],
    },
  },
  {
    name: "friday_blocked",
    description: "卡住了，需要用户介入才能继续（缺权限、需求不清、环境问题）。说明原因和需要用户做什么。",
    inputSchema: { type: "object", properties: { reason: str("卡在哪、需要用户做什么") }, required: ["reason"] },
  },
];

function taskFor(job: Job): Task {
  const existing = findTaskBySource((s) => s.jobId === job.id, true);
  if (existing) return existing;
  return createTask({
    title: job.task ? `${job.project}：${job.task}`.slice(0, 80) : `${job.project}：交互式会话`,
    kind: "code",
    source: { jobId: job.id, ...(job.conversationId ? { conversationId: job.conversationId } : {}) },
    project: job.project,
    status: "processing",
    understanding: job.task ?? "终端会话",
  });
}

function notify(task: Task, job: Job, title: string, body: string, status: "finished" | "blocked" | "progress"): void {
  state.notices.push({ title: `${title} · ${job.project}`, body: body.slice(0, 200) });
  const conv = task.source.conversationId ?? job.conversationId;
  if (conv && conversationExists(conv)) {
    addMessage(conv, { role: "assistant", kind: "run", content: `${title}：${body}`, payload: { status, jobId: job.id } });
  }
}

async function currentBranch(dir: string): Promise<string> {
  const { stdout } = await execFileP("git", ["-C", dir, "branch", "--show-current"]).catch(() => ({ stdout: "" }));
  return stdout.trim();
}

/**
 * 任务背景。两个去处，给的东西不一样：
 * - 终端（friday_context，默认）：只给事实和 Friday 查到的关联（原话、Slack 全文、工单、项目、人物）。
 *   不给 plan——Friday 没有这个项目的 skill 和代码上下文，它的「方案」是猜的，
 *   塞给真正看得到代码的那一边只会把它带偏。
 * - Friday 自己在会话里（taskBlock，audience: "friday"）：要带 plan。
 *   那是你和它在前几轮聊定的结论（task_update 写进去的），丢了它就忘了你已经拍过的板。
 */
export function contextFor(task: Task, job?: Job, audience: "terminal" | "friday" = "terminal"): string {
  const thread = task.source.threadId ? listThreads("all", 300).find((t) => t.id === task.source.threadId) : undefined;
  const project = loadProjects().find((p) => p.name === (task.project ?? job?.project));
  const person = thread ? personNote(thread.userName) : undefined;
  return [
    `任务：${task.title}（${task.status}，优先级 ${task.priority}）`,
    task.understanding ? `这件事是什么：${task.understanding}` : "",
    audience === "friday" && task.plan ? `和用户聊定的方案：${task.plan}` : "",
    task.progress ? `目前进展：${task.progress}` : "",
    task.source.note ? `用户交代的原话：${task.source.note}` : "",
    task.source.url ? `用户给的链接：${task.source.url}` : "",
    task.source.meegleId ? `Meegle 工单：#${task.source.meegleId}` : "",
    task.source.researchFile ? `这是 Friday 自学的一题，完整研究笔记（记忆库 ${task.source.researchFile}）：\n${readResearchNote(task.source.researchFile).slice(0, 6000) || "（笔记文件已不在）"}` : "",
    thread ? `Slack 原文（${thread.channelName || "私聊"} · ${thread.userName}）：\n${thread.items.map((i) => `- ${i.userName}：${i.text}`).join("\n").slice(0, 2000)}` : "",
    project ? `项目：${project.name}，目录 ${project.dir}${project.aliases.length ? `，别名 ${project.aliases.join("、")}` : ""}${project.note ? `，说明：${project.note}` : ""}` : job ? `项目：${job.project}，目录 ${job.dir}` : "",
    person ? `人物：${thread!.userName} — ${person}` : "",
    task.pending?.length ? `等用户点头的动作：${task.pending.map((p) => p.label).join("、")}` : "",
    audience === "terminal" ? "\n以上都是 Friday 收集到的事实，它没读过这个项目的代码，也没有项目的 skill。改哪里、怎么改、分几步由你自己看代码判断。" : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** 用户又给终端说话了（Friday 转达或直接打字）：上一轮的"等你看/卡住"标记清掉 */
export function clearAttention(jobId: string): void {
  const t = findTaskBySource((s) => s.jobId === jobId);
  if (t?.attention) updateTask(t.id, { attention: undefined });
}


/** 终端里的 Claude 一轮说完（Stop hook）：这就是"这轮做完了等你看"，把它说的话回流到任务会话，用户不用去翻终端 */
export function turnFinished(jobId: string, text: string): void {
  const job = getJob(jobId);
  const task = findTaskBySource((s) => s.jobId === jobId);
  if (!job || !task || task.source.autonomous || task.status !== "processing") return;
  // 这一轮刚用 friday_done 交付过，别重复说一遍
  if (task.report?.at && Date.now() - new Date(task.report.at).getTime() < 10_000) return;
  const t = updateTask(task.id, { attention: "review", progress: `这轮说完了：${text.replace(/\s+/g, " ").slice(0, 140)}` })!;
  const conv = t.source.conversationId ?? job.conversationId;
  if (conv && conversationExists(conv)) {
    addMessage(conv, { role: "assistant", kind: "run", content: `终端里的 Claude 这轮说完了：\n${text.slice(0, 1500)}`, payload: { status: "turn", jobId } });
  }
}

/** 用户勾了一项「通过前请确认」。全部勾完 = 这轮验收通过：有终端就让它继续下一步，有待审动作就等用户点通过。 */
export async function setVerified(taskId: string, index: number, checked: boolean): Promise<Task | undefined> {
  const task = getTask(taskId);
  if (!task?.report || index < 0 || index >= task.report.verify.length) return undefined;
  const list = Array.from({ length: task.report.verify.length }, (_, i) => task.report!.checked?.[i] ?? false);
  const wasAll = list.every(Boolean);
  list[index] = checked;
  const all = list.every(Boolean);
  let t = updateTask(taskId, { report: { ...task.report, checked: list } })!;
  if (!all || wasAll) return t;

  record({ taskId, action: "verified_all", why: "用户逐项确认完交付报告的全部验证点", how: `${list.length} 项全部勾选`, evidence: { verify: task.report.verify }, risk: "read" });
  const jobId = t.source.jobId;
  // /run 建的任务把会话记在 job 上
  const conv = t.source.conversationId ?? (jobId ? getJob(jobId)?.conversationId : undefined);
  const hasPending = (t.pending ?? []).length > 0;
  if (jobId && !hasPending && t.status === "processing") {
    const r = await say(jobId, `用户已逐项确认你上一轮列的 ${list.length} 条验证点，全部通过。继续下一步（该提交就提交，按项目流程建 draft MR，不要 push 到主分支、不要 merge），做完调 friday_done。`);
    const note = r === "no-terminal" ? "你已确认全部验证点；终端窗口已经关掉了" : "你已确认全部验证点，已让终端继续下一步";
    t = updateTask(taskId, { attention: undefined, progress: note })!;
    if (conv && conversationExists(conv)) addMessage(conv, { role: "assistant", kind: "run", content: `→ ${note}`, payload: { status: "relayed", jobId } });
  } else if (conv && conversationExists(conv)) {
    addMessage(conv, { role: "assistant", kind: "ask", content: hasPending ? `全部验证点已确认。下一步是「${t.pending![0]!.label}」，卡片上点通过就行。` : "全部验证点已确认，这条任务可以标记完成了。" });
  }
  return t;
}

/** 把 AskUserQuestion / ExitPlanMode 的输入整理成一句人能看的问题 */
export function describeQuestion(toolName: string, toolInput: string | undefined): string {
  let input: Record<string, unknown> = {};
  try {
    input = toolInput ? (JSON.parse(toolInput) as Record<string, unknown>) : {};
  } catch {
  }
  if (toolName === "ExitPlanMode") {
    const plan = String(input.plan ?? "").replace(/\s+/g, " ").trim();
    return `要不要按这个计划执行？${plan ? `计划：${plan.slice(0, 200)}` : ""}`;
  }
  const qs = Array.isArray(input.questions) ? (input.questions as Array<{ question?: string; options?: Array<{ label?: string }> }>) : [];
  if (!qs.length) return "终端在等你回答一个问题";
  return qs
    .map((q) => `${String(q.question ?? "").trim()}${q.options?.length ? `（选项：${q.options.map((o, i) => `${i + 1}. ${o.label ?? ""}`).join(" / ")}）` : ""}`)
    .join("；")
    .slice(0, 600);
}

/** 终端里的 Claude 弹了交互式提问：阻塞，用户得马上回。进「待我决定」顶上、红点、系统通知、会话里留问题原文。 */
export function terminalAsking(jobId: string, question: string, weak = false): void {
  const job = getJob(jobId);
  const task = findTaskBySource((s) => s.jobId === jobId);
  if (!job || !task || task.status === "done" || task.status === "ignored") return;
  // Notification 的文案是泛的（"Claude needs your permission"），已经有具体问题时不要盖掉
  if (weak && task.attention === "question") return;
  const t = updateTask(task.id, { attention: "question", progress: `终端在问：${question.slice(0, 200)}` })!;
  record({ taskId: t.id, action: "terminal_question", why: "终端里的 Claude Code 弹了交互式提问，等用户回答", how: question.slice(0, 300), evidence: { jobId }, risk: "read" });
  const conv = t.source.conversationId ?? job.conversationId;
  if (conv && conversationExists(conv)) {
    addMessage(conv, { role: "assistant", kind: "run", content: `终端在问你（它停下了，回答前不会继续）：\n${question}\n\n直接告诉我选哪个或怎么回，我敲进去；或者点「聚焦终端」自己答。`, payload: { status: "question", jobId } });
  }
  state.notices.push({ title: `终端在等你回答 · ${job.project}`, body: question.slice(0, 200) });
}

/** 问题答了（PostToolUse），或终端继续干活了：解除阻塞 */
export function terminalAnswered(jobId: string): void {
  const task = findTaskBySource((s) => s.jobId === jobId);
  if (task?.attention === "question") updateTask(task.id, { attention: undefined, progress: "已回答，终端继续" });
}

export async function callBridge(jobId: string, name: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
  const job = getJob(jobId);
  if (!job) return { text: "Friday 这边找不到这个终端任务", isError: true };
  const task = taskFor(job);

  if (name === "friday_context") return { text: contextFor(task, job) };

  if (name === "friday_progress") {
    const text = String(args.text ?? "").trim().slice(0, 300);
    if (!text) return { text: "text 不能为空", isError: true };
    // 分支是关联 Meegle / Slack / 浏览器的钥匙，它没报就自己去读
    const dir = task.source.worktree ?? task.source.repoDir ?? job.dir;
    const branch = String(args.branch ?? "").trim() || (dir ? currentBranchSync(dir) : "");
    // 新一轮开始干活了，上一轮"等你看/卡住"的标记清掉
    updateTask(task.id, { progress: text, attention: undefined, ...(branch ? { source: { branch } } : {}) });
    setJobMessage(jobId, text);
    return { text: "记下了，用户能在任务卡上看到。" };
  }

  if (name === "friday_done") {
    const strs = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
    const report: DeliveryReport = {
      summary: String(args.summary ?? "").trim() || "（没写概要）",
      changes: strs(args.changes),
      testSteps: strs(args.testSteps),
      testResult: String(args.testResult ?? "").trim() || "（没写测试结果）",
      screenshots: [],
      verify: strs(args.verify),
      at: new Date().toISOString(),
    };
    const branch = await currentBranch(job.dir);
    if (!task.source.autonomous) {
      // 交互式终端：这只是"这一轮做完了"，任务留在「Friday 在做」里标黄等用户看；任务完不完成由用户说
      const t = updateTask(task.id, { report, attention: "review", progress: `这轮做完了：${report.summary}` })!;
      record({ taskId: t.id, action: "terminal_round_done", why: "终端里的 Claude Code 报告这一轮做完", how: "friday_done", evidence: { jobId, summary: report.summary, testResult: report.testResult, branch }, risk: "read" });
      notify(t, job, "这轮做完了，等你看", report.summary, "finished");
      // 交付完就把窗口关掉：报告和动作流都已经落到任务卡上，留个空窗口只会越攒越多。
      // 要接着聊就点任务卡上的「重开终端」，--resume 接回这个会话，上下文不丢。
      void closeJobTerminal(jobId, "终端交付完这一轮", t.id);
      return { text: "已交给用户看，终端窗口随之关闭。任务是否算完成由用户决定；用户要追问会重开终端接回这个会话。" };
    }
    let t = updateTask(task.id, { status: "review", report, progress: "终端里的 Claude Code 说做完了，等你验收" })!;
    // 只要不在主干上就挂合并动作（分支名由终端的 Claude 按项目规范起）
    const onFeatureBranch = Boolean(branch) && branch !== "main" && branch !== "master";
    if (onFeatureBranch && !(t.pending ?? []).some((p) => p.type === "git_merge")) {
      t = addPending(t.id, { type: "git_merge", label: `合并 ${branch}`, detail: `把 ${branch} 合并进主分支（不 push）`, payload: { dir: job.dir, branch } })!;
    }
    record({ taskId: t.id, action: "terminal_done", why: "终端里的 Claude Code 报告任务完成", how: "friday_done 交付报告", evidence: { jobId, summary: report.summary, testResult: report.testResult, branch }, risk: "read" });
    notify(t, job, "做完了，等你验收", report.summary, "finished");
    void closeJobTerminal(jobId, "终端交付完任务", t.id);
    return { text: `已交付，用户会收到验收提醒。${onFeatureBranch ? `合并 ${branch} 已挂成待审核动作，不要自己 merge。` : ""}终端窗口随之关闭。` };
  }

  if (name === "friday_blocked") {
    const reason = String(args.reason ?? "").trim().slice(0, 500);
    if (!reason) return { text: "reason 不能为空", isError: true };
    const t = task.source.autonomous
      ? updateTask(task.id, { status: "blocked", progress: `卡住：${reason}` })!
      : updateTask(task.id, { attention: "blocked", progress: `卡住：${reason}` })!;
    record({ taskId: t.id, action: "terminal_blocked", why: "终端里的 Claude Code 报告卡住", how: reason, evidence: { jobId }, risk: "read" });
    notify(t, job, "卡住了，需要你", reason, "blocked");
    return { text: "已通知用户，等用户处理。" };
  }

  return { text: `没有这个工具：${name}`, isError: true };
}
