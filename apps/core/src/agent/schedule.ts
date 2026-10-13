import { existsSync } from "node:fs";
import { z } from "zod";
import type { Schedule, ScheduleInput, Task } from "@friday/shared";
import { config } from "../config.js";
import { userSettings } from "../settings.js";
import { record } from "../memory/audit.js";
import { getJob } from "../memory/jobs.js";
import { resolveProject } from "../memory/projects.js";
import { createTask, getTask } from "../memory/tasks.js";
import { claudeSessionId, createConversation, renameConversation } from "../memory/conversations.js";
import { loadMemoryContext } from "../memory/context.js";
import { getSchedule, pushHistory, updateSchedule } from "../memory/schedules.js";
import { validateCron } from "../scheduler/cron.js";
import { state } from "../scheduler/index.js";
import { callTool, mcpEndpoint } from "../connectors/mcp.js";
import { reopenTask, startAutonomousJob, startInteractiveJob } from "./pipeline.js";
import { friday } from "./prompt.js";
import { isRunning, startRun, subscribe } from "./runs.js";
import { transcriptPath } from "./runner.js";
import { fridayToolList } from "./tools.js";

type Fired = { ok: boolean; result: string; ref?: string };

export const SCHEDULE_NOTE = (title: string) =>
  `这一轮是定时任务「${title}」自动触发的，用户不在看。不可逆的动作只能挂成待审，不要直接执行；回答第一行写一句结论。`;

