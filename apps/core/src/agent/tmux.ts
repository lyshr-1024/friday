import { execFile } from "node:child_process";
import { accessSync, constants, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { config } from "../config.js";

const execFileP = promisify(execFile);

// 开发验收可以换一个 socket，和你正在用的会话完全隔开
export const TMUX_SOCKET = process.env.FRIDAY_TMUX_SOCKET || "friday";

export const TMUX_CONF = [
  "set -g prefix None",
  "unbind C-b",
  "set -g mouse on",
  "set -g history-limit 50000",
  "set -g status off",
  'set -g default-terminal "tmux-256color"',
  'set -ga terminal-overrides ",xterm-256color:Tc"',
  "set -s escape-time 0",
  "set -g focus-events on",
  "set -g allow-passthrough on",
  "set -g set-clipboard on",
  "set -g window-size latest",
  "set -g remain-on-exit off",
  "",
].join("\n");

export const tmuxConfPath = (): string => join(config.dataDir, "tmux.conf");

export function writeTmuxConf(): void {
  writeFileSync(tmuxConfPath(), TMUX_CONF);
}

export const tmuxArgs = (...args: string[]): string[] => ["-L", TMUX_SOCKET, "-f", tmuxConfPath(), ...args];

const TMUX_FALLBACKS = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux"];

const executable = (p: string): boolean => {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export function findTmux(pathEnv: string | undefined, isExec: (p: string) => boolean = executable): string | undefined {
  const fromPath = (pathEnv ?? "").split(":").filter(Boolean).map((d) => join(d, "tmux"));
  return [...fromPath, ...TMUX_FALLBACKS].find(isExec);
}

let resolvedTmux: string | undefined | null = null;
export const tmuxPath = (): string | undefined => (resolvedTmux === null ? (resolvedTmux = findTmux(process.env.PATH)) : resolvedTmux);
export function setTmuxPath(p: string | undefined): void {
  resolvedTmux = p;
}

type Runner = (args: string[]) => Promise<string>;
let runner: Runner = async (args) => {
  const bin = tmuxPath();
  if (!bin) throw new TmuxMissingError();
  return (await execFileP(bin, args, { timeout: 5_000 })).stdout;
};

export function setTmuxRunner(fn: Runner): void {
  runner = fn;
}

const run = (...args: string[]) => runner(tmuxArgs(...args));
const S = (name: string) => `=${name}`;
const W = (name: string, index?: number) => `=${name}:${index ?? ""}`;

export class TmuxMissingError extends Error {
  constructor() {
    super("内嵌终端需要 tmux：brew install tmux");
  }
}

export const safeName = (s: string): string =>
  s.replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 80);

export function sessionName(repoDir: string, suffix: string): string {
  const repo = repoDir.replace(/\/+$/, "").split("/").pop() || "repo";
  return safeName(`${repo}-${suffix}`);
}

export async function tmuxVersion(): Promise<string | undefined> {
  try {
    return (await runner(["-V"])).trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function hasSession(name: string): Promise<boolean> {
  try {
    await run("has-session", "-t", S(name));
    return true;
  } catch {
    return false;
  }
}

export async function listSessionNames(): Promise<string[] | undefined> {
  try {
    return (await run("list-sessions", "-F", "#{session_name}")).split("\n").map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    const msg = `${(e as { stderr?: string }).stderr ?? ""} ${(e as Error).message}`;
    return /no server running|error connecting to .*\(No such file or directory\)/.test(msg) ? [] : undefined;
  }
}

export async function newSession(name: string, cwd: string, script: string, window = "claude"): Promise<void> {
  await run("new-session", "-d", "-s", name, "-n", window, "-c", cwd, "-x", "200", "-y", "50", "/bin/zsh", script);
}

export async function renameSession(from: string, to: string): Promise<boolean> {
  try {
    await run("rename-session", "-t", S(from), to);
    return true;
  } catch {
    return false;
  }
}

export async function killSession(name: string): Promise<void> {
  await run("kill-session", "-t", S(name)).catch(() => "");
}

const ENTER_DELAY_MS = 200;

export async function sendText(name: string, text: string, windowIndex?: number): Promise<void> {
  await run("send-keys", "-t", W(name, windowIndex), "-l", text);
  await new Promise((r) => setTimeout(r, ENTER_DELAY_MS));
  await run("send-keys", "-t", W(name, windowIndex), "Enter");
}

// 往 shell 提示符里敲命令前先 C-u 清空输入行：残留的按键会拼到命令前面（2026-10-13 实测成了 `c/bin/zsh …`）。别用在 Claude 里，会删掉你写了一半的话
export async function sendCommand(name: string, command: string, windowIndex?: number): Promise<void> {
  await run("send-keys", "-t", W(name, windowIndex), "C-u");
  await sendText(name, command, windowIndex);
}

type PsRunner = () => Promise<string>;
let psRunner: PsRunner = async () => (await execFileP("/bin/ps", ["-A", "-o", "pid=,ppid=,args="], { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 })).stdout;

export function setPsRunner(fn: PsRunner): void {
  psRunner = fn;
}

const CLAUDE_ARGS = /(^|\/)claude(\s|$)|claude-code\/cli/;

/**
 * 窗口里还有没有 Claude 在跑：看窗格进程的子孙里有没有 claude。`pane_current_command` 在 Claude 跑着时也报 zsh，靠不住。
 * 判断不了（tmux / ps 出错、找不到窗格）返回 undefined，调用方按「还在」处理。
 */
export async function claudeAlive(name: string, windowIndex?: number): Promise<boolean | undefined> {
  try {
    const roots = (await run("list-panes", "-t", W(name, windowIndex), "-F", "#{pane_pid}")).split("\n").map((s) => s.trim()).filter(Boolean);
    if (!roots.length) return undefined;
    const children = new Map<string, Array<{ pid: string; args: string }>>();
    for (const line of (await psRunner()).split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (m) children.set(m[2]!, [...(children.get(m[2]!) ?? []), { pid: m[1]!, args: m[3]! }]);
    }
    const stack = [...roots];
    while (stack.length) {
      for (const c of children.get(stack.pop()!) ?? []) {
        if (CLAUDE_ARGS.test(c.args)) return true;
        stack.push(c.pid);
      }
    }
    return false;
  } catch {
    return undefined;
  }
}

export async function claudeWindowIndex(name: string): Promise<number | undefined> {
  try {
    const idx = (await listWindows(name)).filter((w) => w.name === "claude").map((w) => w.index);
    return idx.length ? Math.min(...idx) : undefined;
  } catch {
    return undefined;
  }
}

export interface TmuxWindow {
  index: number;
  name: string;
  active: boolean;
}

export async function listWindows(name: string): Promise<TmuxWindow[]> {
  const out = await run("list-windows", "-t", S(name), "-F", "#{window_index}|#{window_name}|#{window_active}");
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [i, n, a] = l.split("|");
      return { index: Number(i), name: n ?? "", active: a === "1" };
    });
}

export async function newWindow(name: string, cwd: string): Promise<void> {
  await run("new-window", "-t", W(name), "-c", cwd);
}

export async function killWindow(name: string, index: number): Promise<boolean> {
  if ((await listWindows(name)).length <= 1) return false;
  await run("kill-window", "-t", W(name, index));
  return true;
}

export async function selectWindow(name: string, index: number): Promise<void> {
  await run("select-window", "-t", W(name, index));
}

export async function splitWindow(name: string, cwd: string, dir: "h" | "v"): Promise<void> {
  await run("split-window", dir === "h" ? "-h" : "-v", "-t", W(name), "-c", cwd);
}

export async function searchBack(name: string, q: string): Promise<void> {
  await run("copy-mode", "-t", W(name));
  await run("send-keys", "-t", W(name), "-X", "search-backward", q);
}

export async function clearHistory(name: string): Promise<void> {
  await run("send-keys", "-t", W(name), "C-l");
  await run("clear-history", "-t", W(name));
}
