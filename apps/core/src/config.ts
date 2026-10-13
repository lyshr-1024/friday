import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CORE_PORT } from "@friday/shared";

// 测试没走 vitest.setup（比如在别的目录跑 vitest）时 FRIDAY_DATA_DIR 是空的，会直接写进真实记忆库：宁可起不来
if (process.env.VITEST && !process.env.FRIDAY_DATA_DIR) throw new Error("测试环境没设 FRIDAY_DATA_DIR：在 apps/core 下跑 vitest，别让测试写进真实的 Friday 数据目录");

export const config = {
  host: "127.0.0.1",
  port: Number(process.env.FRIDAY_PORT ?? DEFAULT_CORE_PORT),
  version: process.env.npm_package_version ?? "0.1.0",
  dataDir: process.env.FRIDAY_DATA_DIR || join(homedir(), "Library/Application Support/Friday"),
};
