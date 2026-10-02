import { learnHistoryOnce } from "./handbook.js";
import { listHandbooks, readHandbook } from "../memory/handbooks.js";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { STAGE_LABEL, type AuditEvent, type PendingActionType, type Task, type TaskStatus } from "@friday/shared";
import { z } from "zod";
import { gitInspect } from "./git.js";
import { surfaceContext } from "./surface.js";
import { decide } from "./permission.js";
import { getJob, listJobs, recentDuplicate } from "../memory/jobs.js";
import { addMessage, conversationExists, listMessages } from "../memory/conversations.js";
import { approvePending, rejectTask, startInteractiveJob } from "./pipeline.js";
import { closeJobTerminal, say } from "./terminal.js";
import { jobStateLabel } from "./sessionState.js";
import { clearAttention } from "./bridge.js";
import { updateTaskFromChat } from "./taskUpdate.js";
import { addMeegleByRef, meegleState, syncMeegleOnce } from "./meegle.js";
import { state as slackState, syncSlackOnce } from "../scheduler/index.js";
import { formatActivity, jobActivity } from "./transcript.js";
import { createTask, findTaskBySource, getTask, listTasks } from "../memory/tasks.js";
import { listAudit, record } from "../memory/audit.js";
import { readMemoryFile, writeMemoryFile } from "../memory/files.js";
import { listInbox } from "../memory/inbox.js";
import { conversationKey } from "../memory/infer.js";
import { attachedTasks } from "./slack/attach.js";
import { resolveProject } from "../memory/projects.js";
import { addNoteTask } from "../memory/noteTask.js";
import { draftWeeklyOnce } from "./weekly/index.js";
import { parseWeek } from "./weekly/week.js";

const project = z.string().min(1).describe("项目名、别名或目录路径");

function resolveOrExplain(query: string) {
  const r = resolveProject(query);
  if (r.kind === "match") return { dir: r.project.dir, name: r.project.name };
  if (r.kind === "ambiguous") return `「${query}」匹配到多个项目：${r.candidates.map((c) => `${c.name}（${c.dir}）`).join("、")}，请让用户明确。`;
  return `没找到项目「${query}」，请让用户在项目注册表里登记，或直接给目录路径。`;
}

const file = z.enum(["projects", "decisions", "people"]).describe("projects=项目注册表，decisions=决策记录，people=人物");
const MEMORY_NAMES = file;
const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

// Friday 在对话里能用的全部工具。都是对记忆库的可逆写操作，按 permission.ts 归为 reversible：放行并留痕。
export const fridayTools = (conversationId?: string) => createSdkMcpServer({
  name: "friday",
  version: "0.1.0",
  tools: fridayToolList(conversationId),
});

