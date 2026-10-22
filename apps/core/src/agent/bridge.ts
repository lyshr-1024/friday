import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DeliveryReport, Job, Task } from "@friday/shared";
import { record } from "../memory/audit.js";
import { untrusted } from "./fence.js";
import { onSignal } from "./stage.js";
import { addMessage, conversationExists } from "../memory/conversations.js";
import { getJob, setJobMessage } from "../memory/jobs.js";
import { knowledgeBlock } from "../memory/features.js";
import { loadProjects, projectDetail, protectedBranches } from "../memory/projects.js";
import { addPending, createTask, findTaskBySource, getTask, listTasks, tasksByIdPrefix, handedUnderRoot, updateTask } from "../memory/tasks.js";
import { listInbox } from "../memory/inbox.js";
import { conversationKey } from "../memory/infer.js";
import { state } from "../scheduler/index.js";
import { personNote } from "../memory/files.js";
import { readResearchNote } from "../memory/research.js";
import { say } from "./terminal.js";
import { commitsAheadSync, currentBranchSync, defaultBranchSync } from "./git.js";
import { pushVerdict, type PushVerdict } from "./guard.js";
import { finishTask } from "./pipeline.js";
import { replyLanguageLine } from "./lang.js";

/** 贴在工具返回末尾：工具调用之后那段汇报最容易换成英文 */
const lang = () => `\n接下来${replyLanguageLine()}。`;
import { closeRun, closeRunForTask, recordRound } from "./runLog.js";
import { transitionToInProgress } from "./meegle.js";
import { postDelivery } from "./delivery.js";
import { ingestBootstrap } from "./knowledgeBootstrap.js";
import { storeBrief } from "./briefJob.js";
import { renderBrief } from "./brief.js";
import { readChunk } from "./web.js";

const execFileP = promisify(execFile);

/** 终端里的 Claude Code 通过 MCP 调回 Friday 的工具。按 jobId 绑到任务，不需要它自己知道任务 id。 */
export interface BridgeTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const str = (description: string) => ({ type: "string", description });
const list = (description: string) => ({ type: "array", items: { type: "string" }, description });

const TASK_ID = str("Friday 任务 id 前 8 位；提示词里给了就填，没给不填");

export const BRIDGE_TOOLS: BridgeTool[] = [
  {
    name: "friday_context",
    description: "拿这条任务的背景：交代的原话、Slack 原文、关联工单、项目与人物、等用户点头的动作。都是 Friday 收集的事实，不含技术方案——改哪里怎么改由你看代码定。开工前先调一次。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "friday_progress",
    description: "报一句阶段进展（不超过 200 字），用户在 Friday 的任务卡上实时看到。每完成一个阶段调一次，不要每步都调。起好分支后第一次调用要带上 branch。",
    inputSchema: { type: "object", properties: { text: str("一句话进展"), branch: str("当前分支名，起好或切换后报一次"), taskId: TASK_ID }, required: ["text"] },
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
        taskId: TASK_ID,
      },
      required: ["summary", "testResult"],
    },
  },
  {
    name: "friday_finish",
    description: "整条任务收工：只在 MR 已经合并之后调。调之前你自己按项目规则删掉这次的 worktree 和本地分支（git worktree remove、git branch -d，不要 --force；删不掉就说明原因）。Friday 会把任务标完成并关掉这个终端会话。做完一轮、提测了、MR 还没合，都用 friday_done，不要调这个。",
    inputSchema: { type: "object", properties: { summary: str("一句话：哪个 MR 合了、清理了什么") }, required: ["summary"] },
  },
  {
    name: "friday_blocked",
    description: "卡住了，需要用户介入才能继续（缺权限、需求不清、环境问题）。说明原因和需要用户做什么。",
    inputSchema: { type: "object", properties: { reason: str("卡在哪、需要用户做什么"), taskId: TASK_ID }, required: ["reason"] },
  },
];

export const KNOWLEDGE_TOOL: BridgeTool = {
  name: "friday_knowledge",
  description: "知识库冷启动专用：把扫出来的功能报给 Friday 直接入库。可以分批调，每批不超过 200 条；同名的 Friday 会合并。",
  inputSchema: {
    type: "object",
    properties: {
      features: {
        type: "array",
        description: "功能列表",
        items: {
          type: "object",
          properties: {
            name: str("功能名，界面上怎么叫就怎么写"),
            aliases: list("别的叫法"),
            where: str("在界面上哪里"),
            paths: list("相关目录或文件，相对主仓"),
            routes: list("路由"),
            summary: str("一句话说这个功能是干什么的"),
          },
          required: ["name"],
        },
      },
    },
    required: ["features"],
  },
};

