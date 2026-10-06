import { execFile } from "node:child_process";

export type Exec = (args: string[]) => Promise<string>;

const defaultExec: Exec = (args) =>
  new Promise((resolve, reject) => {
    execFile("/usr/sbin/lsof", args, { timeout: 1_500 }, (err, stdout) => {
      // lsof 没找到任何进程时退出码是 1，stdout 为空——那不是错，是「没人监听」
      if (err && !String(stdout).trim()) return (err as NodeJS.ErrnoException).code === "ENOENT" ? reject(err) : resolve("");
      resolve(String(stdout));
    });
  });

export interface LocalDev {
  port: number;
  /** 监听这个端口的进程的工作目录——起 dev server 的那个 worktree 或主仓 */
  dir: string;
}

/**
 * localhost:端口 → 哪个目录在跑 dev server。
 * 多个 worktree 各开一个端口并行调试时，端口号本身对不上任务，监听进程的 cwd 才对得上。
 * 两次 lsof（端口 → pid，pid → cwd），约 50 到 100 毫秒；查不到就当没有，不猜。
 */
export async function resolveLocalDev(port: number, exec: Exec = defaultExec): Promise<LocalDev | undefined> {
  if (!Number.isInteger(port) || port <= 0) return undefined;
  let pids: string[];
  try {
    pids = (await exec(["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"]))
      .split("\n")
      .filter((l) => l.startsWith("p"))
      .map((l) => l.slice(1).trim())
      .filter(Boolean);
  } catch (e) {
    console.error(`[localdev] lsof 不可用：${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
  for (const pid of [...new Set(pids)].slice(0, 4)) {
    try {
      const dir = (await exec(["-a", "-p", pid, "-d", "cwd", "-Fn"]))
        .split("\n")
        .find((l) => l.startsWith("n/"))
        ?.slice(1)
        .trim();
      if (dir) return { port, dir };
    } catch {
      // 这个 pid 查不到 cwd（已退出、权限），看下一个
    }
  }
  return undefined;
}