export const fridayToolList = (conversationId?: string) => [
    tool(
      "memory_read",
      "读取记忆库里的一个 markdown 文件全文。file 传 projects / decisions / people 读那三个文件；传 handbook:<项目名>（如 handbook:whale-console、handbook:_global）读该项目的干活手册。",
      { file: z.string().min(1).max(80) },
      async ({ file }) => {
        const hb = /^handbook:(.+)$/.exec(file);
        if (hb) return text(readHandbook(hb[1]!) || `（没有 ${hb[1]} 的手册，现有：${listHandbooks().join("、") || "一份都没有"}）`);
        const parsed = MEMORY_NAMES.safeParse(file);
        if (!parsed.success) return text(`没有这个文件。可读：projects / decisions / people${listHandbooks().length ? `，以及 ${listHandbooks().map((h) => `handbook:${h}`).join("、")}` : ""}`);
        return text(readMemoryFile(parsed.data) || "（空文件）");
      },
    ),
    tool(
      "memory_write",
      "整篇覆盖写入记忆库 markdown 文件。改项目别名、登记新项目、记决策、记人物都用它：先 memory_read 拿全文，改好后整篇写回，保持原有格式（## 名称 / - 目录 / - 别名 / - 状态 / - 说明）。",
      { file, content: z.string().max(200_000) },
      async ({ file, content }) => {
        if (!decide("reversible").allowed) return text("操作被拒绝");
        writeMemoryFile(file, content);
        console.log(`[tool] memory_write ${file} ${content.length} chars`);
        return text(`已写入 ${file}`);
      },
    ),
    tool(
      "todo_add",
      "记一条待办。会建成一条任务，出现在工作台左栏的「待办」分组里。",
      { text: z.string().min(1).max(2000), due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("截止日期 YYYY-MM-DD") },
      async (input) => {
        const task = addNoteTask({ text: input.text, ...(input.due ? { due: input.due } : {}), ...(freeConversation(conversationId) ? { source: { conversationId } } : {}) });
        return text(`已记到待办：${task.title}${task.due ? `（截止 ${task.due}）` : ""}`);
      },
    ),
    tool(
      "task_add",
      "在工作台建一条任务，只建不开工。用户说「建个任务」「新建一个任务」「记一下这件事」时用它——建完就停下，不要接着 run_claude。要写代码的活给 stage=todo，它才会进阶段分组、才吃后面的阶段推进信号；纯提醒（买牛奶、几点开会）不给 stage。",
      {
        title: z.string().min(1).max(2000).describe("这件事是什么，用用户的原话"),
        detail: z.string().max(4000).optional().describe("补充说明：链接、要改什么、对方的原话。链接照原样保留"),
        project: z.string().optional().describe("项目名或别名，定不下来就不要填，别猜"),
        stage: z.enum(["todo"]).optional().describe("要写代码的活填 todo，纯提醒不填"),
        due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("截止日期 YYYY-MM-DD"),
      },
      async (input) => {
        // 项目定不下来就不写，宁可空着让用户在卡片上补——猜错了后面派活会派到别的仓库
        const r = input.project ? resolveProject(input.project) : undefined;
        const name = r?.kind === "match" ? r.project.name : undefined;
        const task = addNoteTask({
          text: input.title,
          ...(input.detail ? { understanding: `${input.title}\n\n${input.detail}` } : {}),
          ...(name ? { project: name } : {}),
          ...(input.stage ? { stage: input.stage, kind: "code" as const } : {}),
          ...(input.due ? { due: input.due } : {}),
          ...(freeConversation(conversationId) ? { source: { conversationId } } : {}),
        });
        record({ taskId: task.id, action: "task_add", why: "用户在会话里让建一条任务", how: "建成工作台任务，未开工", evidence: { title: task.title, ...(name ? { project: name } : {}) }, risk: "reversible", undo: { kind: "drop_note_task", id: task.id } });
        return text(`已建任务（id ${task.id.slice(0, 8)}）：${task.title}${task.project ? `（${task.project}）` : ""}${task.due ? `，截止 ${task.due}` : ""}。要开工说一声。`);
      },
    ),
    tool(
      "tasks_list",
      "查工作台任务板上的任务（就是左栏那个列表的数据）。用户问「有没有这条」「XX 项目上有哪些事」「我手上有什么」「刚才建的那条在哪」时用它查，不要凭印象答。默认只列没收工的；keyword 按标题和理解做包含匹配。",
      {
        scope: z.enum(["open", "done", "all"]).optional().describe("open=没收工的（默认），done=已完成或已忽略，all=全部"),
        keyword: z.string().max(100).optional().describe("标题或理解里包含的字，比如「日终」"),
        project: z.string().max(80).optional().describe("项目名或别名"),
        stage: z.enum(["todo", "dev", "testing", "accepted", "released"]).optional(),
        limit: z.number().int().min(1).max(100).optional().describe("默认 30"),
      },
      async ({ scope, keyword, project, stage, limit }) => {
        const r = project ? resolveOrExplain(project) : undefined;
        if (typeof r === "string") return text(r);
        const closed = (t: Task) => t.status === "done" || t.status === "ignored";
        const kw = keyword?.trim().toLowerCase();
        const hits = listTasks(undefined, 2000).filter(
          (t) =>
            (scope === "all" || (scope === "done" ? closed(t) : !closed(t))) &&
            (!r || t.project === r.name) &&
            (!stage || t.stage === stage) &&
            (!kw || `${t.title}\n${t.understanding ?? ""}`.toLowerCase().includes(kw)),
        );
        if (!hits.length) return text(`没有符合条件的任务（${scope ?? "open"}${r ? ` · ${r.name}` : ""}${stage ? ` · ${STAGE_LABEL[stage]}` : ""}${kw ? ` · 含「${keyword}」` : ""}）。`);
        const shown = hits.slice(0, limit ?? 30);
        return text(`${hits.length} 条${hits.length > shown.length ? `，列前 ${shown.length} 条` : ""}（按最近更新）：\n${shown.map(taskLine).join("\n")}`);
      },
    ),
    tool(
      "task_get",
      "看一条任务卡的完整内容：状态、阶段、理解、方案、进展、等用户点头的动作、链接，以及 Friday 在这条任务上做过的最近几件事。id 用 tasks_list 给的前 8 位即可。",
      { id: z.string().min(4).max(64) },
      async ({ id }) => {
        const t = findTaskById(id);
        if (!t) return text(`没有 id 以 ${id} 开头的任务。`);
        const s = t.source;
        const links = [s.url, ...(s.docs ?? []).map((d) => d.url)].filter(Boolean);
        const acts = listAudit({ taskId: t.id, limit: 8 });
        return text([
          taskLine(t),
          `来源 ${t.kind} · 创建 ${localTime(t.createdAt)} · 更新 ${localTime(t.updatedAt)}${t.pinned ? " · 关注" : ""}`,
          t.understanding && `理解：${t.understanding}`,
          t.plan && `方案：${t.plan}`,
          t.progress && `进展：${t.progress}`,
          t.pending?.length && `等用户点头：${t.pending.map((p) => p.label).join("、")}`,
          t.report?.summary && `交付报告：${t.report.summary}`,
          (s.branch || s.jobId) && `终端：${s.jobId ? s.jobId.slice(0, 8) : "无"}${s.branch ? ` · 分支 ${s.branch}` : ""}`,
          links.length && `链接：${links.join(" ")}`,
          acts.length && `最近的操作记录：\n${acts.map(auditLine).join("\n")}`,
        ].filter(Boolean).join("\n"));
      },
    ),
    tool(
      "audit_list",
      "查 Friday 自己的操作记录（账本）：建了哪条任务、开了哪个终端、改了哪张卡、同步了什么。用户问「你刚才建了吗」「你做过什么」「这条为什么变成完成了」时用它核对，不要凭记忆答。",
      {
        action: z.string().max(40).optional().describe("只看某类动作，比如 task_add、claude_code_start、task_update"),
        taskId: z.string().max(64).optional().describe("只看某条任务上的，前 8 位即可"),
        limit: z.number().int().min(1).max(50).optional().describe("默认 15"),
      },
      async ({ action, taskId, limit }) => {
        const t = taskId ? findTaskById(taskId) : undefined;
        if (taskId && !t) return text(`没有 id 以 ${taskId} 开头的任务。`);
        const rows = listAudit({ ...(t ? { taskId: t.id } : {}), limit: action ? 1000 : (limit ?? 15) })
          .filter((e) => !action || e.action === action)
          .slice(0, limit ?? 15);
        return text(rows.length ? rows.map(auditLine).join("\n") : "没有符合条件的操作记录。");
      },
    ),
    tool(
      "git_inspect",
      "只读查看某个项目的 git 状态。what=status 当前分支/未提交改动/相对上游；worktrees 每个 worktree 的分支、是否已合并进主分支、最后提交、是否有未提交改动；log 最近 15 条提交；branches 已合并/未合并分支。",
      { project, what: z.enum(["status", "worktrees", "log", "branches"]) },
      async ({ project, what }) => {
        const r = resolveOrExplain(project);
        if (typeof r === "string") return text(r);
        return text(`${r.name} (${r.dir})\n${await gitInspect(r.dir, what)}`);
      },
    ),
    tool(
      "slack_inbox",
      "列出 Slack 上最近找用户的人：谁说了什么、挂到了哪条任务上。用户问“Slack 有什么”“谁找我”“处理 XX 那件事”时先用它。",
      {},
      async () => {
        const items = listInbox(false, 30);
        if (!items.length) return text("没有等处理的 Slack 消息。");
        const lines = items.map((i) => {
          const conv = conversationKey(i);
          const tasks = attachedTasks(conv).map((id) => getTask(id)?.title).filter(Boolean);
          return `${i.userName}（${i.channelName}）：${i.text.slice(0, 120)}${tasks.length ? `\n  → 挂在：${tasks.join("、")}` : "\n  → 还没挂到任何任务"}`;
        });
        return text(lines.join("\n"));
      },
    ),
    tool(
      "jobs_list",
      "列出最近的终端任务（跑 Claude Code 的记录）：项目、任务、状态、退出码、终端里 Claude 最后一轮说了什么。用户问“刚才那个任务怎么样了”“终端跑完了吗”时用。",
      {},
      async () =>
        text(
          listJobs(10)
            .map((j) => `- [${j.status}] ${j.project}${j.task ? `：${j.task}` : ""}（${j.startedAt.slice(11, 16)} 开始${j.exitCode !== undefined ? `，退出码 ${j.exitCode}` : `，${jobStateLabel(j.id)}`}）${j.lastMessage ? `\n  最后一轮：${j.lastMessage.slice(0, 200)}` : ""}`)
            .join("\n") || "还没有任务记录。",
        ),
    ),
    tool(
      "run_claude",
      "在 Friday 的终端里为该项目建好 worktree 并启动交互式 Claude Code，可附带任务描述。用户说“起个终端”“让 Claude 去改/去查”“跑一下 X”时用它。",
      { project, task: z.string().max(4000).optional().describe("对方或用户要什么，照原话转达，保留关键词、报错、路径、工单号。不要写改哪个文件、什么方案、分几步——那由终端自己看代码判断") },
      async ({ project, task }) => {
        const r = resolveOrExplain(project);
        if (typeof r === "string") return text(r);
        if (!decide("reversible").allowed) return text("操作被拒绝");
        const dup = recentDuplicate(r.dir, task);
        if (dup) return text(`同一任务 10 秒内已经在终端启动过了（任务 id ${dup.id}），不再重复打开。`);
        // 这个会话是从某条任务点「在会话里讨论」进来的：终端挂到那条任务上，而不是再建一条
        const linked = conversationId ? findTaskBySource((src) => src.conversationId === conversationId) : undefined;
        // 同一个会话里已有的任务（多半是那条 Slack 待办）就是这次干活的来源
        const origin = linked ?? (conversationId ? findTaskBySource((src) => src.conversationId === conversationId, true) : undefined);
        const t =
          linked ??
          createTask({
            title: task ? `${r.name}：${task}`.slice(0, 80) : `${r.name}：交互式会话`,
            kind: "code",
            // 带上来源：从 Slack 待办派生出来的代码任务，干完要能找回该回复谁、该关掉哪条
            source: {
              repoDir: r.dir,
              ...(conversationId ? { conversationId } : {}),
              ...(origin ? { fromTaskId: origin.id, ...(origin.source.threadId ? { threadId: origin.source.threadId } : {}) } : {}),
            },
            project: r.name,
            status: "understood",
            understanding: task ?? "会话里让 Friday 开的终端",
          });
        const started = await startInteractiveJob(t, r.name, r.dir, task ?? "", conversationId);
        const id = started.source.jobId ?? t.id;
        console.log(`[tool] run_claude ${r.name} ${task ?? "(交互)"}`);
        return text(`已在 Friday 里打开 ${r.name}（${r.dir}）的终端${task ? `，任务：${task}` : ""}。任务 id ${id}，结束后会回报。`);
      },
    ),
    tool(
      "terminal_say",
      "往当前会话绑定的任务的终端窗口里，对正在干活的 Claude Code 说一句话：转达用户的指令、补充要求、回答它的提问。用户说“让它…”“告诉它…”“接着把…也做了”时用。",
      { text: z.string().min(1).max(4000).describe("要对终端里的 Claude Code 说的话，用户的原意，可以稍加整理") },
      async ({ text: msg }) => {
        const bound = boundJob(conversationId);
        if (!bound) return text("这条会话没有绑定带终端的任务，转达不了。让用户从任务的「在会话里讨论」进来，或先用 run_claude 开一个。");
        const r = await say(bound.jobId, msg);
        if (r === "no-terminal") return text("这条任务的终端窗口已经关掉了，转达不进去。要继续的话让用户用 run_claude 重新开一个。");
        clearAttention(bound.jobId);
        if (conversationId && conversationExists(conversationId)) {
          addMessage(conversationId, { role: "assistant", kind: "run", content: `→ 已转达给终端：${msg}`, payload: { status: "relayed", jobId: bound.jobId } });
        }
        record({ ...(bound.taskId ? { taskId: bound.taskId } : {}), action: "terminal_say", why: "用户在会话里交代，转给终端里的 Claude Code", how: "写进 tmux 会话", evidence: { jobId: bound.jobId, text: msg }, risk: "reversible" });
        return text("已敲进终端。它回话后会回报到任务卡，不用你复述。");
      },
    ),
    tool(
      "jobs_activity",
      "看某个终端任务里 Claude Code 最近在做什么：读了/改了哪些文件、跑了什么命令、成败、说了什么。不给 jobId 就看当前会话绑定的任务。用户问“它做到哪了”“在干什么”时用。",
      { jobId: z.string().optional(), limit: z.number().int().min(1).max(40).optional() },
      async ({ jobId, limit }) => {
        const id = jobId ?? boundJob(conversationId)?.jobId;
        if (!id) return text("没有指定任务，这条会话也没绑定终端任务。");
        const job = getJob(id);
        if (!job) return text("没有这个任务。");
        return text(`${job.project} · ${job.status}${job.status === "running" ? ` · ${jobStateLabel(id)}` : ""}${job.lastMessage ? `\n最后一轮：${job.lastMessage.slice(0, 200)}` : ""}\n\n最近动作：\n${formatActivity(jobActivity(job.dir, job.claudeSessionId, limit ?? 12))}`);
      },
    ),
    tool(
      "meegle_sync",
      "立刻同步一次 Meegle 分派给用户的工单到任务板（新工单建待办、已有的更新、不再分派的自动完成）。用户说“刷一下 Meegle”“拉一下工单”“看看有没有新需求”时用。平时每 15 分钟自动同步一次。",
      {},
      async () => {
        const r = await syncMeegleOnce();
        return text(meegleState.lastError ? `同步出错：${meegleState.lastError}` : `同步完成：新增 ${r.added} 条${r.reopened ? `，Reopen 拉回 ${r.reopened} 条` : ""}，自动完成 ${r.closed} 条${meegleState.lastSyncAt ? `（${meegleState.lastSyncAt.slice(11, 16)}）` : ""}。`);
      },
    ),
    tool(
      "meegle_add",
      "用户贴了一条 Meegle 工单链接说「待办里没有这个，建一个」「加进来」「跟一下这条需求」时用它：按链接单拉工单详情，建成任务板上的待办。同步链路只认「分派给我」的工单，用户担角色但当前节点在别人手上的工单进不来，得用这个手动加。只要链接，不要追问标题和内容——工单里都有。",
      { link: z.string().min(1).max(500).describe("Meegle 工单链接，形如 https://project.larksuite.com/projectlb/story/detail/24487610") },
      async ({ link }) => {
        if (!decide("reversible").allowed) return text("操作被拒绝");
        const r = await addMeegleByRef(link).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
        if ("error" in r) return text(`加不进来：${r.error}`);
        const { task, existed } = r;
        if (existed) return text(`这条已经在任务板上了：${task.title}（${task.status}）。`);
        return text(`已建进待办：${task.title}${task.priority !== "normal" ? ` · ${task.priority}` : ""}\n${task.understanding ?? ""}`);
      },
    ),
    tool(
      "close_terminals",
      "关掉在跑的终端。scope 为 finished 时只关任务已完成或已忽略的（清理遗留），为 all 时关掉全部。用户说「关掉终端」「终端太多了」「清理一下」时用。终端里跑着的 Claude Code 会一起停掉，任务本身不动。",
      { scope: z.enum(["finished", "all"]).optional().describe("finished 只关已收工任务的（默认），all 关全部") },
      async ({ scope }) => {
        const onlyFinished = scope !== "all";
        const running = listJobs().filter((j) => j.status === "running");
        const targets = onlyFinished
          ? running.filter((j) => {
              const t = findTaskBySource((src) => src.jobId === j.id, true);
              return !t || t.status === "done" || t.status === "ignored";
            })
          : running;
        if (!targets.length) return text(running.length ? `在跑的 ${running.length} 个终端都还挂着未完成的任务，没关。要全关就说「全部关掉」。` : "现在没有在跑的终端。");
        let closed = 0;
        for (const j of targets) {
          closeJobTerminal(j.id, onlyFinished ? "会话里要求清理已收工的终端" : "会话里要求关掉全部终端");
          if (getJob(j.id)?.status !== "running") closed++;
        }
        return text(`关掉了 ${closed} 个终端${running.length > closed ? `，还剩 ${running.length - closed} 个在跑` : ""}。`);
      },
    ),
    tool(
      "surface_context",
      "看用户现在浏览器里开着的页面属于哪个项目、这个项目上有哪些没收工的事、哪个终端在跑。用户说“我这个页面”“当前这页”“这个后台”而没说是哪个项目时用它认出来。",
      { url: z.string().describe("页面地址，用户没给就说你需要它") },
      async ({ url }) => {
        const ctx = surfaceContext(url);
        if (!ctx.project && !ctx.tasks.length) return text(`不认识 ${url}。在 projects.md 里给那个项目补一条「地址：」就能认出来。`);
        return text([
          `页面：${url}`,
          `项目：${ctx.project ?? "认不出"}`,
          ctx.tasks.length ? `这个项目上在办的：\n${ctx.tasks.map((t) => `- ${t.title}${t.branch ? `（${t.branch}）` : ""}${t.jobId ? `｜终端 ${t.terminal}` : ""}`).join("\n")}` : "这个项目上没有在办的事",
        ].join("\n"));
      },
    ),
    tool(
      "learn_history",
      "从用户过去在 Claude Code 里说过的话里提炼「在某个项目怎么干活」的手册（技术口径、分支流程、踩过的坑），每条带原话出处。用户说“从历史学一下”“把我以前说过的规矩学了”“更新项目手册”时用。结果不会直接写记忆库，会挂成一条待审任务等用户点头。要花一两分钟。平时每周自动学一轮（设置里可关）。",
      {},
      async () => {
        const r = await learnHistoryOnce(true);
        return text("skipped" in r ? `这次没学：${r.skipped}` : `提炼完了：${r.groups} 份手册，依据 ${r.candidates} 条你说过的原话，已挂成待审任务（${r.taskId.slice(0, 8)}）。在「待我决定」里过一眼，点「通过并执行」才会写进记忆库。`);
      },
    ),
    tool(
      "okr_weekly",
      "起草 OKR 平台上的周报：用本周 git 提交和任务，按用户每个 KR 各写一段进展和建议进度，挂成一张审核卡。用户说“填周报”“写 OKR 周报”“补上周的周报”时用。不会直接提交，用户在卡上改完点提交才会写到平台。要补某一周就传 week（如 2026W0914-0920）。",
      { week: z.string().optional().describe("周标识，如 2026W0921-0927；不传按周五 16:00 前算上周、之后算本周") },
      async ({ week }) => {
        const w = week ? parseWeek(week) : undefined;
        if (week && !w) return text("week 格式不对，应为 2026W0921-0927 这种、从周一开始。");
        const r = await draftWeeklyOnce({ week: w, manual: true });
        return text("skipped" in r ? `没起草：${r.skipped}` : `起草好了：${r.drafted} 条有草稿，${r.empty} 条没找到相关工作。已挂成审核卡（${r.taskId.slice(0, 8)}），在任务里改完点「提交」才会写到 OKR 平台。`);
      },
    ),
    tool(
      "slack_sync",
      "立刻拉一次 Slack（@我 和私聊里的新消息，预处理成线程和任务）。用户说“刷一下 Slack”“看看有没有新消息”时用。平时白天每 3 分钟、其余 15 分钟自动拉。",
      {},
      async () => {
        const added = await syncSlackOnce();
        if (!slackState.configured) return text("Slack 没接入（钥匙串里没有 friday-slack 凭证），跑一下 scripts/slack-auth.sh。");
        return text(slackState.lastError ? `同步出错：${slackState.lastError}` : `同步完成：新收到 ${added} 条${slackState.lastSyncAt ? `（${slackState.lastSyncAt.slice(11, 16)}）` : ""}。有需要回的会进「待我决定」。`);
      },
    ),
    tool(
      "task_update",
      "把会话里聊出来的结论写回当前任务卡：开发阶段 stage、状态（用户说做完了 / 不用管了 / 先放着）、理解 / 方案 / 进展、待审的 Slack 回复草稿（用户要发之前你贴给他看的就是这段，讨论改了回复内容必须同步），以及「通过前请确认」的验收列表 verify。用户说不用回了就 dropReply。方案在会话里改过、卡片上那几条验收点已经对不上新方案时，用 verify 重写一遍（会清掉已勾状态，因为新条目还没人验过）。只对这条会话绑定的任务有效。",
      {
        understanding: z.string().max(4000).optional().describe("对这件事的最新理解，整段覆盖"),
        plan: z.string().max(4000).optional().describe("最新方案，整段覆盖"),
        progress: z.string().max(300).optional().describe("一句话进展"),
        replyDraft: z.string().max(2000).optional().describe("给对方的回复全文，可直接发的口语中文"),
        dropReply: z.boolean().optional().describe("撤掉待审的回复动作"),
        status: z.enum(["processing", "review", "blocked", "done", "ignored"]).optional().describe("用户明确说了才改：做完了=done，不用管了=ignored，先放着/等我看=review，卡住=blocked，继续做=processing"),
        verify: z.array(z.string().max(300)).max(12).optional().describe("「通过前请确认」那几条，整组覆盖。方案改了、旧列表对不上了就重写一遍；每条写用户能自己核对的具体现象，不要写「代码已修改」这种没法验的"),
        project: z.string().max(80).optional().describe("这条任务属于哪个项目（注册表里的名字）。用户回答「这条是 X 项目的」或说「项目不对，是 X」时填，会顺带把工单标题里的标记和页面地址记进 projects.md，下次同类工单自动归。Friday 已经在旧项目上自主干过活的，不会直接改，而是挂一条回退清单：把清单原样告诉用户，他说「撤掉」再用 task_approve 执行；他说「算了，还是原来的」就把 project 填回原来的名字，清单会撤掉"),
        autostart: z.boolean().optional().describe("用户说「先别做 / 这条我来」填 false，Friday 不再自己开工；说「你来做吧」填 true 恢复"),
        stage: z
          .enum(["todo", "dev", "testing", "accepted", "released"])
          .optional()
          .describe("开发走到哪一步了，用户说了才改：未开始=todo，在写代码/联调=dev，提测了或产品在验收=testing，验收完等发布=accepted，上线了=released（上线即完成，会自动收走）。往回拨也用它，比如测试打回就从 testing 拨回 dev"),
        stageReason: z
          .enum(["misjudged", "bounced"])
          .optional()
          .describe("只在往回拨时填，必须问清楚是哪种：misjudged=Friday 之前推错了阶段（会学，下次别再这么判），bounced=确实被打回了（客观事实，不学）。分不清就问用户"),
      },
      async (patch) => {
        const t = conversationId ? findTaskBySource((s) => s.conversationId === conversationId) : undefined;
        if (!t) return text("这条会话没有绑定任务，没有卡片可更新。");
        if (!decide("reversible").allowed) return text("操作被拒绝");
        const r = updateTaskFromChat(t.id, patch);
        if (!r) return text("任务不存在了。");
        return text(r.changed.length ? `任务卡已更新：${r.changed.join("、")}。${r.changed.includes("回复草稿") || r.changed.includes("新挂回复草稿") ? "要发之前先把这段原文贴给用户，他说「发」再用 task_approve。" : ""}` : "和卡片上一样，没改。");
      },
    ),
    tool(
      "task_start",
      "用户在这条任务的会话里说「开始做 / 开工」时 mode=interactive：在任务详情里开一个交互式终端，他自己驱动；说「交给 Friday 改 / 你来改」时 mode=autonomous：Friday 自主在 worktree 里改完交给他审。项目还没定就先问他是哪个项目，用 task_update 的 project 定下来再调。只对这条会话绑定的任务有效。",
      { mode: z.enum(["interactive", "autonomous"]) },
      async ({ mode }) => {
        const t = boundTask(conversationId);
        if (!t) return text("这条会话没有绑定任务。");
        const { startTask, handToFriday } = await import("./taskStart.js");
        const r = mode === "interactive" ? await startTask(t) : await handToFriday(t);
        if ("error" in r) return text(`没开成：${r.error}`);
        return text(mode === "interactive" ? `终端开好了（在 ${r.task.project} 上），用户在任务详情里就能看到。` : `交给 Friday 了：在 ${r.task.project} 上自主开工，改完交报告给用户审。`);
      },
    ),
    tool(
      "task_approve",
      "用户在会话里明确说「合并吧 / 就这么发 / 通过」时，执行这条任务上等他点头的动作。有多个待审动作时用 actionId 指定（先用 task_get 看）；是 Slack 回复时必须先把要发的原文完整贴给用户、他说「发」之后才调，text 填最终原文。没得到明确同意不要调。",
      { actionId: z.string().max(80).optional(), text: z.string().max(4000).optional() },
      async ({ actionId, text: override }) => {
        const t = boundTask(conversationId);
        if (!t) return text("这条会话没有绑定任务。");
        const pending = t.pending ?? [];
        if (!pending.length) return text("这条任务上没有等你点头的动作。");
        if (!actionId && pending.length > 1) return text(`这条任务挂着 ${pending.length} 个待审动作，先问清楚用户要执行哪一个，再带 actionId 调：${pending.map((p) => `${p.id.slice(0, 8)}「${p.label}」`).join("、")}。`);
        const action = actionId ? pending.find((p) => p.id.startsWith(actionId)) : pending[0];
        if (!action) return text(`没有这个待审动作。现有的：${pending.map((p) => `${p.id.slice(0, 8)}「${p.label}」`).join("、")}。`);
        const forms = APPROVAL[action.type];
        if (!forms) return text(`「${action.label}」这类动作不能在会话里批准，让用户自己去任务卡上处理。`);
        const said = (listMessages(conversationId!).filter((m) => m.role === "user").at(-1)?.content ?? "").trim();
        if (!consents(said, forms))
          return text(
            `用户还没明确同意「${action.label}」，不执行。这条动作会做的是：${action.detail}。先核对用户要的是不是这件事：不是的话（比如他要推送，这条却是合并），直接告诉他挂着的动作不是他要的、没有能批准的，绝不能教他用这条动作的同意词去批准它。是的话，请他单独回一句${forms.map((f) => `「${f}」`).join("、")}中的一个再调；带问号或附加要求的都不算同意。`,
          );
        if (action.type === "slack_reply") {
          const body = override?.trim() || String(action.payload.text ?? action.detail);
          const shown = listMessages(conversationId!).filter((m) => m.role === "assistant" && m.kind === "ask").at(-1);
          if (!shown || !squash(shown.content).includes(squash(body))) return text("先把要发的原文完整贴给用户，等他说「发」再调——上一轮你还没给他看过这段原文。");
        }
        try {
          const done = await approvePending(t.id, action.id, override);
          return text(`已执行「${action.label}」。任务现在是${STATUS_LABEL[done.status]}。`);
        } catch (e) {
          return text(`没执行成功：${e instanceof Error ? e.message : String(e)}。动作还挂在任务上。`);
        }
      },
    ),
    tool(
      "task_reject",
      "用户在会话里说「打回，原因是…」时，把这条任务打回：作废待审动作，退回处理中，原因记下来（会进 Friday 的学习）。reason 用用户的原话。",
      { reason: z.string().min(1).max(500) },
      async ({ reason }) => {
        const t = boundTask(conversationId);
        if (!t) return text("这条会话没有绑定任务。");
        rejectTask(t.id, reason);
        return text(`已打回：${reason}`);
      },
    ),
  ];

