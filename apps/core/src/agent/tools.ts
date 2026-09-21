import { learnHistoryOnce } from "./handbook.js";
import { listHandbooks, readHandbook } from "../memory/handbooks.js";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { TERMINAL_LABEL } from "@friday/shared";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { currentBranchSync, gitInspect } from "./git.js";
import { surfaceContext } from "./surface.js";
import { decide } from "./permission.js";
import { jobLog, launchClaude } from "./runner.js";
import { createJob, getJob, listJobs, recentDuplicate, setGhosttyId } from "../memory/jobs.js";
import { addMessage, conversationExists } from "../memory/conversations.js";
import { TERMINAL_STATE_LABEL, closeJobTerminal, say, terminalState } from "./terminal.js";
import { clearAttention } from "./bridge.js";
import { updateTaskFromChat } from "./taskUpdate.js";
import { addMeegleByRef, meegleState, syncMeegleOnce } from "./meegle.js";
import { state as slackState, syncSlackOnce } from "../scheduler/index.js";
import { formatActivity, jobActivity } from "./transcript.js";
import { createTask, findTaskBySource, getTask, updateTask } from "../memory/tasks.js";
import { record } from "../memory/audit.js";
import { readMemoryFile, writeMemoryFile } from "../memory/files.js";
import { listInbox } from "../memory/inbox.js";
import { conversationKey } from "../memory/infer.js";
import { attachedTasks } from "./slack/attach.js";
import { resolveProject } from "../memory/projects.js";
import { addNoteTask } from "../memory/noteTask.js";
import { userSettings } from "../settings.js";

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

