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
import { reopenTerminal } from "../agent/runner.js";
import { loadProjects, matchEnv, resolveProject } from "../memory/projects.js";
import { askStream } from "../agent/claude.js";
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
async function relayToTerminal(text: string, taskId?: string, scene?: string, url?: string): Promise<SummonRelayResult | undefined> {
  const task = taskId ? getTask(taskId) : undefined;
  if (!task) return undefined;

  const jobId = task.source.jobId;
  if (jobId) {
    const job = getJob(jobId);
    const said = [text, pageHint(url, job?.dir ?? "")].filter(Boolean).join(" ");
    if (job?.status === "running" && (await say(jobId, said)) === "sent") {
      return { kind: "said", message: "已转达给终端", taskId: task.id, jobId };
    }
    if ((await reopenTerminal(jobId)) === "no-job") return undefined;
    await say(jobId, said);
    return { kind: "opened", message: "终端没开，已重开并接回原会话", taskId: task.id, jobId };
  }

  if (!task.project) return undefined;
  const resolved = resolveProject(task.project);
  if (resolved.kind !== "match") return undefined;
  const detail = [text, pageHint(url, resolved.project.dir), scene ? untrusted("当前场景", scene) : ""].filter(Boolean).join("\n\n");
  const started = await startInteractiveJob(task, resolved.project.name, resolved.project.dir, detail);
  return {
    kind: "started",
    message: `已在 ${resolved.project.name} 开终端`,
    taskId: task.id,
    ...(started.source.jobId ? { jobId: started.source.jobId } : {}),
  };
}

export const summonApi = new Hono()
  .post("/summon", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { snapshot?: Snapshot };
    if (!body.snapshot?.app) return c.json({ error: "缺 snapshot" }, 400);
    // 判断不对时第一个要问的是「它到底看到了什么」：标题空多半是辅助功能权限没给
    const a = body.snapshot.app;
    console.log(`[summon] ${a.name} 标题=${JSON.stringify(a.title)} 权限(辅助/自动化/录屏)=${[body.snapshot.permissions.accessibility, body.snapshot.permissions.automation, body.snapshot.permissions.screen].map((x) => (x ? "√" : "×")).join("")}`);
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
    const { text, taskId, scene, url } = (await c.req.json().catch(() => ({}))) as { text?: string; taskId?: string; scene?: string; url?: string };
    if (!text?.trim()) return c.json({ error: "缺 text" }, 400);
    const said = text.trim();

    return streamSSE(c, async (stream) => {
      const relayed = await relayToTerminal(said, taskId, scene, url);
      if (relayed) {
        await stream.writeSSE({ data: JSON.stringify({ type: "result", result: relayed }) });
        await stream.writeSSE({ data: JSON.stringify({ type: "done" }) });
        return;
      }

      const prompt = [scene ? untrusted("当前场景", scene) : "", said].filter(Boolean).join("\n\n");
      let answer = "";
      for await (const ev of askStream(prompt, { systemPrompt: friday(loadMemoryContext()), cwd: config.dataDir, label: "ask" })) {
        if (ev.type === "delta") {
          answer += ev.text;
          await stream.writeSSE({ data: JSON.stringify({ type: "delta", text: ev.text }) });
        } else if (ev.type === "reset") {
          answer = "";
          await stream.writeSSE({ data: JSON.stringify({ type: "reset" }) });
        }
      }
      const result: SummonRelayResult = { kind: "asked", message: answer };
      await stream.writeSSE({ data: JSON.stringify({ type: "result", result }) });
      await stream.writeSSE({ data: JSON.stringify({ type: "done" }) });
    });
  });
