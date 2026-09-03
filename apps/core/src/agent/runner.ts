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

// 用绝对路径而不是 `claude`，避开用户 .zshrc 里可能带 --dangerously-skip-permissions 的别名。
export function buildScript(req: LaunchRequest, claudePath: string): string {
  const claude = req.task ? `${shellQuote(claudePath)} ${shellQuote(req.task)}` : shellQuote(claudePath);
  return [
    "#!/bin/zsh",
    `cd ${shellQuote(req.dir)} || exit 1`,
    `printf '\\033]0;Friday · %s\\007' ${shellQuote(req.dir.split("/").pop() ?? "")}`,
    claude,
    "exec /bin/zsh -il",
    "",
  ].join("\n");
}

export async function launchClaude(req: LaunchRequest): Promise<string> {
  const claudePath = await findClaude();
  const runsDir = join(config.dataDir, "runs");
  mkdirSync(runsDir, { recursive: true });
  const ext = req.terminal === "terminal" ? ".command" : ".sh";
  const script = join(runsDir, `${req.id}${ext}`);
  writeFileSync(script, buildScript(req, claudePath));
  chmodSync(script, 0o755);

  const args =
    req.terminal === "terminal"
      ? ["-a", "Terminal", script]
      : ["-na", "Ghostty", "--args", `--working-directory=${req.dir}`, "-e", script];
  await execFileP("/usr/bin/open", args);
  return script;
}
