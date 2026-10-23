import type { ToolHealth } from "@friday/shared";
import { builtin } from "./builtin.js";
import { runCli } from "./cli.js";
import { handshake, mcpEndpoint } from "./mcp.js";
import { listStdioTools } from "./mcpStdio.js";
import { getTool, listTools, setHealth } from "./registry.js";

const TIMEOUT_MS = 5_000;

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function withTimeout<T>(p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${TIMEOUT_MS / 1000} 秒没响应`)), TIMEOUT_MS);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

async function probe(name: string): Promise<void> {
  const reg = getTool(name)!;
  if (reg.transport === "builtin") return builtin(name)?.health?.();
  if (reg.transport === "mcp_http") {
    await handshake(mcpEndpoint(reg.connection), reg.name, TIMEOUT_MS);
    return;
  }
  if (reg.transport === "mcp_stdio") {
    await listStdioTools(reg.connection);
    return;
  }
  await runCli("which", [reg.connection], TIMEOUT_MS);
}

export async function checkHealth(name: string): Promise<ToolHealth> {
  const at = new Date().toISOString();
  let h: ToolHealth;
  try {
    await withTimeout(Promise.resolve(probe(name)));
    h = { at, ok: true };
  } catch (e) {
    h = { at, ok: false, error: msg(e) };
  }
  if (getTool(name)) setHealth(name, h);
  return h;
}

export async function checkAllHealth(): Promise<void> {
  await Promise.all(listTools().map((t) => checkHealth(t.name)));
}
