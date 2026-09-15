import type { StateTransition, Todo } from "@friday/shared";
import type { Connector } from "./types.js";
import { mapLimit, runJson } from "./exec.js";

interface AuthStatus {
  authenticated: boolean;
  host: string | null;
}

interface TodoItem {
  project_key: string;
  project_name?: string;
  node_info?: { node_name?: string; node_state_key?: string };
  schedule?: { end_time?: string };
  work_item_info: { work_item_id: number; work_item_type_key: string };
}

/** 分派给我的 Meegle 工作项，已拼好任务中枢需要的字段。 */
type Parent = { id: string; name: string } | undefined;

interface RelationDef {
  id: string;
  work_item_type_key: string;
  relation_details?: Array<{ work_item_type_key: string }>;
}

export interface MeegleWorkItem {
  id: string;
  name: string;
  typeName: string;
  /** 工单类型键：story / issue / 自定义类型的 hash */
  typeKey: string;
  /** 描述里出现的产品页面链接（已去掉 Meegle / 飞书自身的链接） */
  links: string[];
  status: string;
  statusKey: string;
  priority?: string;
  tags?: string[];
  node?: string;
  nodeKey?: string;
  docs?: Docs;
  reporter?: string;
  description?: string;
  /** 缺陷挂的需求，story 上没有 */
  parent?: { id: string; name: string };
  projectName: string;
  projectKey: string;
  url: string;
  createdAt: string;
  due?: string;
  feDue?: string;
  beDue?: string;
}

interface TodoPage {
  list: TodoItem[] | null;
  total: number;
}

interface WorkItem {
  work_item_attribute: {
    work_item_id: string;
    work_item_name: string;
    create_time: string;
    create_by?: { name?: string };
    role_members?: Array<{ name: string; members: Array<{ name?: string }> }>;
    owned_project: { simple_name: string };
    work_item_status: { key?: string; name: string };
    work_item_type: { key: string; name: string };
  };
  work_item_fields: Array<{ key: string; name?: string; value: unknown }>;
}

interface WorkflowNode {
  basic: { node_key: string; name: string; status?: string };
  schedule?: { estimate_finish_time?: number | null } | null;
}

export interface NodeSchedules {
  feDue?: string;
  beDue?: string;
}

/** 缺陷只有这三个状态还要我修，其余（WON'T FIX / Resolved / Closed…）不进待办。 */
const ISSUE_OPEN_STATES = ["OPEN", "REOPENED", "IN PROGRESS"];

export function keepWorkItem(typeKey: string, statusKey: string): boolean {
  return typeKey !== "issue" || ISSUE_OPEN_STATES.includes(statusKey);
}

/** node_state_key 形如 node_state_16_24333723，中间那段才是流转要用的 node_key */
export function nodeKeyOf(nodeStateKey: string | undefined, workItemId: number | string): string | undefined {
  const tail = `_${workItemId}`;
  if (!nodeStateKey?.startsWith("node_") || !nodeStateKey.endsWith(tail)) return undefined;
  return nodeStateKey.slice(5, -tail.length) || undefined;
}

export interface Docs {
  req?: string;
  tech?: string;
  design?: string;
}

/** 三份资料的字段 key 会随模板变，字段名兜底 */
const DOC_FIELDS: Array<[keyof Docs, string, RegExp]> = [
  ["req", "field_8fe714", /requirement\s*doc|需求文档/i],
  ["tech", "field_8190c7", /technical\s*doc|技术文档/i],
  ["design", "field_1f7126", /design\s*url|设计稿/i],
];

export function pickDocs(fields: Array<{ key: string; name?: string; value: unknown }>): Docs {
  const out: Docs = {};
  for (const [slot, key, name] of DOC_FIELDS) {
    const hit = fields.find((f) => f.key === key) ?? fields.find((f) => f.name && name.test(f.name));
    const url = typeof hit?.value === "string" ? hit.value.trim() : "";
    if (url) out[slot] = url;
  }
  return out;
}

/** Friday 里能一键做的状态流转，顺序就是按钮顺序。需要填表单的不在此列。 */
const TRANSITIONS: Array<[string, string]> = [
  ["IN PROGRESS", "开始处理"],
  ["RESOLVED", "修完了"],
];

export interface RawTransition {
  id: number;
  state_key: string;
  confirm_form?: unknown;
}

