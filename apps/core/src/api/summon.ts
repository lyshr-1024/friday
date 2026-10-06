import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Snapshot, SummonAction, SummonRelayResult } from "@friday/shared";
import { summon } from "../agent/summon/index.js";
import { pagePath } from "../agent/summon/match.js";
import { finishTask, startInteractiveJob } from "../agent/pipeline.js";
import { addMeegleByRef } from "../agent/meegle.js";
import { addNoteTask } from "../memory/noteTask.js";
import { getTask } from "../memory/tasks.js";
import { readMemoryFile, writeMemoryFile } from "../memory/files.js";
import { getJob } from "../memory/jobs.js";
import { say } from "../agent/terminal.js";
import { resumeInSession } from "../agent/sessions.js";
import { loadProjects, matchEnv, resolveProject } from "../memory/projects.js";
import { askStream } from "../agent/claude.js";
import { classifyIntent } from "../agent/summon/intent.js";
import { startQueryJob } from "../agent/slack/queryJob.js";
import { attachedTasks, candidateTasks } from "../agent/slack/attach.js";
import { conversationKey, slackNode, taskNode, withoutMentions } from "../memory/infer.js";
import { CONV_SCAN_LIMIT, listInbox } from "../memory/inbox.js";
import { linkUp } from "../memory/links.js";
import { listTasks, updateTask } from "../memory/tasks.js";
import { claudeSessionId, conversationExists, createConversation, addMessage, setClaudeSessionId } from "../memory/conversations.js";
import { getAttachment } from "../memory/attachments.js";
import { buildUserContent } from "../agent/content.js";
import { transcriptPath } from "../agent/runner.js";
import { existsSync } from "node:fs";
import { friday } from "../agent/prompt.js";
import { untrusted } from "../agent/fence.js";
import { loadMemoryContext } from "../memory/context.js";
import { config } from "../config.js";

/**
 * 终端里的 Claude 有完整代码上下文和项目 skill，路由文件它自己找得比这边猜得准，
 * 所以只把「哪个环境、哪个页面路径、项目在哪」交过去，不替它推断文件。
 */
export function pageHint(url: string | undefined, dir: string): string {
  if (!url) return "";
  const hit = matchEnv(url, loadProjects());
  const path = pagePath(url);
  return [
    hit ? `我开着的是 ${hit.project.name}${hit.env ? ` 的${hit.env}环境` : ""}。` : "",
    path ? `页面路径 ${path}${dir ? `，项目在 ${dir}` : ""}，先按路由约定找到对应文件再动手。` : "",
  ]
    .filter(Boolean)
    .join("");
}

/**
 * HUD 里打的字优先转给这条需求自己的终端——那里有项目上下文和 skill，
 * 比丢给一个只知道窗口标题的通用对话强得多。转不过去才返回 undefined 落回通用对话。
 */
/** 终端收不了图，给路径：HUD 里粘的图已经落在记忆库 attachments/ 下，终端里的 Claude 自己 Read */
function attachmentHint(ids: string[]): string {
  const paths = ids.map((id) => getAttachment(id)?.path).filter((p): p is string => Boolean(p));
  return paths.length ? `附件（用 Read 看）：${paths.join("、")}` : "";
}

async function relayToTerminal(text: string, taskId?: string, scene?: string, url?: string, attachments: string[] = []): Promise<SummonRelayResult | undefined> {
  const task = taskId ? getTask(taskId) : undefined;
  if (!task) return undefined;

  const jobId = task.source.jobId;
  if (jobId) {
    const job = getJob(jobId);
    const said = [text, pageHint(url, job?.dir ?? ""), attachmentHint(attachments)].filter(Boolean).join(" ");
    if (job?.status === "running" && (await say(jobId, said)) === "sent") {
      return { kind: "said", message: "已转达给终端", taskId: task.id, jobId };
    }
    const sid = job?.sessionId;
    if (!sid || !(await resumeInSession(sid, undefined, jobId))) return undefined;
    await say(jobId, said);
    return { kind: "opened", message: "终端没开，已重开并接回原会话", taskId: task.id, jobId };
  }

  if (!task.project) return undefined;
  const resolved = resolveProject(task.project);
  if (resolved.kind !== "match") return undefined;
  const detail = [text, pageHint(url, resolved.project.dir), attachmentHint(attachments), scene ? untrusted("当前场景", scene) : ""].filter(Boolean).join("\n\n");
  const started = await startInteractiveJob(task, resolved.project.name, resolved.project.dir, detail);
  return {
    kind: "started",
    message: `已在 ${resolved.project.name} 开终端`,
    taskId: task.id,
    ...(started.source.jobId ? { jobId: started.source.jobId } : {}),
  };
}