export const BRIEF_TOOL: BridgeTool = {
  name: "friday_brief",
  description: "建理解卡专用：把这条需求的理解卡报给 Friday。字段不合法会回错，照错误改了再调；成功后直接退出。",
  inputSchema: {
    type: "object",
    properties: {
      todo: str("这条需求要做什么"),
      deps: {
        type: "array",
        description: "确定要别人给的东西",
        items: {
          type: "object",
          properties: {
            what: str("要什么"),
            from: str("找谁要"),
            status: { type: "string", enum: ["pending", "ready"], description: "已经给了写 ready" },
            evidence: {
              type: "object",
              description: "ready 的出处",
              properties: { source: { type: "string", enum: ["meegle", "slack", "user"] }, url: str("链接"), text: str("原话"), at: str("什么时候给的，ISO 时间") },
              required: ["source"],
            },
          },
          required: ["what", "status"],
        },
      },
      acceptance: {
        type: "object",
        properties: {
          source: { type: "string", enum: ["cases", "prd", "own"], description: "用例来自现成用例 / PRD / 你自己写的" },
          cases: list("用例，一条一句，至少一条"),
          note: str("补充说明"),
        },
        required: ["source", "cases"],
      },
      release: str("怎么发"),
      plan: str("方案：改哪些文件、怎么改；拿不准的写进「要你拍板」"),
      size: { type: "string", enum: ["small", "large"] },
      sizeWhy: str("规模的一句话依据"),
      features: list("涉及的知识库功能 id"),
    },
    required: ["todo", "acceptance", "size", "sizeWhy"],
  },
};

export const WEB_TOOL: BridgeTool = {
  name: "friday_web_read",
  description: "建理解卡专用：用无头浏览器读一个网页（带用户 Chrome 的登录态），长文分段返回，按结尾的 offset 接着读。飞书文档用 lark-doc skill 读，不用这个。",
  inputSchema: { type: "object", properties: { url: str("http / https 地址"), offset: { type: "number", description: "从第几个字开始读，第一次不填" } }, required: ["url"] },
};

const ownerOf = (job: Job): Task | undefined => (job.taskId ? getTask(job.taskId) : findTaskBySource((s) => s.jobId === job.id, true));

export function bridgeToolsFor(jobId: string): BridgeTool[] {
  const job = getJob(jobId);
  const owner = job && ownerOf(job);
  if (owner?.source.knowledgeBootstrap) return [...BRIDGE_TOOLS, KNOWLEDGE_TOOL];
  if (owner?.source.briefFor) return [...BRIDGE_TOOLS, BRIEF_TOOL, WEB_TOOL];
  return BRIDGE_TOOLS;
}

