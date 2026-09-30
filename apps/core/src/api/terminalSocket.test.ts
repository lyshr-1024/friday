import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { handleUpgrade, terminalSockets } from "./terminalSocket.js";

let server: Server;
let port = 0;
beforeAll(async () => {
  const wss = terminalSockets();
  server = createServer();
  server.on("upgrade", (req, socket, head) => handleUpgrade(wss, req, socket, head));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** 连一次，拿到第一条消息或握手失败的状态码 */
function connect(path: string, origin?: string): Promise<{ status?: number; msg?: unknown; code?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, origin ? { origin } : {});
    let msg: unknown;
    ws.on("unexpected-response", (_req, res) => resolve({ status: res.statusCode }));
    ws.on("message", (d) => { msg = JSON.parse(String(d)); });
    ws.on("close", (code) => resolve({ msg, code }));
    ws.on("error", () => {});
  });
}

describe("终端 WebSocket 的握手：只认 Friday 自己的页面", () => {
  it("别的网页（任意来源）连不上：403，根本走不到终端", async () => {
    expect(await connect("/sessions/x/ws?cols=80&rows=24", "https://evil.example")).toEqual({ status: 403 });
    expect(await connect("/sessions/x/ws?cols=80&rows=24", "http://localhost.evil.example")).toEqual({ status: 403 });
    expect(await connect("/sessions/x/ws?cols=80&rows=24")).toEqual({ status: 403 });
  });

  it("Friday 的来源（tauri / 本机 vite）能连上，会话不在就回 gone", async () => {
    for (const origin of ["tauri://localhost", "http://tauri.localhost", "http://localhost:1421", "http://127.0.0.1:1421"]) {
      expect(await connect("/sessions/nope/ws?cols=80&rows=24", origin)).toEqual({ msg: { gone: true, error: "会话已不在" }, code: 4404 });
    }
  });

  it("别的路径不升级：404", async () => {
    expect(await connect("/events", "tauri://localhost")).toEqual({ status: 404 });
  });
});