const findConv = (conv: string) => listInbox(true, CONV_SCAN_LIMIT).filter((i) => conversationKey(i) === conv).sort((a, b) => Number(a.ts) - Number(b.ts));

/**
 * 「帮我查这个 / 建成任务 / 挂到…」原来是三个按钮，零模型调用。按钮收起来之后这条性质要保住：
 * 正则认出来的直接在这儿执行，认不出来的才落回下面的通用对话（那里才花模型钱）。
 */
async function runIntent(
  intent: Exclude<NonNullable<ReturnType<typeof classifyIntent>>, "open_task">,
  conv: string,
  // HUD 卡片阶段已经算出来的：模型判的项目（只认注册表里有的）和整段对话 + 判断。
  // 原来建任务只拿收件箱那一句，项目、背景全丢，开工时还得让用户再选一次项目。
  ctx: { project?: string; scene?: string },
): Promise<SummonRelayResult | undefined> {
  const items = findConv(conv);
  if (!items.length) return undefined;
  const project = ctx.project && resolveProject(ctx.project).kind === "match" ? ctx.project : undefined;
  switch (intent) {
    case "slack_query": {
      const last = items.at(-1)!;
      const task = await startQueryJob(last, last.text, project);
      return task
        ? { kind: "acted", did: intent, message: "已经在后台读代码查了，结果进任务卡", taskId: task.id }
        : { kind: "acted", did: intent, message: "没有可查的项目，projects.md 里先登记一个" };
    }
    case "slack_task": {
      const first = items[0]!;
      const task = addNoteTask({
        text: withoutMentions(first.text),
        source: {
          conversation: conv,
          channelId: first.channelId,
          userName: first.userName,
          ...(first.threadTs ? { threadTs: first.threadTs } : {}),
          ...(project ? { projectBy: "friday" as const } : {}),
        },
        ...(project ? { project } : {}),
        ...(ctx.scene ? { understanding: ctx.scene.slice(0, 4000) } : {}),
      });
      linkUp(slackNode(conv), taskNode(task.id), "user", "你在 HUD 里把这段对话建成了任务");
      return { kind: "acted", did: intent, message: `已建成任务：${task.title}`, taskId: task.id };
    }
    case "slack_attach": {
      // 挂到哪条得用户自己选，这里只把候选给回去
      const choices = candidateTasks(conv, listTasks(["collected", "understood", "processing", "review", "blocked"]))
        .slice(0, 8)
        .map((t) => ({ id: t.id, title: t.title }));
      return choices.length
        ? { kind: "acted", did: intent, message: "挂到哪条？", choices }
        : { kind: "acted", did: intent, message: "没有可挂的任务" };
    }
  }
}

/**
 * 一次呼出算一段会话。对上任务就用那条任务的会话（任务卡上看得到这段对话），
 * 没对上就开一段临时的——HUD 收起来就丢，不进「会话历史」攒垃圾。
 */
function hudConversation(taskId: string | undefined): { id: string; resume?: string } {
  const task = taskId ? getTask(taskId) : undefined;
  const bound = task?.source.conversationId;
  const id = bound && conversationExists(bound) ? bound : createConversation().id;
  // 新建的要绑回任务上，否则下次呼出又读不到、每次都是新会话，等于没有上下文
  if (task && id !== bound) updateTask(task.id, { source: { ...task.source, conversationId: id } });
  const session = claudeSessionId(id);
  const resume = session && existsSync(transcriptPath(config.dataDir, session)) ? session : undefined;
  return { id, ...(resume ? { resume } : {}) };
}

