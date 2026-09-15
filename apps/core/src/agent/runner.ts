import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { config } from "../config.js";
import type { TerminalApp } from "../settings.js";
import { getSession, spawnSession } from "./pty.js";
import { getJob } from "../memory/jobs.js";
import { terminalBridgePrompt } from "./prompt.js";
import { FORBIDDEN } from "./guard.js";
import { UNTRUSTED_NOTE } from "./fence.js";

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
    "1. 先 git status 确认工作区，然后新建分支再改，不要动 main / master，不要 push，不要 merge。",
    "   分支名按项目规范起，用英文小写加连字符，要能看出在做什么：",
    "   新功能用 feat/<topic>，修缺陷用 fix/<bug>，杂活或样式用 chore/<topic> 或 style/<topic>。",
    "   例如 feat/export-center、fix/withdrawal-rule-tabs、style/task-card-spacing。",
    "   起好后第一时间调 friday_progress 把分支名告诉 Friday（写成「在分支 xxx 上开工」）。",
    "   push、merge、rebase、reset --hard 会被 Friday 的守卫直接拒绝，不用试。",
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
    UNTRUSTED_NOTE,
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
    const { transcript_path, last_assistant_message, session_id, hook_event_name, source, tool_name, tool_input, message, notification_type } = JSON.parse(input);
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
    if (!text && !session_id && !tool_name && !message) { console.error("nothing to post"); return; }
    fetch("http://127.0.0.1:${port}/jobs/${id}/message", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...(text ? { text } : {}), ...(session_id ? { sessionId: session_id } : {}), ...(hook_event_name ? { event: hook_event_name } : {}), ...(source ? { source } : {}), ...(tool_name ? { toolName: tool_name } : {}), ...(tool_input ? { toolInput: JSON.stringify(tool_input).slice(0, 4000) } : {}), ...(message ? { message: String(message).slice(0, 1000) } : {}), ...(notification_type ? { notificationType: notification_type } : {}) }) })
      .then((r) => console.error("posted", r.status))
      .catch((e) => console.error("post failed", e.message));
  } catch (e) { console.error("hook error", e.message); }
});`)}`,
    "",
  ].join("\n");
}

/** SessionStart 一开始就把 session id 回传，不然 Claude 第一轮没说完 Friday 就重启，这条任务就再也接不上了；Stop 每轮回传最后一段回答。 */
export function buildHookSettings(hookScript: string, guardScript?: string): string {
  const hook = [{ hooks: [{ type: "command", command: shellQuote(hookScript), timeout: 10 }] }];
  // 交互式提问（选项题 / plan 确认）不会发 Stop，PTY 也安静，不接这两个 hook 就感知不到它在等人
  const asking = [{ matcher: "AskUserQuestion|ExitPlanMode", hooks: hook[0]!.hooks }];
  // 自主任务多挂一条 Bash 守卫；settings 的 permissions.deny 在 --dangerously-skip-permissions 下不生效，hook 生效
  const guard = guardScript ? [{ matcher: "Bash", hooks: [{ type: "command", command: shellQuote(guardScript), timeout: 10 }] }] : [];
  return JSON.stringify({ hooks: { SessionStart: hook, Stop: hook, PreToolUse: [...guard, ...asking], PostToolUse: asking, Notification: hook } }, null, 2);
}

// 用 script 录下整个终端会话，退出时把退出码回报给 Friday；claude 用绝对路径避开别名，Friday 只透传用户指令所以跳过权限确认。
// 见 pty.ts cleanEnv：Ghostty / Terminal 由 open 拉起同样会继承这些变量
const UNSET_CLAUDE_ENV = "unset CLAUDECODE CLAUDE_PID $(env | sed -n 's/^\\(CLAUDE_CODE_[A-Z_]*\\)=.*/\\1/p') 2>/dev/null";

/** Claude Code 的 transcript 放在 ~/.claude/projects/<cwd 里所有非字母数字换成 ->/<session>.jsonl */
export function transcriptPath(dir: string, sessionId: string): string {
  return join(homedir(), ".claude", "projects", dir.replace(/[^A-Za-z0-9]/g, "-"), `${sessionId}.jsonl`);
}

