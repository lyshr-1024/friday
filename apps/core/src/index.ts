import { serve } from "@hono/node-server";
import { app } from "./api/index.js";
import { config } from "./config.js";
import { initMemory } from "./memory/db.js";
import { reapStaleJobs } from "./memory/jobs.js";
import { isAlive } from "./agent/ghostty.js";
import { migrateLocalTodos } from "./memory/noteTask.js";
import { backfillSlackLinks } from "./memory/backfillLinks.js";
import { closeSettledThreads } from "./memory/threads.js";
import { startScheduler } from "./scheduler/index.js";

initMemory();
console.log(`memory at ${config.dataDir}`);
// 上次进程没了，库里还标着 running 的挨个问一句窗口在不在：外部 Ghostty 不跟着
// sidecar 死，还开着的要留下，只收真没了的那些
const reaped = await reapStaleJobs(isAlive);
if (reaped.length) console.log(`收尾 ${reaped.length} 个上次遗留的终端记录`);
// todos 表在启动器删掉后就没有界面出口了，把最近写进去的补成任务
const moved = migrateLocalTodos();
if (moved) console.log(`把 ${moved} 条本地待办补成了任务`);
// 存量 Slack 任务的需求关联只在新线程进来时建，老的补一次
const linked = backfillSlackLinks();
if (linked) console.log(`给 ${linked} 条 Slack 任务补上了关联需求`);
// 「任务收工连带关线程」是后加的，之前收的工留下一堆开着的线程还在接旧消息
const settled = closeSettledThreads();
if (settled) console.log(`关掉 ${settled} 条任务都已收工的线程`);

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