export const summonApi = new Hono()
  .post("/summon", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { snapshot?: Snapshot };
    if (!body.snapshot?.app) return c.json({ error: "缺 snapshot" }, 400);
    // 判断不对时第一个要问的是「它到底看到了什么」：标题空多半是辅助功能权限没给
    const a = body.snapshot.app;
    const b = body.snapshot.browser;
    console.log(`[summon] ${a.name} 标题=${JSON.stringify(a.title)} 权限(辅助/自动化/录屏)=${[body.snapshot.permissions.accessibility, body.snapshot.permissions.automation, body.snapshot.permissions.screen].map((x) => (x ? "√" : "×")).join("")}${b ? ` 浏览器 url=${JSON.stringify(b.url.slice(0, 120))} tab=${JSON.stringify(b.title.slice(0, 60))} 正文=${b.text?.length ?? 0}字` : ""}`);
    return streamSSE(c, async (stream) => {
      for await (const ev of summon(body.snapshot!)) await stream.writeSSE({ data: JSON.stringify(ev) });
    });
  })
  .post("/summon/act", async (c) => {
    const { action } = (await c.req.json().catch(() => ({}))) as { action?: SummonAction };
    if (!action?.kind) return c.json({ error: "缺 action" }, 400);
    switch (action.kind) {
      case "create_task": {
        const task = addNoteTask({ text: action.title, source: { summon: true } });
        return c.json({ ok: true, taskId: task.id, message: "已建成任务" });
      }
      case "mark_done": {
        if (!getTask(action.taskId)) return c.json({ error: "任务不存在" }, 404);
        await finishTask(action.taskId, "done", "在呼出模式里标记完成");
        return c.json({ ok: true, taskId: action.taskId, message: "已标完成" });
      }
      case "note": {
        writeMemoryFile("decisions", `${readMemoryFile("decisions")}\n- ${action.text}\n`);
        return c.json({ ok: true, message: "已记进记忆库" });
      }
      case "meegle_add": {
        const added = await addMeegleByRef(action.url);
        if ("error" in added) return c.json({ error: added.error }, 400);
        return c.json({ ok: true, taskId: added.task.id, message: added.existed ? "任务板上已经有这条了" : "已加进任务板" });
      }
      default:
        return c.json({ error: `不支持的动作 ${action.kind}` }, 400);
    }
  })
  .post("/summon/relay", async (c) => {
    const { text, taskId, scene, url, conv, project, attachments: rawAttachments } = (await c.req.json().catch(() => ({}))) as {
      text?: string;
      taskId?: string;
      scene?: string;
      url?: string;
      conv?: string;
      project?: string;
      attachments?: unknown;
    };
    if (!text?.trim()) return c.json({ error: "缺 text" }, 400);
    const said = text.trim();
    const attachments = Array.isArray(rawAttachments) ? rawAttachments.filter((x): x is string => typeof x === "string").slice(0, 10) : [];

    return streamSSE(c, async (stream) => {
      const finish = async (result: SummonRelayResult) => {
        await stream.writeSSE({ data: JSON.stringify({ type: "result", result }) });
        await stream.writeSSE({ data: JSON.stringify({ type: "done" }) });
      };

      // ① 那几个原来是按钮的动作：正则认出来就直接做，不花模型钱
      const intent = classifyIntent(said);
      // 「打开任务」必须排在转给终端之前：这句话不是给终端里 Claude 的指令，
      // 落到通用对话也只会得到一段任务描述（模型开不了窗口）。能打开的是规则层对上的，或这段对话挂着的。
      if (intent === "open_task") {
        const id = taskId ?? (conv ? attachedTasks(conv)[0] : undefined);
        return finish(
          id && getTask(id)
            ? { kind: "acted", did: "open_task", message: "已打开", taskId: id }
            : { kind: "acted", did: "open_task", message: "这里没有对应的任务，先建一条或挂到某条上" },
        );
      }
      if (intent && conv) {
        const acted = await runIntent(intent, conv, { ...(project ? { project } : {}), ...(scene ? { scene } : {}) });
        if (acted) return finish(acted);
      }

      // ② 有终端的任务，话优先转给它——那里有代码上下文和项目 skill
      const relayed = await relayToTerminal(said, taskId, scene, url, attachments);
      if (relayed) return finish(relayed);

      // ③ 落到通用对话。一次呼出算一段，对上任务就接那条任务的会话
      const { id: conversationId, resume } = hudConversation(taskId);
      const startedAt = new Date().toISOString();
      const prompt = [scene ? untrusted("当前场景", scene) : "", said].filter(Boolean).join("\n\n");
      const { content, attached } = buildUserContent(prompt, attachments);
      addMessage(conversationId, { role: "user", kind: "ask", content: said, ...(attached.length ? { payload: { attachments: attached } } : {}) });
      let answer = "";
      for await (const ev of askStream(content, {
        systemPrompt: friday(loadMemoryContext()),
        cwd: config.dataDir,
        label: "ask",
        conversationId,
        ...(resume ? { resume } : {}),
      })) {
        if (ev.type === "delta") {
          answer += ev.text;
          await stream.writeSSE({ data: JSON.stringify({ type: "delta", text: ev.text }) });
        } else if (ev.type === "reset") {
          answer = "";
          await stream.writeSSE({ data: JSON.stringify({ type: "reset" }) });
        } else if (ev.type === "session") {
          setClaudeSessionId(conversationId, ev.sessionId);
        }
      }
      if (answer) addMessage(conversationId, { role: "assistant", kind: "ask", content: answer });
      // 这一轮里 Friday 用 task_add 建了任务（「建个任务跟进一下…」这类带说明的话走的是模型，不是零模型那条）：
      // 把它带回去，HUD 好跳过去——原来只回一句「已建」，人还停在原来的 app 里
      const created = listTasks(["collected", "understood", "processing", "review"], 20)
        .filter((t) => t.createdAt >= startedAt && !t.source.meegleId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      await finish({ kind: "asked", message: answer, ...(created ? { taskId: created.id } : {}) });
    });
  });