export function buildScript(req: LaunchRequest, claudePath: string, port: number, files: ClaudeFiles): string {
  const flags = claudeFlags(files, req.autonomous);
  const claude = `${shellQuote(claudePath)} ${flags}${req.task ? ` ${shellQuote(req.task)}` : ""}`;
  return [
    "#!/bin/zsh",
    // Ghostty 用 open -na 启动时偶发新旧实例各执行一次，用原子 mkdir 锁保证任务只跑一份，多出来的 tab 直接退出。
    `mkdir ${shellQuote(`${jobLog(req.id)}.lock`)} 2>/dev/null || exit 0`,
    `cd ${shellQuote(req.dir)} || exit 1`,
    UNSET_CLAUDE_ENV,
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

/** 写 Stop hook 脚本与 --settings 文件；每次启动/重开都重写，保证用的是当前版本的 hook。 */
/**
 * 自主任务的 PreToolUse 守卫：每条 Bash 命令过一遍 guard.ts 的黑名单，命中就 deny。
 * settings 里的 permissions.deny 在 --dangerously-skip-permissions 下不生效，hook 生效。
 */
export function buildGuardScript(nodePath = process.execPath): string {
  return [
    "#!/bin/zsh",
    `${shellQuote(nodePath)} -e ${shellQuote(`
const rules = ${JSON.stringify(FORBIDDEN)};
let input = "";
let done = false;
const decide = () => {
  if (done) return;
  done = true;
  let cmd = "";
  try { cmd = String((JSON.parse(input).tool_input || {}).command || ""); } catch {}
  const hit = rules.find(([p]) => new RegExp(p).test(cmd));
  process.stdout.write(
    hit
      ? JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Friday 自主任务禁止这条命令（" + hit[1] + "）。换个做法，或在交付报告里写明卡在这里。" } })
      : "{}",
  );
};
process.stdin.on("data", (d) => (input += d)).on("end", decide);
setTimeout(decide, 2000).unref();`)}`,
    "",
  ].join("\n");
}

export interface ClaudeFiles {
  settings: string;
  mcp: string;
}

/** 终端 Claude Code 的 MCP 配置：一个 http 服务指回 Friday，按 jobId 绑任务。 */
export function buildMcpConfig(id: string, port: number): string {
  return JSON.stringify({ mcpServers: { friday: { type: "http", url: `http://127.0.0.1:${port}/mcp/${id}` } } }, null, 2);
}

function writeHookFiles(id: string, autonomous = false): ClaudeFiles {
  mkdirSync(runsDir(), { recursive: true });
  const hook = join(runsDir(), `${id}.hook.sh`);
  writeFileSync(hook, buildHookScript(id, config.port));
  chmodSync(hook, 0o755);
  let guard: string | undefined;
  if (autonomous) {
    guard = join(runsDir(), `${id}.guard.sh`);
    writeFileSync(guard, buildGuardScript());
    chmodSync(guard, 0o755);
  }
  const settings = join(runsDir(), `${id}.settings.json`);
  writeFileSync(settings, buildHookSettings(hook, guard));
  const mcp = join(runsDir(), `${id}.mcp.json`);
  writeFileSync(mcp, buildMcpConfig(id, config.port));
  return { settings, mcp };
}

/** 每次拉起 claude 都带：跳过权限（Friday 只透传用户指令）、hook、指回 Friday 的 MCP、怎么汇报的系统提示。 */
export function claudeFlags(files: ClaudeFiles, autonomous = false): string {
  return [
    ...(autonomous ? ["-p"] : []),
    "--dangerously-skip-permissions",
    "--settings",
    shellQuote(files.settings),
    "--mcp-config",
    shellQuote(files.mcp),
    "--append-system-prompt",
    shellQuote(terminalBridgePrompt()),
  ].join(" ");
}

export async function launchClaude(req: LaunchRequest): Promise<string> {
  const claudePath = await findClaude();
  const files = writeHookFiles(req.id, req.autonomous);

  const ext = req.terminal === "terminal" ? ".command" : ".sh";
  const script = join(runsDir(), `${req.id}${ext}`);
  writeFileSync(script, buildScript(req, claudePath, config.port, files));
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

/** 终端随 Friday 重启一起没了：在同一目录重开一个 PTY，用 --resume 接上这条任务自己的 Claude 会话（id 来自 Stop hook），并把旧日志尾部回放出来。 */
export async function reopenClaude(jobId: string): Promise<"alive" | "reopened" | "no-job"> {
  const live = getSession(jobId);
  if (live && live.exited === undefined) return "alive";
  const job = getJob(jobId);
  if (!job) return "no-job";
  const claudePath = await findClaude();
  const flags = claudeFlags(writeHookFiles(jobId));
  // 有 id 就先试 --resume（transcript 可能刚建还没落盘，交给 claude 自己判断），失败再新开
  const resumable = Boolean(job.claudeSessionId);
  const hasTranscript = resumable && existsSync(transcriptPath(job.dir, job.claudeSessionId!));
  const script = join(runsDir(), `${jobId}.reopen.sh`);
  const fresh = `这是任务「${(job.task ?? job.project).slice(0, 200)}」的终端，之前的会话记录没保存下来。先不要动手，等我指示。`;
  writeFileSync(
    script,
    [
      "#!/bin/zsh",
      `cd ${shellQuote(job.dir)} || exit 1`,
      UNSET_CLAUDE_ENV,
      `printf '\\033]0;Friday · %s\\007' ${shellQuote(job.dir.split("/").pop() ?? "")}`,
      resumable
        ? `printf '\\033[2m[Friday 重启过，用 --resume 接上这条任务的 Claude 会话${hasTranscript ? "" : "（记录可能还没落盘，接不上就新开）"}]\\033[0m\\n'`
        : `printf '\\033[2m[Friday 重启过，这条任务没有记录到会话 id，开一个新会话]\\033[0m\\n'`,
      resumable
        ? `${shellQuote(claudePath)} ${flags} --resume ${shellQuote(job.claudeSessionId!)} || ${shellQuote(claudePath)} ${flags} ${shellQuote(fresh)}`
        : `${shellQuote(claudePath)} ${flags} ${shellQuote(fresh)}`,
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
