import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DeliveryReport, Job, Task } from "@friday/shared";
import { record } from "../memory/audit.js";
import { addMessage, conversationExists } from "../memory/conversations.js";
import { getJob, setJobMessage } from "../memory/jobs.js";
import { loadProjects } from "../memory/projects.js";
import { addPending, createTask, findTaskBySource, updateTask } from "../memory/tasks.js";
import { listThreads } from "../memory/threads.js";
import { state } from "../scheduler/index.js";
import { personNote } from "./enrich.js";

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
    description: "拿这条任务的背景：用户的理解与方案、交代的原话、Slack 原文、关联项目与人物、等用户点头的动作。开工前先调一次。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "friday_progress",
    description: "报一句阶段进展（不超过 200 字），用户在 Friday 的任务卡上实时看到。每完成一个阶段调一次，不要每步都调。",
    inputSchema: { type: "object", properties: { text: str("一句话进展") }, required: ["text"] },
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

export function contextFor(task: Task, job?: Job): string {
  const thread = task.source.threadId ? listThreads("all", 300).find((t) => t.id === task.source.threadId) : undefined;
  const project = loadProjects().find((p) => p.name === (task.project ?? job?.project));
  const person = thread ? personNote(thread.userName) : undefined;
  return [
    `任务：${task.title}（${task.status}，优先级 ${task.priority}）`,
    task.understanding ? `Friday 的理解：${task.understanding}` : "",
    task.plan ? `Friday 的方案：${task.plan}` : "",
    task.progress ? `目前进展：${task.progress}` : "",
    task.source.note ? `用户交代的原话：${task.source.note}` : "",
    task.source.url ? `用户给的链接：${task.source.url}` : "",
    task.source.meegleId ? `Meegle 工单：#${task.source.meegleId}${task.source.url ? "" : ""}` : "",
    thread ? `Slack 原文（${thread.channelName || "私聊"} · ${thread.userName}）：\n${thread.items.map((i) => `- ${i.userName}：${i.text}`).join("\n").slice(0, 2000)}` : "",
    project ? `项目：${project.name}，目录 ${project.dir}${project.aliases.length ? `，别名 ${project.aliases.join("、")}` : ""}${project.note ? `，说明：${project.note}` : ""}` : job ? `项目：${job.project}，目录 ${job.dir}` : "",
    person ? `人物：${thread!.userName} — ${person}` : "",
    task.pending?.length ? `等用户点头的动作：${task.pending.map((p) => p.label).join("、")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** 用户又给终端说话了（Friday 转达或直接打字）：上一轮的"等你看/卡住"标记清掉 */
export function clearAttention(jobId: string): void {
  const t = findTaskBySource((s) => s.jobId === jobId);
  if (t?.attention) updateTask(t.id, { attention: undefined });
}

export async function callBridge(jobId: string, name: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
  const job = getJob(jobId);
  if (!job) return { text: "Friday 这边找不到这个终端任务", isError: true };
  const task = taskFor(job);

  if (name === "friday_context") return { text: contextFor(task, job) };

  if (name === "friday_progress") {
    const text = String(args.text ?? "").trim().slice(0, 300);
    if (!text) return { text: "text 不能为空", isError: true };
    // 新一轮开始干活了，上一轮"等你看/卡住"的标记清掉
    updateTask(task.id, { progress: text, attention: undefined });
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
      return { text: "已交给用户看。任务是否算完成由用户决定，你等下一步指示即可；不要自己 merge。" };
    }
    let t = updateTask(task.id, { status: "review", report, progress: "终端里的 Claude Code 说做完了，等你验收" })!;
    if (branch.startsWith("friday/") && !(t.pending ?? []).some((p) => p.type === "git_merge")) {
      t = addPending(t.id, { type: "git_merge", label: `合并 ${branch}`, detail: `把 ${branch} 合并进主分支（不 push）`, payload: { dir: job.dir, branch } })!;
    }
    record({ taskId: t.id, action: "terminal_done", why: "终端里的 Claude Code 报告任务完成", how: "friday_done 交付报告", evidence: { jobId, summary: report.summary, testResult: report.testResult, branch }, risk: "read" });
    notify(t, job, "做完了，等你验收", report.summary, "finished");
    return { text: `已交付，用户会收到验收提醒。${branch.startsWith("friday/") ? `合并 ${branch} 已挂成待审核动作，不要自己 merge。` : ""}接下来等用户反馈即可。` };
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
