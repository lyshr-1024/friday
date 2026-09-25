import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export class OkrError extends Error {}

type Endpoint = { url: string; headers: Record<string, string> };

// 凭证是 Claude Code 的 okr MCP 配置，Friday 不另存一份：用户在那边换了 token 这边自动跟上
export function okrEndpoint(file = process.env.FRIDAY_CLAUDE_JSON || join(homedir(), ".claude.json")): Endpoint {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new OkrError(`读不到 ${file}`);
  }
  const s = (raw as { mcpServers?: Record<string, { url?: string; headers?: Record<string, string> }> }).mcpServers?.okr;
  if (!s?.url) throw new OkrError(`${file} 里没有 mcpServers.okr`);
  return { url: s.url, headers: s.headers ?? {} };
}

export function parseRpcBody(body: string): { result?: any; error?: { message: string } } {
  const t = body.trim();
  if (t.startsWith("{")) return JSON.parse(t);
  const data = t.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean).at(-1);
  if (!data) throw new OkrError("OKR 平台返回了空响应");
  return JSON.parse(data);
}

let seq = 0;

async function post(ep: Endpoint, msg: Record<string, unknown>, session?: string): Promise<Response> {
  const res = await fetch(ep.url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(session ? { "mcp-session-id": session } : {}), ...ep.headers },
    body: JSON.stringify({ jsonrpc: "2.0", ...msg }),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401 || res.status === 403) throw new OkrError("OKR 平台拒绝了 token，去 Claude Code 里重新配一下 okr MCP");
  if (!res.ok && res.status !== 202) throw new OkrError(`OKR 平台返回 ${res.status}`);
  return res;
}

async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const ep = okrEndpoint();
  const init = await post(ep, { id: ++seq, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "friday", version: "1" } } });
  const session = init.headers.get("mcp-session-id") ?? undefined;
  parseRpcBody(await init.text());
  await post(ep, { method: "notifications/initialized" }, session);
  const res = await post(ep, { id: ++seq, method: "tools/call", params: { name, arguments: args } }, session);
  const msg = parseRpcBody(await res.text());
  if (msg.error) throw new OkrError(`${name} 失败：${msg.error.message}`);
  const text = (msg.result?.content as Array<{ type: string; text?: string }> | undefined)?.find((c) => c.type === "text")?.text ?? "";
  if (msg.result?.isError) throw new OkrError(`${name} 失败：${text.slice(0, 200)}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new OkrError(`${name} 返回的不是 JSON：${text.slice(0, 120)}`);
  }
}

export interface OkrKR { id: number; name: string; objective: string; quarter: string }
export interface OkrReport { id: number; objectId: number; week: string; content: string; pct: number }

export async function me(): Promise<{ id: number; name: string }> {
  const u = await call<{ id: number; name: string }>("get_current_user", {});
  return { id: u.id, name: u.name };
}

export async function myKRs(): Promise<OkrKR[]> {
  const h = await call<{ root: { objects: Array<{ id: number; name: string; label: string; parent_id: number; quarter: string }> } }>("list_user_okr_hierarchy", { root_user_id: 0, depth: 0 });
  const objs = h.root.objects;
  const os = new Map(objs.filter((o) => o.label === "O").map((o) => [o.id, o.name]));
  return objs.filter((o) => o.label === "KR").map((o) => ({ id: o.id, name: o.name, objective: os.get(o.parent_id) ?? "", quarter: o.quarter }));
}

export async function quarterReports(ownerId: number, quarter: string, week = ""): Promise<OkrReport[]> {
  const r = await call<{ reports?: Array<{ id: number; object_id: number; week: string; content: string; progress_percentage: number }> }>("list_progress_reports", { owner_id: ownerId, quarter, week });
  return (r.reports ?? []).map((x) => ({ id: x.id, objectId: x.object_id, week: x.week, content: x.content, pct: x.progress_percentage }));
}

export async function submit(r: { objectId: number; week: string; quarter: string; content: string; pct: number }): Promise<number> {
  const res = await call<{ id?: number; report?: { id?: number } }>("create_progress_report", { report_type: "own", object_id: r.objectId, week: r.week, quarter_name: r.quarter, content: r.content, progress_percentage: r.pct });
  const id = res.id ?? res.report?.id;
  if (id) return id;
  // 接口没说成功时回什么，拿不到 id 就回查一次，撤销要靠它
  const mine = await me();
  const hit = (await quarterReports(mine.id, r.quarter, r.week)).find((x) => x.objectId === r.objectId);
  if (!hit) throw new OkrError("提交后在平台上没查到这条");
  return hit.id;
}

export async function remove(reportId: number): Promise<void> {
  await call("delete_progress_report", { report_id: reportId });
}
