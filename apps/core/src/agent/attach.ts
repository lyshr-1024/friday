import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { cleanEnv } from "./env.js";
import { tmuxArgs, tmuxPath } from "./tmux.js";

export interface PtyLike {
  onData(fn: (d: string) => void): { dispose(): void };
  onExit(fn: () => void): { dispose(): void };
  write(d: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}
export type PtySpawner = (file: string, args: string[], opts: { cols: number; rows: number; env: Record<string, string> }) => PtyLike;

export class AttachError extends Error {}

let spawner: PtySpawner = (file, args, opts) => {
  accessSync(file, constants.X_OK);
  // esbuild 不打包原生模块，运行时 require
  const pty = createRequire(import.meta.url)("node-pty") as typeof import("node-pty");
  return pty.spawn(file, args, { name: "xterm-256color", ...opts });
};
export function setPtySpawner(fn: PtySpawner): void {
  spawner = fn;
}

interface Viewer { sessionId: string; pty: PtyLike; listeners: Set<(d: string) => void>; enders: Set<() => void>; backlog: string; idleTimer?: NodeJS.Timeout }
const UNSUBSCRIBED_TTL_MS = 15_000;
const viewers = new Map<string, Viewer>();

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)));

const BREAKER_FAILS = 3;
const BREAKER_COOLDOWN_MS = 60_000;
let spawnFails = 0;
let breakerUntil = 0;
export function resetAttachBreaker(): void {
  spawnFails = 0;
  breakerUntil = 0;
}

export function attach(sessionId: string, tmuxName: string, cols: number, rows: number): string {
  if (Date.now() < breakerUntil) throw new AttachError("终端连续拉起失败，已暂停 60 秒");
  const id = randomUUID();
  const env = { ...cleanEnv(process.env), TERM: "xterm-256color", COLORTERM: "truecolor", LANG: process.env.LANG ?? "zh_CN.UTF-8" } as Record<string, string>;
  let pty: PtyLike;
  try {
    const bin = tmuxPath();
    if (!bin) throw new Error("找不到 tmux：brew install tmux");
    pty = spawner(bin, tmuxArgs("attach-session", "-t", `=${tmuxName}`), { cols: clamp(cols, 20, 400), rows: clamp(rows, 5, 200), env });
  } catch (e) {
    if (++spawnFails >= BREAKER_FAILS) breakerUntil = Date.now() + BREAKER_COOLDOWN_MS;
    throw new AttachError(`拉起 tmux 失败：${(e as Error).message}`);
  }
  spawnFails = 0;
  const v: Viewer = { sessionId, pty, listeners: new Set(), enders: new Set(), backlog: "" };
  // tmux 一接上就整屏重绘，那时 /stream 还没来订阅；丢了这一帧，之后的增量画面全是错位的
  pty.onData((d) => { if (v.listeners.size) v.listeners.forEach((l) => l(d)); else v.backlog += d; });
  pty.onExit(() => {
    clearTimeout(v.idleTimer);
    v.listeners.forEach((l) => l("\r\n"));
    viewers.delete(id);
    v.enders.forEach((e) => e());
  });
  viewers.set(id, v);
  v.idleTimer = setTimeout(() => detach(id), UNSUBSCRIBED_TTL_MS);
  v.idleTimer.unref();
  return id;
}

export function viewerSession(attachId: string): string | undefined {
  return viewers.get(attachId)?.sessionId;
}

export function subscribe(attachId: string, fn: (d: string) => void, onEnd?: () => void): (() => void) | undefined {
  const v = viewers.get(attachId);
  if (!v) return undefined;
  clearTimeout(v.idleTimer);
  v.listeners.add(fn);
  if (onEnd) v.enders.add(onEnd);
  if (v.backlog) { fn(v.backlog); v.backlog = ""; }
  return () => {
    v.listeners.delete(fn);
    if (onEnd) v.enders.delete(onEnd);
    if (!v.listeners.size) detach(attachId);
  };
}

export function writeAttach(attachId: string, data: string): boolean {
  const v = viewers.get(attachId);
  if (!v) return false;
  v.pty.write(data);
  return true;
}

export function resizeAttach(attachId: string, cols: number, rows: number): boolean {
  const v = viewers.get(attachId);
  if (!v) return false;
  v.pty.resize(clamp(cols, 20, 400), clamp(rows, 5, 200));
  return true;
}

export function detach(attachId: string): void {
  const v = viewers.get(attachId);
  if (!v) return;
  viewers.delete(attachId);
  clearTimeout(v.idleTimer);
  v.pty.kill();
  v.enders.forEach((e) => e());
}

export function detachSession(sessionId: string): void {
  for (const [id, v] of viewers) if (v.sessionId === sessionId) detach(id);
}