// 任务自己的会话里再建的任务要有自己的会话：同一段会话绑两条任务，打回 / 批准就可能落到另一条上
function freeConversation(conversationId?: string): conversationId is string {
  return Boolean(conversationId) && !findTaskBySource((s) => s.conversationId === conversationId, true);
}

function boundTask(conversationId?: string): Task | undefined {
  return conversationId ? findTaskBySource((s) => s.conversationId === conversationId) : undefined;
}

const squash = (s: string) => s.replace(/\s+/g, "");

// 批准不可逆的动作只认用户这一轮的原话，而且整句就是一个短的同意：「发吧，语气再软点」「能合并吗？」都是还在商量
const APPROVAL: Partial<Record<PendingActionType, string[]>> = {
  slack_reply: ["发", "发吧", "发出去", "就这么发", "可以发", "发送"],
  git_merge: ["合并", "合并吧", "可以合并", "合吧", "通过"],
  okr_submit: ["提交", "提交吧", "可以提交", "通过"],
  start_job: ["开工", "开工吧", "开始做", "开始做吧", "通过"],
  handbook_apply: ["通过", "应用", "应用吧"],
  reproject: ["撤掉", "撤掉吧", "回退", "回退吧", "通过"],
};

function consents(said: string, forms: string[]): boolean {
  if (/[？?]/.test(said)) return false;
  return forms.includes(said.replace(/[。！!～~\s]+$/, "").trim());
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  collected: "刚收进来",
  understood: "待办",
  processing: "在做",
  review: "等你决定",
  blocked: "卡住",
  done: "已完成",
  ignored: "已忽略",
};

