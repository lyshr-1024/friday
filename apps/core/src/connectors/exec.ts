import { execFile } from "node:child_process";

export function runJson<T>(bin: string, args: string[], timeoutMs = 30_000): Promise<T> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${bin} ${args.slice(0, 2).join(" ")} 失败：${stderr.trim() || err.message}`));
      try {
        resolve(JSON.parse(stdout) as T);
      } catch {
        reject(new Error(`${bin} 输出不是 JSON：${stdout.slice(0, 200)}`));
      }
    });
  });
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}
