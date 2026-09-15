import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * node-pty 在 unix 上 spawn 时要 exec 这个 helper。pnpm 从内容寻址的 store 取文件时不保留
 * 可执行位，而 spawn-helper 不在 node-pty 的 bin 字段里，没人替它补——装完依赖它就是 0644，
 * spawn 直接抛「posix_spawnp failed」。pty.node 是 dlopen 加载的不受影响，所以 core 照常
 * 启动，只有终端起不来，症状很隐晦。根 package.json 的 postinstall 负责补上。
 */
function spawnHelper(): string {
  const entry = createRequire(import.meta.url).resolve("node-pty");
  return join(dirname(dirname(entry)), "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
}

describe("PTY 的原生依赖", () => {
  // 只管 darwin：node-pty 1.1.0 只为 win32 / darwin 出 prebuilds，别的平台走 node-gyp 现编
  it.skipIf(process.platform !== "darwin")("spawn-helper 有可执行位", () => {
    expect(statSync(spawnHelper()).mode & 0o111).toBeGreaterThan(0);
  });
});