export function validateSchedule(i: ScheduleInput): string | undefined {
  const bad = validateCron(i.cron);
  if (bad) return bad;
  if (i.executor === "project") {
    const r = i.project ? resolveProject(i.project) : undefined;
    if (r?.kind === "ambiguous") return `「${i.project}」匹配到多个项目：${r.candidates.map((c) => c.name).join("、")}，说清是哪个`;
    if (r?.kind !== "match") return `找不到项目「${i.project ?? ""}」`;
    if (!i.prompt?.trim()) return "项目定时任务要写提示词";
  }
  if (i.executor === "friday" && !i.prompt?.trim()) return "Friday 定时任务要写提示词";
  if (i.executor === "call") {
    if (!i.server || !i.tool) return "固定调用要写 server 和 tool";
    if (i.server === "friday") {
      if (i.tool.startsWith("schedule")) return "定时任务不能去登记 / 改定时任务";
      if (!fridayToolList().some((t) => t.name === i.tool)) return `Friday 没有 ${i.tool} 这个工具`;
    } else {
      try {
        mcpEndpoint(i.server);
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    }
  }
  return undefined;
}

const runningJob = (t: Task | undefined) => Boolean(t?.source.jobId && getJob(t.source.jobId)?.status === "running");
const hasPending = (t: Task | undefined) => Boolean(t && t.status !== "done" && t.status !== "ignored" && (t.pending ?? []).length);

export function busyReason(s: Schedule): string | undefined {
  if (s.executor === "friday") return s.conversationId && isRunning(s.conversationId) ? "上一轮还在生成" : undefined;
  if (s.executor !== "project") return undefined;
  const last = getTask((s.mode === "continue" ? s.anchorTaskId : s.lastRef) ?? "");
  if (hasPending(last)) return "上一轮的交付还等你处理";
  if (!s.attended && runningJob(last)) return "上一轮还在跑";
  return undefined;
}

async function fireProject(s: Schedule): Promise<Fired> {
  const r = resolveProject(s.project ?? "");
  if (r.kind !== "match") return { ok: false, result: `找不到项目「${s.project ?? ""}」，去项目注册表看看是不是改名了` };
  let task: Task | undefined;
  let detail = s.prompt ?? "";
  if (s.mode === "continue") {
    task = s.anchorTaskId ? getTask(s.anchorTaskId) : undefined;
    if (task?.report?.at) pushHistory(s.id, { at: task.report.at, summary: task.report.summary });
    // 无人值守不能接回交互式会话：那样活会被敲进交互式 Claude，没有自主提示词、永不退出
    if (task && (task.status === "done" || task.status === "ignored")) task = (await reopenTask(task.id, { revive: s.attended }))?.task;
    const history = getSchedule(s.id)?.history ?? [];
    if (history.length) detail += `\n\n上几轮做过的（别重复做）：\n${history.map((h) => `- ${h.at.slice(0, 10)}：${h.summary}`).join("\n")}`;
  }
  if (!task) {
    task = createTask({ title: `[定时] ${s.title}`, kind: "code", project: r.project.name, status: "understood", ...(s.prompt ? { understanding: s.prompt } : {}), source: { scheduleId: s.id } });
    if (s.mode === "continue") updateSchedule(s.id, { anchorTaskId: task.id });
  }
  const t = s.attended
    ? await startInteractiveJob(task, r.project.name, r.project.dir, detail)
    : await startAutonomousJob(task, r.project.name, r.project.dir, detail, "schedule");
  if (s.attended) state.notices.push({ title: "到点了", body: `已在 ${r.project.name} 开好终端：${s.title}`, taskId: t.id });
  return { ok: true, result: s.attended ? "终端已开好，等你接手" : "已开工，干完交审", ref: t.id };
}

function fireFriday(s: Schedule): Fired {
  let conv = s.mode === "continue" ? s.conversationId : undefined;
  if (!conv) {
    conv = createConversation().id;
    renameConversation(conv, s.title);
    updateSchedule(s.id, { conversationId: conv });
  }
  const prefs = userSettings();
  const session = claudeSessionId(conv);
  const resume = session && existsSync(transcriptPath(config.dataDir, session)) ? session : undefined;
  startRun(conv, s.prompt ?? "", {
    systemPrompt: `${friday(loadMemoryContext(), prefs.skills)}\n\n${SCHEDULE_NOTE(s.title)}`,
    cwd: config.dataDir,
    skills: prefs.skills,
    skillList: prefs.skillList,
    web: true,
    label: "schedule",
    ...(resume ? { resume } : {}),
    ...(prefs.model ? { model: prefs.model } : {}),
  });
  let answer = "";
  let error = "";
  const off = subscribe(conv, (ev) => {
    if (ev.type === "delta") answer += ev.text;
    if (ev.type === "reset") answer = "";
    if (ev.type === "error") error = ev.message;
    if (ev.type !== "done") return;
    off?.();
    const first = answer.trim().split("\n").find((l) => l.trim())?.slice(0, 80);
    state.notices.push({ title: s.title, body: first ?? (error ? `出错了：${error.slice(0, 120)}` : "（没有回答）") });
  });
  return { ok: true, result: "Friday 在跑，结果写进这段会话", ref: conv };
}

async function fireCall(s: Schedule): Promise<Fired> {
  const args = s.args ?? {};
  if (s.server === "friday") {
    const def = fridayToolList().find((t) => t.name === s.tool);
    if (!def) return { ok: false, result: `Friday 没有 ${s.tool} 这个工具` };
    const parsed = z.object(def.inputSchema as z.ZodRawShape).safeParse(args);
    if (!parsed.success) return { ok: false, result: `参数不对：${parsed.error.message.slice(0, 300)}` };
    const r = await def.handler(parsed.data as never, {});
    const text = r.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
    return { ok: !r.isError, result: text };
  }
  const r = await callTool(s.server ?? "", s.tool ?? "", args);
  return { ok: !r.isError, result: r.text };
}

export async function fireSchedule(s: Schedule, why: "due" | "manual"): Promise<Fired> {
  let out: Fired;
  try {
    out = s.executor === "project" ? await fireProject(s) : s.executor === "friday" ? fireFriday(s) : await fireCall(s);
  } catch (e) {
    out = { ok: false, result: e instanceof Error ? e.message : String(e) };
  }
  record({
    ...(s.executor === "project" && out.ref ? { taskId: out.ref } : {}),
    action: "schedule_fired",
    why: why === "due" ? `定时任务「${s.title}」到点了` : `你点了「现在跑一次」：${s.title}`,
    how: out.result.slice(0, 200),
    evidence: { scheduleId: s.id, executor: s.executor, ref: out.ref ?? null },
    risk: "reversible",
    status: out.ok ? "done" : "failed",
  });
  if (!out.ok) state.notices.push({ title: `定时任务没跑成 · ${s.title}`, body: out.result.slice(0, 200) });
  return out;
}
