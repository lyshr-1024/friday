import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { config } from "../config.js";
import type { TerminalApp } from "../settings.js";
import { getSession, spawnSession } from "./pty.js";
import { getJob } from "../memory/jobs.js";

const execFileP = promisify(execFile);

export interface LaunchRequest {
  id: string;
  dir: string;
  task?: string;
  terminal: TerminalApp;
  /** 自主模式：claude -p 跑完即退，按交付报告约定产出 report.md 与截图 */
  autonomous?: boolean;
}

export const reportPath = (id: string) => join(runsDir(), `${id}.report.md`);
export const shotsDir = (id: string) => join(runsDir(), `${id}.shots`);

/** 自主任务的提示词：分支、测试、交付报告、截图，全部落在约定路径，Friday 事后解析进审核。 */
export function autonomousPrompt(id: string, task: string, project: string): string {
  return [
    `你在项目 ${project} 里替用户完成一项任务，用户事后只看交付报告审核，所以过程要可追溯。`,
    `任务：${task}`,
    "",
    "规则：",
    `1. 先 git status 确认工作区；新建分支 friday/${id.slice(0, 8)} 再改，不要动 main / master，不要 push，不要 merge。`,
    "2. 改完必须跑该项目的类型检查和测试（看 package.json / Makefile 决定命令），失败就修到通过；实在修不了在报告里写明。",
    `3. 如果改动涉及界面，用 agent-browser skill 打开对应页面截图，保存到目录 ${shotsDir(id)}/（png，文件名写清楚是哪个页面哪个状态），至少一张改动前后的对比。不是界面改动就不截图。`,
    `4. 最后把交付报告写到 ${reportPath(id)}，严格用下面的 Markdown 结构：`,
    "## 概要",
    "一句话说做了什么。",
    "## 改动",
    "- 每个文件一行：路径 — 改了什么",
    "## 测试",
    "- 每一步一行：跑了什么命令 / 做了什么操作 → 结果",
    "## 测试结果",
    "一句话：全部通过 / 哪些没过。",
    "## 请验证",
    "- 用户应该亲自确认的点，每行一条，写清楚打开哪里看什么。",
    "## 截图",
    "- 文件名 — 说明（没有就写 无）",
    "5. 全程不要问用户问题；拿不准就按最保守的方式做并在报告里写明。",
  ].join("\n");
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export async function findClaude(): Promise<string> {
  const { stdout } = await execFileP("/bin/zsh", ["-ilc", "whence -p claude"]).catch(() => ({ stdout: "" }));
  const path = stdout.trim().split("\n").pop() ?? "";
  if (!path.startsWith("/")) throw new Error("找不到 claude，请确认已安装 Claude Code 且在登录 shell 的 PATH 中");
  return path;
}

export const runsDir = () => join(config.dataDir, "runs");
export const jobLog = (id: string) => join(runsDir(), `${id}.log`);

/**
 * Stop hook：每轮回答结束，Claude Code 把 transcript 路径经 stdin 给这个脚本，
 * 脚本取最后一段 assistant 文本 POST 回 Friday，会话窗里的任务卡片就能显示终端里 Claude 刚说了什么。
 */
export function buildHookScript(id: string, port: number, nodePath = process.execPath): string {
  // Ghostty 由 open 拉起，环境里没有 nvm 的 PATH，所以 node 用 sidecar 自己的绝对路径；出错写到 <id>.hook.log。
  return [
    "#!/bin/zsh",
    `exec >>${shellQuote(join(runsDir(), `${id}.hook.log`))} 2>&1`,
    `${shellQuote(nodePath)} -e ${shellQuote(`
const fs = require("fs");
let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", () => {
  try {
    const { transcript_path, last_assistant_message } = JSON.parse(input);
    // Claude Code 2.1 起 Stop 事件直接给 last_assistant_message；老版本再回退到读 transcript。
    let text = (last_assistant_message || "").trim();
    if (!text && transcript_path && fs.existsSync(transcript_path)) {
      const lines = fs.readFileSync(transcript_path, "utf8").trim().split("\\n");
      for (let i = lines.length - 1; i >= 0 && !text; i--) {
        try {
          const row = JSON.parse(lines[i]);
          if (row.type !== "assistant") continue;
          const parts = (row.message && row.message.content) || [];
          text = parts.filter((p) => p.type === "text").map((p) => p.text).join("\\n").trim();
        } catch {}
      }
    }
    if (!text) { console.error("no assistant text"); return; }
    fetch("http://127.0.0.1:${port}/jobs/${id}/message", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) })
      .then((r) => console.error("posted", r.status))
      .catch((e) => console.error("post failed", e.message));
  } catch (e) { console.error("hook error", e.message); }
});`)}`,
    "",
  ].join("\n");
}

export function buildHookSettings(hookScript: string): string {
  return JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: shellQuote(hookScript), timeout: 10 }] }] } }, null, 2);
}

