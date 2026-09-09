import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { subscribe } from "../bus.js";

/** 一条 SSE 长连接：终端忙闲切换、任务变更、会话生成开始 / 结束，发生即推。 */
export const events = new Hono().get("/events", (c) =>
  streamSSE(c, async (stream) => {
    await stream.writeSSE({ data: JSON.stringify({ type: "hello" }) });
    await new Promise<void>((resolve) => {
      const unsubscribe = subscribe((ev) => void stream.writeSSE({ data: JSON.stringify(ev) }).catch(() => {}));
      const ping = setInterval(() => void stream.writeSSE({ data: JSON.stringify({ type: "ping" }) }).catch(() => {}), 15_000);
      stream.onAbort(() => {
        unsubscribe();
        clearInterval(ping);
        resolve();
      });
    });
  }),
);
