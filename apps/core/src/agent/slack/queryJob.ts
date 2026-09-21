import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import type { InboxItem, Task } from "@friday/shared";
import { record } from "../../memory/audit.js";
import { conversationKey, slackNode, taskNode } from "../../memory/infer.js";
import { createJob } from "../../memory/jobs.js";
import { linkUp } from "../../memory/links.js";
import { loadProjects } from "../../memory/projects.js";
import { createTask, updateTask } from "../../memory/tasks.js";
import { cleanEnv } from "../env.js";
import { UNTRUSTED_NOTE, untrusted } from "../fence.js";
import { claudeArgs, findClaude, jobLog, reportPath, writeHookFiles } from "../runner.js";

export function queryJobPrompt(id: string, ask: string, projects: Array<{ name: string; dir: string }>, asker: string): string {
  const multi = projects.length > 1;
  return [
    `${asker} 在 Slack 上问了一个问题，你去代码里找答案。这是一个**只读**任务：只查不改。`,
    `问题：${untrusted("slack", ask)}`,
    "",
    multi
      ? `这个问题没判出属于哪个项目，你面前有这几个：\n${projects.map((p) => `- ${p.name}（${p.dir}）`).join("\n")}\n先判断问的是哪个，再深入那一个。`
      : `项目：${projects[0]!.name}（${projects[0]!.dir}）`,
    "",
    "规则：",
    "1. **不要修改任何文件**，不要建分支、不要提交。改文件的工具会被守卫直接拒绝。",
    "2. 结论必须有依据：给出文件路径和行号，别凭印象答。",
    "3. 查不到就说查不到，不要编。",
    "4. 不要问用户问题——没人在终端前，问了会一直卡着。",
    `5. 把结果写到 ${reportPath(id)}，严格用下面的结构：`,
    "## 概要",
    "一句话说清答案。",
    "## 依据",
    "- 每条一行：文件路径:行号 — 说明",
    "## 回复草稿",
    "一句 20 到 80 字、口语化、可以直接发给对方的中文回复。只写这一句，不要加解释。",
    UNTRUSTED_NOTE,
  ].join("\n");
}

/** 建一条「Friday 在做」的查询任务，起只读终端去查 */
export async function startQueryJob(item: InboxItem, ask: string, project?: string): Promise<Task | undefined> {
  const all = loadProjects();
  const picked = project ? all.filter((p) => p.name === project) : all;
  if (!picked.length) return undefined;

  const conv = conversationKey(item);
  const task = createTask({
    title: `回答 ${item.userName}：${ask.slice(0, 40)}`,
    kind: "slack",
    source: { conversation: conv, channelId: item.channelId, userName: item.userName, ...(item.threadTs ? { threadTs: item.threadTs } : {}) },
    ...(project ? { project } : {}),
    status: "processing",
    understanding: `${item.userName} 在 ${item.channelName} 问：${item.text}`,
  });
  linkUp(slackNode(conv), taskNode(task.id), "rule", `Friday 接了这个问题去查代码`);

  const id = randomUUID();
  const dir = picked[0]!.dir;
  const prompt = queryJobPrompt(id, ask, picked.map((p) => ({ name: p.name, dir: p.dir })), item.userName);
  createJob({ id, project: picked[0]!.name, dir, task: ask.slice(0, 500), logPath: jobLog(id), taskId: task.id });
  spawnHeadless(id, dir, prompt);

  record({
    taskId: task.id,
    action: "slack_query_start",
    why: `${item.userName} 问了一个读代码就能答的问题`,
    how: `在 ${picked.map((p) => p.name).join(" / ")} 里只读查找（后台跑，不弹窗口）`,
    evidence: { jobId: id, conversation: conv, ask },
    risk: "read",
  });

  return updateTask(task.id, { source: { ...task.source, jobId: id, headless: true }, progress: "Friday 正在代码里找答案" });
}

/**
 * 后台跑一个只读的 claude -p：不开终端窗口，输出落日志文件。
 * 没有终端脚本替它回报退出码，所以进程退出时自己调 onJobExit。
 */
export function spawnHeadless(id: string, dir: string, prompt: string): void {
  void (async () => {
    const claudePath = await findClaude();
    const files = writeHookFiles(id, false, true);
    const log = createWriteStream(jobLog(id), { flags: "a" });
    const child = spawn(claudePath, [...claudeArgs(files, true), prompt], {
      cwd: dir,
      env: cleanEnv(process.env),
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    child.on("exit", (code) => {
      log.end();
      void import("../pipeline.js").then((m) => m.onJobExit(id, code ?? -1));
    });
    child.on("error", (e) => {
      log.end();
      console.error(`[slack-query] ${id} 起不来：${e.message}`);
      void import("../pipeline.js").then((m) => m.onJobExit(id, -1));
    });
  })();
}
