import { serve } from "@hono/node-server";
import { app } from "./api/index.js";
import { config } from "./config.js";
import { initMemory } from "./memory/db.js";
import { reapStaleJobs } from "./memory/jobs.js";
import { startScheduler } from "./scheduler/index.js";

initMemory();
console.log(`memory at ${config.dataDir}`);
// PTY 活在内存里，上次进程没了它们就都死了——启动先收尸，否则计数越攒越多
const reaped = reapStaleJobs();
if (reaped) console.log(`收尾 ${reaped} 个上次遗留的终端记录`);

serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`friday-core listening on http://${info.address}:${info.port}`);
});
if (process.env.FRIDAY_NO_SCHEDULER !== "1") startScheduler();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => process.exit(0));
}

// 壳被 SIGKILL 或 tauri dev 被 Ctrl+C 时不会走正常退出路径，靠这里避免留下孤儿进程。
setInterval(() => {
  if (process.ppid === 1) process.exit(0);
}, 2000).unref();
