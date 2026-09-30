import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { AttachError, attach, resizeAttach, subscribe, writeAttach } from "../agent/attach.js";
import { hasSession } from "../agent/tmux.js";
import { getTermSession } from "../memory/termSessions.js";
import { isLocalOrigin } from "./origin.js";

/** 测试用得上的最小连接接口：ws 的 WebSocket 天然满足 */
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number): void;
  on(event: "message", fn: (raw: unknown) => void): void;
  on(event: "close", fn: () => void): void;
}
const OPEN = 1;
const PING_MS = 15_000;

/**
 * 内嵌终端的一条连接：输出、按键、尺寸都走它。原来是「SSE 推输出 + 每个按键一次 POST」，
 * WebKit 里流式 fetch 中断后连接不一定马上释放，同一地址 6 条的上限被占满，新的输出流和按键就排队干等——
 * 画面卡住、打字没反应（2026-09-30 用户报）。WebSocket 不占那 6 条，断了双方都立刻知道。
 * 协议（JSON 文本帧）：下行 {d} 输出 / {ping} 心跳 / {gone | retry | fatal, error} 然后关；上行 {i} 按键 / {r:[cols, rows]} 尺寸。
 */
export async function onTerminal(ws: SocketLike, sessionId: string, cols: number, rows: number): Promise<void> {
  const bye = (msg: Record<string, unknown>, code: number) => {
    if (ws.readyState === OPEN) ws.send(JSON.stringify(msg));
    ws.close(code);
  };
  const s = getTermSession(sessionId);
  // 会话不在还拉 pty：tmux 打一行错误就退，前端当成连上了会无限重连、每次占一个 ptmx
  if (!s || s.status === "closed") return bye({ gone: true, error: "会话已不在" }, 4404);
  // 行没 closed 就只是暂时找不到（开始做会先 kill 同名会话、约一秒后才重建），真没了由对账标 closed
  if (!(await hasSession(s.tmuxName))) return bye({ retry: true, error: "会话还没起来" }, 4503);
  let id: string;
  try {
    id = attach(s.id, s.tmuxName, cols || 80, rows || 24);
  } catch (e) {
    if (e instanceof AttachError) return bye({ fatal: true, error: e.message }, 4500);
    throw e;
  }
  const off = subscribe(id, (d) => { if (ws.readyState === OPEN) ws.send(JSON.stringify({ d })); }, () => ws.close(4000));
  if (!off) return bye({ retry: true, error: "终端刚退出" }, 4503);
  const ping = setInterval(() => { if (ws.readyState === OPEN) ws.send('{"ping":1}'); }, PING_MS);
  ping.unref();
  ws.on("message", (raw) => {
    let m: { i?: unknown; r?: unknown };
    try {
      m = JSON.parse(String(raw)) as typeof m;
    } catch {
      return;
    }
    if (typeof m.i === "string") writeAttach(id, m.i);
    else if (Array.isArray(m.r)) resizeAttach(id, Number(m.r[0]), Number(m.r[1]));
  });
  ws.on("close", () => {
    clearInterval(ping);
    off();
  });
}

const PATH = /^\/sessions\/([^/]+)\/ws$/;

/** 挂到 HTTP 服务的 upgrade 上。浏览器里任何网页都能连 127.0.0.1 的 WebSocket（不受同源限制），不验来源等于让随便一个网页往终端里敲命令 */
export function handleUpgrade(wss: WebSocketServer, req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const m = PATH.exec(url.pathname);
  if (!m || !isLocalOrigin(req.headers.origin ?? "")) {
    socket.write(`HTTP/1.1 ${m ? "403 Forbidden" : "404 Not Found"}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => void onTerminal(ws as unknown as SocketLike, decodeURIComponent(m[1]!), Number(url.searchParams.get("cols")), Number(url.searchParams.get("rows"))));
}

export const terminalSockets = () => new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