async function webRead(args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
  const url = String(args.url ?? "").trim();
  if (!/^https?:\/\//.test(url)) return { text: "url 只支持 http / https", isError: true };
  const offset = Number.isInteger(args.offset) && (args.offset as number) > 0 ? (args.offset as number) : 0;
  try {
    const r = await readChunk(url, offset);
    if (r.kind === "login") return { text: `读不到，要登录：${r.url}，写进 plan 的要你拍板` };
    const rest = r.next !== undefined ? `还没读完，下一段 offset=${r.next}` : `读完了${r.truncated ? "（原文超过 10 万字，后面截掉了）" : ""}`;
    return { text: `（第 ${r.from + 1}–${r.from + r.text.length} 字，共 ${r.total} 字）\n${untrusted("web", `标题：${r.title}\n地址：${r.url}\n\n${r.text}`)}\n${rest}` };
  } catch (e) {
    return { text: `没读到：${e instanceof Error ? e.message : String(e)}`, isError: true };
  }
}

function taskFor(job: Job): Task {
  const existing = findTaskBySource((s) => s.jobId === job.id, true);
  if (existing) return existing;
  // 开工时记下了这个 job 是替哪条任务干的，认领它而不是另建一条
  if (job.taskId) {
    const owner = getTask(job.taskId);
    if (owner) return updateTask(owner.id, { source: { jobId: job.id } }) ?? owner;
  }
  const t = createTask({
    title: job.task ? `${job.project}：${job.task}`.slice(0, 80) : `${job.project}：交互式会话`,
    kind: "code",
    source: { jobId: job.id, ...(job.conversationId ? { conversationId: job.conversationId } : {}) },
    project: job.project,
    status: "processing",
    understanding: job.task ?? "终端会话",
  });
  record({ taskId: t.id, action: "task_create", why: "终端连回来时没有归属的任务", how: "按 job 补建一条", evidence: { jobId: job.id, project: job.project }, risk: "read" });
  return t;
}

const closed = (t: Task) => t.status === "done" || t.status === "ignored";

const RECENT_HANDED_MS = 24 * 3600_000;

/** 需求会话里的交付归给哪条任务。返回字符串 = 认不出，原样回给 Claude 让它补 taskId */
function targetTask(job: Job, args: Record<string, unknown>, strict = false): Task | string {
  if (!job.sessionId) return taskFor(job);
  const root = job.sessionId;
  const id = String(args.taskId ?? "").trim();
  if (id) {
    const own = !job.taskId || job.taskId === root;
    const hit = tasksByIdPrefix(id).filter((t) => t.source.rootId === root || (own && t.id === root));
    if (hit.length === 1) return hit[0]!;
  }
  if (job.taskId && job.taskId !== root) return taskFor(job);
  const handed = listTasks("processing").filter((t) => t.source.rootId === root && t.source.handedAt);
  if (handed.length === 1) return handed[0]!;
  // 认不出是哪条缺陷的交付（缺陷收工后迟到的、同时有几条在修的）不能落到需求卡上
  const recent = strict ? handedUnderRoot(root).filter((t) => t.source.handedAt && (t.status === "processing" || Date.now() - Date.parse(t.source.handedAt) < RECENT_HANDED_MS)) : [];
  if (recent.length) {
    const list = recent.map((t) => `${t.id.slice(0, 8)}（${t.title.slice(0, 20)}）`).join("、");
    return `没带 taskId，Friday 认不出这次交付是哪条。是需求本身的就填 taskId=${root.slice(0, 8)}；是缺陷的填那条缺陷的 id（最近 24 小时交代过的缺陷：${list}）`;
  }
  return taskFor(job);
}

function notify(task: Task, job: Job, title: string, body: string, status: "finished" | "blocked" | "progress", message = true): void {
  state.notices.push({ title: `${title} · ${job.project}`, body: body.slice(0, 200), taskId: task.id });
  const conv = task.source.conversationId ?? job.conversationId;
  if (message && conv && conversationExists(conv)) {
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
  const conv = task.source.conversation;
  const msgs = conv ? listInbox(true, 200).filter((i) => conversationKey(i) === conv) : [];
  const who = task.source.userName ?? msgs[0]?.userName;
  const projectName = task.project ?? job?.project;
  const project = loadProjects().find((p) => p.name === projectName);
  const knowledge = projectName ? knowledgeBlock(projectName, [task.title, task.understanding].join("\n")) : "";
  const person = who ? personNote(who) : undefined;
  const brief = task.source.brief && renderBrief(task.source.brief);
  return [
    `任务：${task.title}（${task.status}，优先级 ${task.priority}）`,
    task.understanding ? `这件事是什么：\n${untrusted(task.source.meegleId ? "meegle-understanding" : "task-understanding", task.understanding)}` : "",
    brief ? `理解卡：\n${untrusted("brief", brief)}` : "",
    // plan 默认就是理解卡的渲染文本，一样的不重复带
    audience === "friday" && task.plan && task.plan !== brief ? `和用户聊定的方案：${task.plan}` : "",
    task.progress ? `目前进展：${task.progress}` : "",
    task.source.note ? `用户交代的原话：${task.source.note}` : "",
    task.source.url ? `用户给的链接：${task.source.url}` : "",
    task.source.meegleId ? `Meegle 工单：#${task.source.meegleId}` : "",
    task.source.docs?.length ? `资料：\n${untrusted("docs", task.source.docs.map((d) => `- ${(d.title ?? d.url).slice(0, 200)}：${d.url}`).join("\n"))}` : "",
    task.source.researchFile ? `这是 Friday 自学的一题，完整研究笔记（记忆库 ${task.source.researchFile}）：\n${untrusted("research-note", readResearchNote(task.source.researchFile).slice(0, 6000) || "（笔记文件已不在）")}` : "",
    msgs.length ? `Slack 原文（${msgs[0]!.channelName || "私聊"} · ${msgs[0]!.userName}）：\n${untrusted("slack", msgs.map((i) => `- ${i.userName}：${i.text}`).join("\n").slice(0, 2000))}` : "",
    project ? `项目：${project.name}，目录 ${project.dir}${project.aliases.length ? `，别名 ${project.aliases.join("、")}` : ""}${projectDetail(project) ? `，说明：${projectDetail(project).replace(/\n/g, "；")}` : ""}` : job ? `项目：${job.project}，目录 ${job.dir}` : "",
    knowledge ? untrusted("knowledge", knowledge) : "",
    person ? `人物：${who} — ${person}` : "",
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


/** 终端里的 Claude 一轮说完（Stop hook）：只更新进展；状态位由终端里的现实（Stop 时间）算，不在任务卡上打标记 */
export function turnFinished(jobId: string, text: string): void {
  const task = findTaskBySource((s) => s.jobId === jobId);
  if (!task || task.source.autonomous || task.status !== "processing") return;
  if (task.report?.at && Date.now() - new Date(task.report.at).getTime() < 10_000) return;
  updateTask(task.id, { progress: `这轮说完了：${text.replace(/\s+/g, " ").slice(0, 140)}` });
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
  state.notices.push({ title: `终端在等你回答 · ${job.project}`, body: question.slice(0, 200), taskId: t.id });
}

/**
 * 自主任务的守卫遇到 git push 时来问：目标是开发分支就放（强推、删远端都行），目标是项目的保护分支或仓库默认分支拦下。
 * 守卫等这里的答复再决定，连不上 core 就照拦。
 */
export function checkPush(jobId: string, command: string, cwd?: string): PushVerdict {
  const job = getJob(jobId);
  const task = job && ((job.taskId && getTask(job.taskId)) || findTaskBySource((s) => s.jobId === jobId));
  if (!job || !task) return { allow: false, why: "Friday 不认识这次运行" };
  const v = pushVerdict(command, cwd || task.source.worktree || job.dir, { currentBranch: currentBranchSync, defaultBranch: defaultBranchSync }, protectedBranches(task.project ?? job.project));
  record({
    taskId: task.id,
    action: v.allow ? "push_allowed" : "push_denied",
    why: v.allow ? "推的是开发分支，放行" : v.why,
    how: command.slice(0, 300),
    evidence: { jobId, ...(v.allow ? { dir: v.dir, branches: v.branches } : {}) },
    risk: v.allow ? "reversible" : "read",
  });
  return v;
}

/** 问题答了（PostToolUse），或终端继续干活了：解除阻塞 */
export function terminalAnswered(jobId: string): void {
  const task = findTaskBySource((s) => s.jobId === jobId);
  if (task?.attention === "question") updateTask(task.id, { attention: undefined, progress: "已回答，终端继续" });
}

export async function callBridge(jobId: string, name: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
  const job = getJob(jobId);
  if (!job) return { text: "Friday 这边找不到这个终端任务", isError: true };
  if (name === "friday_knowledge") {
    const owner = ownerOf(job);
    const project = owner?.source.knowledgeBootstrap;
    if (!project) return { text: "这个工具只给知识库冷启动用", isError: true };
    const r = ingestBootstrap(project, owner.source.repoDir ?? job.dir, args);
    return { text: `新建 ${r.added}、合并 ${r.updated}、丢弃 ${r.dropped}。${lang()}` };
  }
  if (name === "friday_brief" || name === "friday_web_read") {
    const anchor = ownerOf(job);
    const taskId = anchor?.source.briefFor;
    if (!taskId) return { text: "这个工具只给建理解卡用", isError: true };
    if (name === "friday_web_read") return webRead(args);
    const r = storeBrief(taskId, args, anchor!.source.briefBuild!);
    if (!r.ok) return { text: `${r.error}。照这个改了再调一次 friday_brief。`, isError: true };
    return { text: `收到了，理解卡已挂到需求上（${r.review === "pending" ? "等用户审" : "按项目规则不用审"}）。直接退出，不用调 friday_done。` };
  }
  // 通用桥接提示词说 friday_done 必须调，冷启动和建卡的锚点是隐藏卡，不能写报告、发通知
  const anchor = ownerOf(job)?.source;
  if (["friday_done", "friday_blocked", "friday_progress", "friday_finish"].includes(name) && (anchor?.knowledgeBootstrap || anchor?.briefFor)) return { text: "这个会话不用调这个，报完直接退出" };
  const target = name === "friday_progress" || name === "friday_done" || name === "friday_blocked" ? targetTask(job, args, name !== "friday_progress") : taskFor(job);
  if (typeof target === "string") return { text: target, isError: true };
  const task = target;

  if (name === "friday_context") return { text: contextFor(task, job) };

  if (name === "friday_progress") {
    const text = String(args.text ?? "").trim().slice(0, 300);
    if (!text) return { text: "text 不能为空", isError: true };
    if (task.source.handedAt && closed(task)) return { text: `用户已经收掉了这条，不用再做。${lang()}` };
    // 分支是关联 Meegle / Slack / 浏览器的钥匙，它没报就自己去读
    const dir = task.source.worktree ?? task.source.repoDir ?? job.dir;
    const branch = task.source.handedAt ? "" : String(args.branch ?? "").trim() || (dir ? currentBranchSync(dir) : "");
    // 新一轮开始干活了，上一轮"等你看/卡住"的标记清掉
    updateTask(task.id, { progress: text, attention: undefined, ...(branch ? { source: { branch } } : {}) });
    // 分支起好了就是真的动手了，这条信号本机可查，直接推到「进行中」
    if (branch) onSignal(task.id, { signal: "branch_commit", to: "dev", ask: "开始动手了？", why: `终端在 ${branch} 上干活` });
    // say 路的缺陷借的是需求的 job，进展别写到需求的最后消息上
    if (!(task.source.handedAt && job.taskId !== task.id)) setJobMessage(jobId, text);
    return { text: `记下了，用户能在任务卡上看到。${lang()}` };
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
    if (task.source.handedAt && closed(task)) {
      closeRunForTask(task.id, "report", task.source.worktree, job.taskId === task.id ? job.claudeSessionId : undefined);
      record({ taskId: task.id, action: "terminal_done_ignored", why: "缺陷已被用户收掉，这次交付不改卡片", how: "friday_done 交付报告", evidence: { jobId, status: task.status, summary: report.summary }, risk: "read" });
      return { text: `用户已经收掉了这条，不用再做。${lang()}` };
    }
    if (task.source.handedAt) {
      const t = updateTask(task.id, { status: "review", report, progress: "修完了，等你核验" })!;
      closeRunForTask(t.id, "report", t.source.worktree, job.taskId === t.id ? job.claudeSessionId : undefined);
      onSignal(t.id, { signal: "terminal_delivered", to: "dev", ask: "开始动手了？", why: "需求会话交付了缺陷" });
      const m = await transitionToInProgress(t);
      record({ taskId: t.id, action: "terminal_done", why: "需求会话里的 Claude Code 报告缺陷修完", how: "friday_done 交付报告", evidence: { jobId, summary: report.summary, testResult: report.testResult, branch }, risk: "read" });
      notify(t, job, "修完了，等你核验", `${report.summary}${m.moved ? "" : `\nMeegle 状态没动：${m.why}`}`, "finished", false);
      postDelivery(t, jobId, report);
      return { text: `已交付，Meegle ${m.moved ? "已转开发中" : "没转：" + m.why}。交付完就结束。${lang()}` };
    }
    if (!task.source.autonomous) {
      // 交互式终端：这只是"这一轮做完了"，任务留在 processing 标黄等用户看；任务完不完成由用户说
      const t = updateTask(task.id, { report, progress: `这轮做完了：${report.summary}` })!;
      if (!task.source.headless) recordRound(jobId, t.id, job.project);
      // 交付了说明确实在写代码，但「交付一轮」不等于提测，最多推到「进行中」
      onSignal(t.id, { signal: "terminal_delivered", to: "dev", ask: "开始动手了？", why: "终端交付了一轮" });
      record({ taskId: t.id, action: "terminal_round_done", why: "终端里的 Claude Code 报告这一轮做完", how: "friday_done", evidence: { jobId, summary: report.summary, testResult: report.testResult, branch }, risk: "read" });
      // 后台查询的交付消息等退出时解析完报告再写（带依据和回复草稿），这里只发通知
      notify(t, job, "这轮做完了，等你看", report.summary, "finished", !task.source.headless);
      // 窗口不关：一个任务常要来回好几轮，用户看完多半就在这个窗口里接着追问。
      // 关窗口只在用户标完成 / 忽略，或 MR 合并后终端自己调 friday_finish
      return { text: `已交给用户看。用户可能就在这个终端里接着追问；等 MR 合并、本地 worktree 清理完再调 friday_finish 收工。${lang()}` };
    }
    let t = updateTask(task.id, { status: "review", report, progress: "终端里的 Claude Code 说做完了，等你验收" })!;
    closeRun(jobId, "report");
    // 空分支不挂合并：Claude 没改代码（比如发现改错仓库）时分支上一个提交都没有，合进去什么也没有
    const onFeatureBranch = Boolean(branch) && branch !== "main" && branch !== "master" && (commitsAheadSync(task.source.worktree ?? job.dir) ?? 0) > 0;
    // 合并待审原来只在 onJobExit 解析 report.md 时挂；走 friday_done 交付的 onJobExit 会提前返回，
    // 于是自主任务第一次跑通（2026-09-28）review 里就没有「合并」可点。合并要在主仓做，不能在 worktree 里。
    if (onFeatureBranch && !(t.pending ?? []).some((p) => p.type === "git_merge")) {
      t = addPending(t.id, {
        type: "git_merge",
        label: `合并 ${branch}`,
        detail: `把 ${branch} 合并进主分支（不 push）`,
        payload: { dir: task.source.repoDir || job.dir, branch, worktree: task.source.worktree ?? "" },
      })!;
    }
    record({ taskId: t.id, action: "terminal_done", why: "终端里的 Claude Code 报告任务完成", how: "friday_done 交付报告", evidence: { jobId, summary: report.summary, testResult: report.testResult, branch }, risk: "read" });
    notify(t, job, "做完了，等你验收", report.summary, "finished", false);
    postDelivery(t, jobId, report);
    return { text: `已交付，用户会收到验收提醒。${onFeatureBranch ? `分支 ${branch} 留着不动，用户在 MR 里验收。` : ""}交付完就结束，会话留着给用户看终端。` };
  }

  if (name === "friday_finish") {
    const summary = String(args.summary ?? "").trim().slice(0, 300);
    if (!summary) return { text: "summary 不能为空", isError: true };
    updateTask(task.id, { progress: `收工：${summary}` });
    record({ taskId: task.id, action: "terminal_finish", why: "终端里的 Claude Code 报告 MR 已合并、本地已清理", how: summary, evidence: { jobId }, risk: "reversible" });
    notify(task, job, "收工了", summary, "finished");
    // 不 await：关窗口会连带结束发起这次调用的 Claude Code，先把结果回给它
    void finishTask(task.id, "done", "终端报告 MR 已合并、本地已清理");
    return { text: "任务已标完成，这个终端窗口马上关闭。" };
  }

  if (name === "friday_blocked") {
    const reason = String(args.reason ?? "").trim().slice(0, 500);
    if (!reason) return { text: "reason 不能为空", isError: true };
    if (task.source.handedAt) closeRunForTask(task.id, "blocked", task.source.worktree, job.taskId === task.id ? job.claudeSessionId : undefined);
    else if (task.source.autonomous) closeRun(jobId, "blocked");
    if (task.source.handedAt && closed(task)) {
      record({ taskId: task.id, action: "terminal_blocked", why: "缺陷已被用户收掉，卡住不改卡片", how: reason, evidence: { jobId, status: task.status }, risk: "read" });
      return { text: `用户已经收掉了这条，不用再做。${lang()}` };
    }
    const t = task.source.autonomous
      ? updateTask(task.id, { status: "blocked", progress: `卡住：${reason}` })!
      : updateTask(task.id, { attention: "blocked", progress: `卡住：${reason}` })!;
    record({ taskId: t.id, action: "terminal_blocked", why: "终端里的 Claude Code 报告卡住", how: reason, evidence: { jobId }, risk: "read" });
    notify(t, job, "卡住了，需要你", reason, "blocked");
    return { text: `已通知用户，等用户处理。${lang()}` };
  }

  return { text: `没有这个工具：${name}`, isError: true };
}