export function pickTransitions(list: RawTransition[]): StateTransition[] {
  return TRANSITIONS.flatMap(([stateKey, label]) => {
    const hit = list.find((t) => t.state_key === stateKey && !t.confirm_form);
    return hit ? [{ id: String(hit.id), stateKey, label }] : [];
  });
}

const FE_NODE = { key: "state_16", name: /admin\s*frontend\s*dev|后台前端开发/i };
const BE_NODE = { key: "state_15", name: /server\s*development|服务端开发/i };

/** 本地时区的 YYYY-MM-DD；Meegle 的排期终点是当地 23:59:59.999 */
const localDay = (ms: number) => new Date(ms).toLocaleDateString("sv-SE");

/**
 * 挑出后台前端开发与服务端开发的排期结束日，node_key 优先、节点名兜底。
 * 已完成的节点不算排期，否则早就交付、只是卡在测试或发布的工单会顶在队首标红。
 */
export function pickNodeSchedules(nodes: WorkflowNode[]): NodeSchedules {
  const open = nodes.filter((n) => n.basic.status !== "finished");
  const dueOf = (m: typeof FE_NODE) => {
    const hit = open.find((n) => n.basic.node_key === m.key) ?? open.find((n) => m.name.test(n.basic.name));
    const ms = hit?.schedule?.estimate_finish_time;
    return ms ? localDay(ms) : undefined;
  };
  const feDue = dueOf(FE_NODE);
  const beDue = dueOf(BE_NODE);
  return { ...(feDue ? { feDue } : {}), ...(beDue ? { beDue } : {}) };
}

interface TodoPage {
  list: TodoItem[] | null;
  total: number;
}

interface WorkItem {
  work_item_attribute: {
    work_item_id: string;
    work_item_name: string;
    create_time: string;
    create_by?: { name?: string };
    role_members?: Array<{ name: string; members: Array<{ name?: string }> }>;
    owned_project: { simple_name: string };
    work_item_status: { key?: string; name: string };
    work_item_type: { key: string; name: string };
  };
  work_item_fields: Array<{ key: string; name?: string; value: unknown }>;
}

export function toTodo(host: string, item: WorkItem): Todo {
  const a = item.work_item_attribute;
  const priority = item.work_item_fields.find((f) => f.key === "priority")?.value as { label?: string } | undefined;
  const tag = [priority?.label, a.work_item_type.name].filter(Boolean).join(" · ");
  return {
    id: `meegle:${a.work_item_id}`,
    text: `[${tag}] ${a.work_item_name.trim()}（${a.work_item_status.name}）`,
    source: "meegle",
    sourceUrl: `https://${host}/${a.owned_project.simple_name}/${a.work_item_type.key}/detail/${a.work_item_id}`,
    createdAt: a.create_time,
    done: false,
  };
}

const SELF_HOSTS = /(feishu\.cn|larksuite\.com|larkoffice\.com|bytedance\.)/i;

/**
 * 缺陷描述里的「测试环境」链接就是出问题的页面，是定位代码最强的线索——
 * 标题只写「【BO 后台】…」，归不到具体仓库。Meegle / 飞书自己的链接要排掉。
 */
export function extractLinks(description: unknown): string[] {
  const text = typeof description === "string" ? description : JSON.stringify(description ?? "");
  const found = text.match(/https?:\/\/[^\s)\]<>"'|]+/g) ?? [];
  const out: string[] = [];
  for (const raw of found) {
    // 中文描述里 URL 后面常常直接跟句号顿号，连进来链接就废了
    const url = raw.replace(/[.,;:。，、；：！？]+$/u, "");
    if (SELF_HOSTS.test(url) || out.includes(url)) continue;
    out.push(url);
  }
  return out.slice(0, 5);
}