const fridayToolList = (conversationId?: string) => [
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
        const task = addNoteTask({ text: input.text, ...(input.due ? { due: input.due } : {}), ...(conversationId ? { source: { conversationId } } : {}) });
        return text(`已记到待办：${task.title}${task.due ? `（截止 ${task.due}）` : ""}`);
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
            .map((j) => `- [${j.status}] ${j.project}${j.task ? `：${j.task}` : ""}（${j.startedAt.slice(11, 16)} 开始${j.exitCode !== undefined ? `，退出码 ${j.exitCode}` : `，${TERMINAL_STATE_LABEL[terminalState(j.id)]}`}）${j.lastMessage ? `\n  最后一轮：${j.lastMessage.slice(0, 200)}` : ""}`)
            .join("\n") || "还没有任务记录。",
        ),
    ),
    tool(
      "run_claude",
      "在用户默认终端打开该项目目录并启动交互式 Claude Code，可附带任务描述。用户说“起个终端”“让 Claude 去改/去查”“跑一下 X”时用它。",
      { project, task: z.string().max(4000).optional().describe("对方或用户要什么，照原话转达，保留关键词、报错、路径、工单号。不要写改哪个文件、什么方案、分几步——那由终端自己看代码判断") },
      async ({ project, task }) => {
        const r = resolveOrExplain(project);
        if (typeof r === "string") return text(r);
        if (!decide("reversible").allowed) return text("操作被拒绝");
        const { terminal } = userSettings();
        const dup = recentDuplicate(r.dir, task);
        if (dup) return text(`同一任务 10 秒内已经在终端启动过了（任务 id ${dup.id}），不再重复打开。`);
        const id = randomUUID();
        const { ghosttyId } = await launchClaude({ id, dir: r.dir, terminal, ...(task ? { task } : {}) });
        createJob({ id, project: r.name, dir: r.dir, logPath: jobLog(id), ...(task ? { task } : {}), ...(conversationId ? { conversationId } : {}) });
        if (ghosttyId) setGhosttyId(id, ghosttyId);
        // 这个会话是从某条任务点「在会话里讨论」进来的：终端挂到那条任务上，而不是再建一条
        const linked = conversationId ? findTaskBySource((src) => src.conversationId === conversationId) : undefined;
        // 同一个会话里已有的任务（多半是那条 Slack 待办）就是这次干活的来源
        const origin = linked ?? (conversationId ? findTaskBySource((src) => src.conversationId === conversationId, true) : undefined);
        // 开工时的分支先记下来，终端里 git switch 之后靠 friday_progress 更新
        const branch0 = currentBranchSync(r.dir) || undefined;
        const t = linked
          ? updateTask(linked.id, { status: "processing", project: linked.project ?? r.name, progress: `Claude Code 正在 ${r.name} 上处理${task ? `：${task.slice(0, 80)}` : ""}`, source: { jobId: id, repoDir: r.dir, ...(branch0 ? { branch: branch0 } : {}) } })!
          : createTask({
              title: task ? `${r.name}：${task}`.slice(0, 80) : `${r.name}：交互式会话`,
              kind: "code",
              // 带上来源：从 Slack 待办派生出来的代码任务，干完要能找回该回复谁、该关掉哪条
              source: {
                jobId: id,
                repoDir: r.dir,
                ...(branch0 ? { branch: branch0 } : {}),
                ...(conversationId ? { conversationId } : {}),
                ...(origin ? { fromTaskId: origin.id, ...(origin.source.threadId ? { threadId: origin.source.threadId } : {}) } : {}),
              },
              project: r.name,
              status: "processing",
              understanding: task ?? "会话里让 Friday 开的终端",
            });
        record({ taskId: t.id, action: "claude_code_start", why: linked ? "讨论这条任务时让 Friday 去干活" : "会话里让 Friday 去干活", how: `${terminal} 终端里启动 Claude Code`, evidence: { jobId: id, project: r.name, dir: r.dir }, risk: "reversible" });
        console.log(`[tool] run_claude ${r.name} ${task ?? "(交互)"}`);
        return text(`已在 ${TERMINAL_LABEL[terminal]} 打开 ${r.name}（${r.dir}）${task ? `，任务：${task}` : ""}。任务 id ${id}，结束后会回报。`);
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
        record({ ...(bound.taskId ? { taskId: bound.taskId } : {}), action: "terminal_say", why: "用户在会话里交代，转给终端里的 Claude Code", how: "写进 Ghostty 窗口", evidence: { jobId: bound.jobId, text: msg }, risk: "reversible" });
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
        return text(`${job.project} · ${job.status}${job.status === "running" ? ` · ${TERMINAL_STATE_LABEL[terminalState(id)]}` : ""}${job.lastMessage ? `\n最后一轮：${job.lastMessage.slice(0, 200)}` : ""}\n\n最近动作：\n${formatActivity(jobActivity(job.dir, job.claudeSessionId, limit ?? 12))}`);
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
      "把会话里聊出来的结论写回当前任务卡：开发阶段 stage、状态（用户说做完了 / 不用管了 / 先放着）、理解 / 方案 / 进展、待审的 Slack 回复草稿（用户点「看一眼再发」看到的就是这段，讨论改了回复内容必须同步），以及「通过前请确认」的验收列表 verify。用户说不用回了就 dropReply。方案在会话里改过、卡片上那几条验收点已经对不上新方案时，用 verify 重写一遍（会清掉已勾状态，因为新条目还没人验过）。只对这条会话绑定的任务有效。",
      {
        understanding: z.string().max(4000).optional().describe("对这件事的最新理解，整段覆盖"),
        plan: z.string().max(4000).optional().describe("最新方案，整段覆盖"),
        progress: z.string().max(300).optional().describe("一句话进展"),
        replyDraft: z.string().max(2000).optional().describe("给对方的回复全文，可直接发的口语中文"),
        dropReply: z.boolean().optional().describe("撤掉待审的回复动作"),
        status: z.enum(["processing", "review", "blocked", "done", "ignored"]).optional().describe("用户明确说了才改：做完了=done，不用管了=ignored，先放着/等我看=review，卡住=blocked，继续做=processing"),
        verify: z.array(z.string().max(300)).max(12).optional().describe("「通过前请确认」那几条，整组覆盖。方案改了、旧列表对不上了就重写一遍；每条写用户能自己核对的具体现象，不要写「代码已修改」这种没法验的"),
        project: z.string().max(80).optional().describe("这条任务属于哪个项目（注册表里的名字）。用户回答「这条是 X 项目的」时填，会顺带把工单标题里的标记和页面地址记进 projects.md，下次同类工单自动归"),
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
        return text(r.changed.length ? `任务卡已更新：${r.changed.join("、")}。${r.changed.includes("回复草稿") || r.changed.includes("新挂回复草稿") ? "用户点「看一眼再发」时会看到这段草稿、可以再改，确认后才发。" : ""}` : "和卡片上一样，没改。");
      },
    ),
  ];

/** 这条会话正在讨论的任务的终端：先看任务绑定，再看 run_claude 从这条会话开的 job */
function boundJob(conversationId?: string): { jobId: string; taskId?: string } | undefined {
  if (!conversationId) return undefined;
  const t = findTaskBySource((s) => s.conversationId === conversationId);
  if (t?.source.jobId) return { jobId: t.source.jobId, taskId: t.id };
  const j = listJobs().find((x) => x.conversationId === conversationId && x.status === "running");
  return j ? { jobId: j.id } : undefined;
}

export const FRIDAY_TOOL_NAMES = fridayToolList().map((t) => `mcp__friday__${t.name}`);
