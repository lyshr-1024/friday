import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { config } from "../config.js";

const execFileP = promisify(execFile);

export const TMUX_SOCKET = "friday";

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

type Runner = (args: string[]) => Promise<string>;
let runner: Runner = async (args) => (await execFileP("tmux", args, { timeout: 5_000 })).stdout;

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
    return /no server running|error connecting/.test(msg) ? [] : undefined;
  }
}

export async function newSession(name: string, cwd: string, script: string): Promise<void> {
  await run("new-session", "-d", "-s", name, "-n", "claude", "-c", cwd, "-x", "200", "-y", "50", "/bin/zsh", script);
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

export async function sendText(name: string, text: string): Promise<void> {
  await run("send-keys", "-t", W(name), "-l", text);
  await new Promise((r) => setTimeout(r, ENTER_DELAY_MS));
  await run("send-keys", "-t", W(name), "Enter");
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
