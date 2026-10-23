import { invokeTool, type Caller } from "../../connectors/invoke.js";
import { listTools, servers } from "../../connectors/mcp.js";
import { getTool, saveTool } from "../../connectors/registry.js";

export class OkrError extends Error {}

const READ: Caller = { kind: "friday", why: "起草周报" };

async function call<T>(name: string, args: Record<string, unknown>, caller: Caller = READ): Promise<T> {
  let r: Awaited<ReturnType<typeof invokeTool>>;
  try {
    r = await invokeTool(caller, "okr", name, args);
  } catch (e) {
    throw new OkrError(e instanceof Error ? e.message : String(e));
  }
  if (r.kind !== "ok") throw new OkrError(`${name} 失败：${r.kind === "refused" ? r.why : r.kind}`);
  if (r.value === undefined) throw new OkrError(`${name} 返回的不是 JSON：${r.text.slice(0, 120)}`);
  return r.value as T;
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

export async function submit(r: { objectId: number; week: string; quarter: string; content: string; pct: number }, caller: Caller): Promise<number> {
  const res = await call<{ id?: number; report?: { id?: number } }>("create_progress_report", { report_type: "own", object_id: r.objectId, week: r.week, quarter_name: r.quarter, content: r.content, progress_percentage: r.pct }, caller);
  const id = res.id ?? res.report?.id;
  if (id) return id;
  // 接口没说成功时回什么，拿不到 id 就回查一次，撤销要靠它
  const mine = await me();
  const hit = (await quarterReports(mine.id, r.quarter, r.week)).find((x) => x.objectId === r.objectId);
  if (!hit) throw new OkrError("提交后在平台上没查到这条");
  return hit.id;
}

export async function remove(reportId: number, caller: Caller): Promise<void> {
  await call("delete_progress_report", { report_id: reportId }, caller);
}

const OPS: Array<{ name: string; level: "read" | "irreversible" }> = [
  { name: "get_current_user", level: "read" },
  { name: "list_user_okr_hierarchy", level: "read" },
  { name: "list_progress_reports", level: "read" },
  { name: "create_progress_report", level: "irreversible" },
  { name: "delete_progress_report", level: "irreversible" },
];

const hasOkrServer = () => {
  try {
    return Boolean(servers().okr);
  } catch {
    return false;
  }
};

/** 启动时调：~/.claude.json 有 okr server 而注册处没有，就先用占位说明登记；真实说明和参数模式稍后从服务端取 */
export function registerOkr(): boolean {
  if (getTool("okr") || !hasOkrServer()) return false;
  saveTool({
    name: "okr", transport: "mcp_http", connection: "okr", scenario: "OKR 周报起草与提交",
    projects: [], roles: [], binaries: [], enabled: true, draft: false,
    ops: OPS.map((o) => ({ name: o.name, description: o.name, inputSchema: {}, level: o.level, levelBy: "builtin" as const })),
  });
  return true;
}

/** 取不到就算了：登记已经能用，只是模型看到的说明少一点 */
export async function enrichOkr(): Promise<void> {
  const reg = getTool("okr");
  if (!reg || reg.transport !== "mcp_http" || !reg.ops.some((o) => o.description === o.name)) return;
  const info = new Map((await listTools("okr")).map((t) => [t.name, t]));
  saveTool({
    ...reg,
    ops: reg.ops.map((o) => {
      const t = info.get(o.name);
      return t && o.description === o.name ? { ...o, description: t.description || o.name, inputSchema: t.inputSchema } : o;
    }),
  });
}