export function toWorkItem(host: string, todo: TodoItem, item: WorkItem, schedules: NodeSchedules = {}, parent?: { id: string; name: string }): MeegleWorkItem {
  const a = item.work_item_attribute;
  const priority = (item.work_item_fields.find((f) => f.key === "priority")?.value as { label?: string } | undefined)?.label;
  const tags = (item.work_item_fields.find((f) => f.key === "tags")?.value as Array<{ label?: string }> | undefined)
    ?.map((x) => x.label)
    .filter((x): x is string => Boolean(x));
  const description = (item.work_item_fields.find((f) => f.key === "description")?.value as string | undefined)?.trim();
  const reporter = a.role_members?.find((r) => /reporter/i.test(r.name))?.members[0]?.name ?? a.create_by?.name;
  const docs = pickDocs(item.work_item_fields);
  const nodeKey = nodeKeyOf(todo.node_info?.node_state_key, todo.work_item_info.work_item_id);
  const due = todo.schedule?.end_time?.trim();
  return {
    id: a.work_item_id,
    name: a.work_item_name.trim(),
    typeName: a.work_item_type.name,
    typeKey: a.work_item_type.key,
    links: extractLinks(item.work_item_fields.find((f) => f.key === "description")?.value),
    ...(parent ? { parent } : {}),
    status: a.work_item_status.name,
    statusKey: a.work_item_status.key ?? "",
    projectKey: todo.project_key,
    ...(tags?.length ? { tags } : {}),
    ...(Object.keys(docs).length ? { docs } : {}),
    ...(nodeKey ? { nodeKey } : {}),
    ...(reporter ? { reporter } : {}),
    ...(description ? { description } : {}),
    ...(schedules.feDue ? { feDue: schedules.feDue } : {}),
    ...(schedules.beDue ? { beDue: schedules.beDue } : {}),
    ...(priority ? { priority } : {}),
    ...(todo.node_info?.node_name ? { node: todo.node_info.node_name } : {}),
    projectName: todo.project_name ?? a.owned_project.simple_name,
    url: `https://${host}/${a.owned_project.simple_name}/${a.work_item_type.key}/detail/${a.work_item_id}`,
    createdAt: a.create_time,
    ...(due ? { due } : {}),
  };
}

export class MeegleConnector implements Connector {
  source = "meegle" as const;

  constructor(private bin = "meegle") {}

  async fetchTodos(): Promise<Todo[]> {
    return (await this.fetchRaw()).map(([, d, host]) => toTodo(host, d));
  }

  async fetchWorkItems(): Promise<MeegleWorkItem[]> {
    return (await this.fetchRaw()).map(([it, d, host, sch, parent]) => toWorkItem(host, it, d, sch, parent));
  }

  async listRawTransitions(projectKey: string, workItemId: string): Promise<RawTransition[]> {
    const res = await runJson<{ transition?: RawTransition[] | null }>(this.bin, [
      "workflow", "list-state-transitions",
      "--work-item-id", workItemId,
      "--project-key", projectKey,
      "--format", "json",
    ]);
    return res.transition ?? [];
  }

  async listTransitions(projectKey: string, workItemId: string): Promise<StateTransition[]> {
    return pickTransitions(await this.listRawTransitions(projectKey, workItemId));
  }

  /** 字段 key → 人话，模板级的东西，一个进程里缓存住就够 */
  private fieldNames = new Map<string, Map<string, string>>();

  private async namesOf(projectKey: string, type: string): Promise<Map<string, string>> {
    const ck = `${projectKey}/${type}`;
    const hit = this.fieldNames.get(ck);
    if (hit) return hit;
    const res = await runJson<{ list?: Array<{ field_key: string; field_name: string }> }>(this.bin, [
      "workitem", "meta-fields",
      "--project-key", projectKey,
      "--work-item-type", type,
      "--format", "json",
    ]);
    const map = new Map((res.list ?? []).map((f) => [f.field_key, f.field_name]));
    this.fieldNames.set(ck, map);
    return map;
  }

  /** 当前节点还差哪些必填项。空数组 = 可以流转。 */
  async nodeReadiness(projectKey: string, workItemId: string, nodeKey: string): Promise<{ missing: string[] }> {
    const res = await runJson<{ form_items?: Array<{ key: string; finished?: boolean }> | null }>(this.bin, [
      "workflow", "list-state-required",
      "--work-item-id", workItemId,
      "--project-key", projectKey,
      "--state-key", nodeKey,
      "--mode", "unfinished",
      "--format", "json",
    ]);
    const open = (res.form_items ?? []).filter((f) => f.finished !== true);
    if (!open.length) return { missing: [] };
    const names = await this.namesOf(projectKey, "story").catch(() => new Map<string, string>());
    return { missing: open.map((f) => names.get(f.key) ?? f.key) };
  }

  async transitionNode(projectKey: string, workItemId: string, nodeKey: string, action: "confirm" | "rollback", reason?: string): Promise<void> {
    await runJson(this.bin, [
      "workflow", "transition",
      "--work-item-id", workItemId,
      "--project-key", projectKey,
      "--node-id", nodeKey,
      "--action", action,
      ...(reason ? ["--rollback-reason", reason] : []),
      "--format", "json",
    ]);
  }

