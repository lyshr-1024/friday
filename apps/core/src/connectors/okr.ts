import { callTool, mcpEndpoint, type McpEndpoint } from "./mcp.js";

export class OkrError extends Error {}

export function okrEndpoint(file?: string): McpEndpoint {
  try {
    return mcpEndpoint("okr", file);
  } catch (e) {
    throw new OkrError(e instanceof Error ? e.message : String(e));
  }
}

async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  let r: Awaited<ReturnType<typeof callTool>>;
  try {
    r = await callTool("okr", name, args, { label: "OKR 平台" });
  } catch (e) {
    throw new OkrError(e instanceof Error ? e.message : String(e));
  }
  if (r.isError) throw new OkrError(`${name} 失败：${r.text.slice(0, 200)}`);
  const first = r.blocks[0] ?? "";
  try {
    return JSON.parse(first) as T;
  } catch {
    throw new OkrError(`${name} 返回的不是 JSON：${first.slice(0, 120)}`);
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
