import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { config } from "../config.js";
import type { TerminalApp } from "../settings.js";

const execFileP = promisify(execFile);

export interface LaunchRequest {
  id: string;
  dir: string;
  task?: string;
  terminal: TerminalApp;
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
  const flags = ["--dangerously-skip-permissions", ...(settingsFile ? ["--settings", shellQuote(settingsFile)] : [])].join(" ");
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

  const args =
    req.terminal === "terminal"
      ? ["-a", "Terminal", script]
      : ["-na", "Ghostty", "--args", `--working-directory=${req.dir}`, "-e", script];
  await execFileP("/usr/bin/open", args);
  return script;
}

/** 把终端 app 带到前台。 */
export async function focusTerminal(terminal: TerminalApp): Promise<void> {
  await execFileP("/usr/bin/open", ["-a", terminal === "terminal" ? "Terminal" : "Ghostty"]);
}
