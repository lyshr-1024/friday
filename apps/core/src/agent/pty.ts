import { createRequire } from "node:module";
import type { IPty } from "node-pty";

// esbuild 不打包原生模块，运行时 require；spawn-helper 需要可执行权限（bundle-core.sh 里 chmod）。
const nodePty = createRequire(import.meta.url)("node-pty") as typeof import("node-pty");

type Listener = (chunk: string) => void;

interface Session {
  id: string;
  pty: IPty;
  buffer: string;
  listeners: Set<Listener>;
  exited?: number;
  /** 最近一次输出的时间：Claude Code 干活时每 100ms 重绘，安静下来就是在等输入 */
  lastOutputAt?: number;
}

const MAX_BUFFER = 400_000;
const REPLAY_TAIL = 64_000;

/** Friday 若是从某个 Claude Code 会话里被拉起的，会继承 CLAUDECODE / CLAUDE_CODE_* 环境变量；带着它们跑 claude 会被当成子会话、不保存 transcript，重开时 --resume 就接不上。 */
export function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !(k === "CLAUDECODE" || k === "CLAUDE_PID" || k.startsWith("CLAUDE_CODE_"))));
}
const sessions = new Map<string, Session>();

/** 在 PTY 里跑任务脚本；输出留一份回放缓冲，前端随时接上都能看到之前的内容。 */
export function spawnSession(id: string, script: string, cwd: string, replay = ""): Session {
  const existing = sessions.get(id);
  if (existing && existing.exited === undefined) return existing;
  if (existing) sessions.delete(id);
  const pty = nodePty.spawn("/bin/zsh", [script], {
    name: "xterm-256color",
    cols: 120,
    rows: 34,
    cwd,
    env: { ...cleanEnv(process.env), TERM: "xterm-256color", COLORTERM: "truecolor", LANG: process.env.LANG ?? "zh_CN.UTF-8", FRIDAY_EMBEDDED: "1" } as Record<string, string>,
  });
  const s: Session = { id, pty, buffer: replay, listeners: new Set() };
  pty.onData((d) => {
    s.lastOutputAt = Date.now();
    s.buffer = (s.buffer + d).slice(-MAX_BUFFER);
    s.listeners.forEach((l) => l(d));
  });
  pty.onExit(({ exitCode }) => {
    s.exited = exitCode;
    const tail = `\r\n\x1b[2m[进程已退出，退出码 ${exitCode}]\x1b[0m\r\n`;
    s.buffer += tail;
    s.listeners.forEach((l) => l(tail));
  });
  sessions.set(id, s);
  return s;
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function listSessions(): Array<{ id: string; alive: boolean }> {
  return [...sessions.values()].map((s) => ({ id: s.id, alive: s.exited === undefined }));
}

export function write(id: string, data: string): boolean {
  const s = sessions.get(id);
  if (!s || s.exited !== undefined) return false;
  s.pty.write(data);
  return true;
}

export function resize(id: string, cols: number, rows: number): boolean {
  const s = sessions.get(id);
  if (!s || s.exited !== undefined) return false;
  s.pty.resize(Math.max(20, Math.min(400, cols)), Math.max(5, Math.min(200, rows)));
  return true;
}

export function kill(id: string): boolean {
  const s = sessions.get(id);
  if (!s) return false;
  if (s.exited === undefined) s.pty.kill();
  sessions.delete(id);
  return true;
}

export function subscribe(id: string, listener: Listener): (() => void) | undefined {
  const s = sessions.get(id);
  if (!s) return undefined;
  // 连上时只回放尾部：全屏 TUI 每次都整屏重绘，前面的内容没意义，回放太多反而卡一下
  if (s.buffer) listener(s.buffer.length > REPLAY_TAIL ? s.buffer.slice(-REPLAY_TAIL) : s.buffer);
  s.listeners.add(listener);
  return () => s.listeners.delete(listener);
}
