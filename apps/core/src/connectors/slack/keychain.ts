import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** 读 macOS 钥匙串里的通用密码；不存在返回 undefined。 */
export async function keychainGet(service: string, account: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileP("/usr/bin/security", ["find-generic-password", "-s", service, "-a", account, "-w"]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}