const localTime = (iso: string) => new Date(iso).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }).slice(0, -3);

function findTaskById(id: string): Task | undefined {
  return getTask(id) ?? listTasks(undefined, 2000).find((t) => t.id.startsWith(id));
}

function taskLine(t: Task): string {
  const tags = [STATUS_LABEL[t.status], t.stage && STAGE_LABEL[t.stage], t.project, t.due && `截止 ${t.due}`, t.priority !== "normal" && t.priority].filter(Boolean);
  return `- ${t.id.slice(0, 8)} ${t.title}（${tags.join(" · ")}）`;
}

function auditLine(e: AuditEvent): string {
  const title = typeof e.evidence.title === "string" ? `「${e.evidence.title}」` : "";
  return `- ${localTime(e.ts)} ${e.action}${title}：${e.why}${e.taskId ? `（任务 ${e.taskId.slice(0, 8)}）` : ""}${e.status !== "done" ? ` [${e.status}]` : ""}`;
}

/** 这条会话正在讨论的任务的终端：先看任务绑定，再看 run_claude 从这条会话开的 job */
function boundJob(conversationId?: string): { jobId: string; taskId?: string } | undefined {
  if (!conversationId) return undefined;
  const t = findTaskBySource((s) => s.conversationId === conversationId);
  if (t?.source.jobId) return { jobId: t.source.jobId, taskId: t.id };
  const j = listJobs().find((x) => x.conversationId === conversationId && x.status === "running");
  return j ? { jobId: j.id } : undefined;
}

export const FRIDAY_TOOL_NAMES = fridayToolList().map((t) => `mcp__friday__${t.name}`);
