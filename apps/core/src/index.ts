import { serve } from "@hono/node-server";
import { app } from "./api/index.js";
import { config } from "./config.js";

serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`friday-core listening on http://${info.address}:${info.port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => process.exit(0));
}

// 壳被 SIGKILL 或 tauri dev 被 Ctrl+C 时不会走正常退出路径，靠这里避免留下孤儿进程。
setInterval(() => {
  if (process.ppid === 1) process.exit(0);
}, 2000).unref();
