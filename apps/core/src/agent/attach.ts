import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { cleanEnv } from "./env.js";
import { tmuxArgs } from "./tmux.js";

export interface PtyLike {
  onData(fn: (d: string) => void): { dispose(): void };
  onExit(fn: () => void): { dispose(): void };
  write(d: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}
export type PtySpawner = (file: string, args: string[], opts: { cols: number; rows: number; env: Record<string, string> }) => PtyLike;

let spawner: PtySpawner = (file, args, opts) => {
  // esbuild 不打包原生模块，运行时 require
  const pty = createRequire(import.meta.url)("node-pty") as typeof import("node-pty");
  return pty.spawn(file, args, { name: "xterm-256color", ...opts });
};
export function setPtySpawner(fn: PtySpawner): void {
  spawner = fn;
}

interface Viewer { sessionId: string; pty: PtyLike; listeners: Set<(d: string) => void> }
const viewers = new Map<string, Viewer>();

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)));

export function attach(sessionId: string, tmuxName: string, cols: number, rows: number): string {
  const id = randomUUID();
  const env = { ...cleanEnv(process.env), TERM: "xterm-256color", COLORTERM: "truecolor", LANG: process.env.LANG ?? "zh_CN.UTF-8" } as Record<string, string>;
  const pty = spawner("tmux", tmuxArgs("attach-session", "-t", `=${tmuxName}`), { cols: clamp(cols, 20, 400), rows: clamp(rows, 5, 200), env });
  const v: Viewer = { sessionId, pty, listeners: new Set() };
  pty.onData((d) => v.listeners.forEach((l) => l(d)));
  pty.onExit(() => {
    v.listeners.forEach((l) => l("\r\n"));
    viewers.delete(id);
  });
  viewers.set(id, v);
  return id;
}

export function viewerSession(attachId: string): string | undefined {
  return viewers.get(attachId)?.sessionId;
}

export function subscribe(attachId: string, fn: (d: string) => void): (() => void) | undefined {
  const v = viewers.get(attachId);
  if (!v) return undefined;
  v.listeners.add(fn);
  return () => {
    v.listeners.delete(fn);
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
  v.pty.kill();
}