  async transitionState(projectKey: string, workItemId: string, transitionId: string): Promise<void> {
    await runJson(this.bin, [
      "workflow", "transition-state",
      "--work-item-id", workItemId,
      "--project-key", projectKey,
      "--transition-id", transitionId,
      "--format", "json",
    ]);
  }

  /** 缺陷没有节点流，跳过；单条失败当作没排期，不拖垮整次同步。 */
  private async nodeSchedules(it: TodoItem): Promise<NodeSchedules> {
    if (it.work_item_info.work_item_type_key !== "story") return {};
    try {
      const res = await runJson<{ list: WorkflowNode[] | null }>(this.bin, [
        "workflow", "get-node",
        "--work-item-id", String(it.work_item_info.work_item_id),
        "--project-key", it.project_key,
        "--format", "json",
      ]);
      return pickNodeSchedules(res.list ?? []);
    } catch {
      return {};
    }
  }

  /** 「缺陷 → 需求」那条关联定义的 id，一个空间一条，缓存住。 */
  private relationIds = new Map<string, string | null>();

  private async defectRelationId(projectKey: string): Promise<string | null> {
    const hit = this.relationIds.get(projectKey);
    if (hit !== undefined) return hit;
    let id: string | null = null;
    try {
      const res = await runJson<{ list?: RelationDef[] | null }>(this.bin, [
        "relation", "meta-definitions",
        "--project-key", projectKey,
        "--format", "json",
      ]);
      // 按类型找而不是按名字：名字是本地化的，换个语言就失配
      const def = (res.list ?? []).find(
        (r) => r.work_item_type_key === "issue" && (r.relation_details ?? []).some((d) => d.work_item_type_key === "story"),
      );
      id = def?.id ?? null;
    } catch {
      id = null;
    }
    this.relationIds.set(projectKey, id);
    return id;
  }

  /** 缺陷挂的需求。只有 issue 有；查不到当作没挂，不拖垮整次同步。 */
  private async linkedRequirement(it: TodoItem): Promise<{ id: string; name: string } | undefined> {
    if (it.work_item_info.work_item_type_key !== "issue") return undefined;
    const relationId = await this.defectRelationId(it.project_key);
    if (!relationId) return undefined;
    try {
      const res = await runJson<{ list?: Array<{ id: number | string; name?: string }> | null }>(this.bin, [
        "relation", "list",
        "--work-item-id", String(it.work_item_info.work_item_id),
        "--project-key", it.project_key,
        "--relation-id", relationId,
        "--format", "json",
      ]);
      const first = (res.list ?? [])[0];
      return first ? { id: String(first.id), name: (first.name ?? "").trim() } : undefined;
    } catch {
      return undefined;
    }
  }

  private async fetchRaw(): Promise<Array<[TodoItem, WorkItem, string, NodeSchedules, Parent]>> {
    const auth = await runJson<AuthStatus>(this.bin, ["auth", "status", "--format", "json"]);
    if (!auth.authenticated || !auth.host) throw new Error("Meegle 未登录，请在终端执行 meegle auth login");

    const items: TodoItem[] = [];
    for (let page = 1; ; page++) {
      const res = await runJson<TodoPage>(this.bin, ["mywork", "todo", "--action", "todo", "--page-num", String(page), "--format", "json"]);
      const list = res.list ?? [];
      items.push(...list);
      if (list.length === 0 || items.length >= res.total) break;
    }

    const details = await mapLimit(items, 3, (it) =>
      runJson<WorkItem>(this.bin, [
        "workitem", "get",
        "--work-item-id", String(it.work_item_info.work_item_id),
        "--project-key", it.project_key,
        "--fields", it.work_item_info.work_item_type_key === "issue" ? "priority,tags,description" : "priority,tags,description,field_8fe714,field_8190c7,field_1f7126",
        "--format", "json",
      ]),
    );
    const kept = items
      .map((it, i) => [it, details[i]!] as const)
      .filter(([, d]) => keepWorkItem(d.work_item_attribute.work_item_type.key, d.work_item_attribute.work_item_status.key ?? ""));
    const schedules = await mapLimit(kept, 3, ([it]) => this.nodeSchedules(it));
    const parents = await mapLimit(kept, 3, ([it]) => this.linkedRequirement(it));
    return kept.map(([it, d], i) => [it, d, auth.host!, schedules[i]!, parents[i]]);
  }
}