// 用 script 录下整个终端会话，退出时把退出码回报给 Friday；claude 用绝对路径避开别名，Friday 只透传用户指令所以跳过权限确认。
export function buildScript(req: LaunchRequest, claudePath: string, port: number, settingsFile?: string): string {
  const flags = [
    ...(req.autonomous ? ["-p"] : []),
    "--dangerously-skip-permissions",
    ...(settingsFile ? ["--settings", shellQuote(settingsFile)] : []),
  ].join(" ");
  const claude = `${shellQuote(claudePath)} ${flags}${req.task ? ` ${shellQuote(req.task)}` : ""}`;
  return [
    "#!/bin/zsh",
    // Ghostty 用 open -na 启动时偶发新旧实例各执行一次，用原子 mkdir 锁保证任务只跑一份，多出来的 tab 直接退出。
    `mkdir ${shellQuote(`${jobLog(req.id)}.lock`)} 2>/dev/null || exit 0`,
    `cd ${shellQuote(req.dir)} || exit 1`,
    `printf '\\033]0;Friday · %s\\007' ${shellQuote(req.dir.split("/").pop() ?? "")}`,
    `script -q ${shellQuote(jobLog(req.id))} /bin/zsh -c ${shellQuote(claude)}`,
    "code=$?",
    // Claude Code 被杀时可能没复位终端（鼠标追踪、备用屏幕等），这里强制复位，否则后面的 shell 会吐一屏鼠标事件。
    "printf '\\e[?1000l\\e[?1002l\\e[?1003l\\e[?1006l\\e[?2004l\\e[?1049l\\e[?25h\\e[0m'; stty sane 2>/dev/null",
    `curl -s -m 3 -X POST ${shellQuote(`http://127.0.0.1:${port}/jobs/${req.id}/exit`)} -H 'content-type: application/json' -d "{\\"code\\":$code}" >/dev/null 2>&1`,
    "exec /bin/zsh -il",
    "",
  ].join("\n");
}

export async function launchClaude(req: LaunchRequest): Promise<string> {
  const claudePath = await findClaude();
  mkdirSync(runsDir(), { recursive: true });
  const hook = join(runsDir(), `${req.id}.hook.sh`);
  writeFileSync(hook, buildHookScript(req.id, config.port));
  chmodSync(hook, 0o755);
  const settingsFile = join(runsDir(), `${req.id}.settings.json`);
  writeFileSync(settingsFile, buildHookSettings(hook));

  const ext = req.terminal === "terminal" ? ".command" : ".sh";
  const script = join(runsDir(), `${req.id}${ext}`);
  writeFileSync(script, buildScript(req, claudePath, config.port, settingsFile));
  chmodSync(script, 0o755);

  // 内嵌终端：sidecar 自己用 PTY 跑脚本，前端 xterm 接 /pty/:id/stream；上下文和任务绑在一起，不会串。
  if (req.terminal === "embedded") {
    spawnSession(req.id, script, req.dir);
    return script;
  }
  const args =
    req.terminal === "terminal"
      ? ["-a", "Terminal", script]
      : ["-na", "Ghostty", "--args", `--working-directory=${req.dir}`, "-e", script];
  await execFileP("/usr/bin/open", args);
  return script;
}

/** 把终端 app 带到前台。 */
export async function focusTerminal(terminal: TerminalApp): Promise<void> {
  if (terminal === "embedded") return;
  await execFileP("/usr/bin/open", ["-a", terminal === "terminal" ? "Terminal" : "Ghostty"]);
}

/** 终端随 Friday 重启一起没了：在同一目录重开一个 PTY，用 --continue 接上该目录最近的 Claude 会话，并把旧日志尾部回放出来。 */
export async function reopenClaude(jobId: string): Promise<"alive" | "reopened" | "no-job"> {
  const live = getSession(jobId);
  if (live && live.exited === undefined) return "alive";
  const job = getJob(jobId);
  if (!job) return "no-job";
  const claudePath = await findClaude();
  const settingsFile = join(runsDir(), `${jobId}.settings.json`);
  const flags = ["--dangerously-skip-permissions", ...(existsSync(settingsFile) ? ["--settings", shellQuote(settingsFile)] : [])].join(" ");
  const script = join(runsDir(), `${jobId}.reopen.sh`);
  writeFileSync(
    script,
    [
      "#!/bin/zsh",
      `cd ${shellQuote(job.dir)} || exit 1`,
      `printf '\\033]0;Friday · %s\\007' ${shellQuote(job.dir.split("/").pop() ?? "")}`,
      `printf '\\033[2m[Friday 重启过，接上这个目录最近的 Claude 会话]\\033[0m\\n'`,
      `${shellQuote(claudePath)} ${flags} --continue || ${shellQuote(claudePath)} ${flags}`,
      "printf '\\e[?1000l\\e[?1002l\\e[?1003l\\e[?1006l\\e[?2004l\\e[?1049l\\e[?25h\\e[0m'; stty sane 2>/dev/null",
      "exec /bin/zsh -il",
      "",
    ].join("\n"),
  );
  chmodSync(script, 0o755);
  let replay = "";
  const log = jobLog(jobId);
  if (existsSync(log)) {
    const size = statSync(log).size;
    const raw = readFileSync(log, "utf8");
    replay = (size > 60_000 ? raw.slice(-60_000) : raw) + "\r\n\x1b[2m—— 以上是重启前的输出 ——\x1b[0m\r\n";
  }
  spawnSession(jobId, script, job.dir, replay);
  return "reopened";
}
