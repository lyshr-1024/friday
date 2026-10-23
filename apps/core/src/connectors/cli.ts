import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export function fillTemplate(template: string[], args: Record<string, unknown>): string[] {
  return template.map((part) =>
    part.replace(/\{(\w+)\}/g, (_, name: string) => {
      const v = args[name];
      if (v === undefined || v === null) throw new Error(`缺参数 ${name}`);
      return typeof v === "object" ? JSON.stringify(v) : String(v);
    }),
  );
}

export async function runCli(binary: string, argv: string[], timeoutMs = 30_000): Promise<string> {
  try {
    return (await execFileP(binary, argv, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 })).stdout;
  } catch (e) {
    const err = e as { stderr?: string; killed?: boolean; message?: string };
    if (err.killed) throw new Error(`${binary} ${Math.round(timeoutMs / 1000)} 秒没跑完`);
    throw new Error(`${binary} 失败：${(err.stderr || err.message || String(e)).trim().slice(0, 500)}`);
  }
}
