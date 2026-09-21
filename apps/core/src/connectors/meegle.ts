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
  projectName: string;
  projectKey: string;
  url: string;
  createdAt: string;
  due?: string;
  feDue?: string;
  beDue?: string;
  /** Meegle 里填的「关联需求」：缺陷属于哪个需求 */
  linkedStory?: { id: string; name: string };
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
    role_members?: Array<{ name: string; members: Array<{ name?: string; key?: string }> }>;
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

/**
 * 这条节点的排期是不是已经轮到我做了。
 * 按排期而不是按节点状态判断：别人常常不更新需求状态，等他流转过来我的开发时间早过了。
 * 已经过期的照样算——过期没做才更该提醒。没排期的不算，那是还没排到我头上。
 */
export function scheduleDue(schedule: { start_time?: string; end_time?: string } | undefined, today: string): boolean {
  const start = schedule?.start_time?.trim();
  const end = schedule?.end_time?.trim();
  if (!start && !end) return false;
  // 有开始时间就等它到；只给了截止日说明时间要求已经压下来了，直接接。
  return start ? start <= today : true;
}

/**
 * todo-scope=all 会把同一工单的每个节点各返回一条，挑出当前该做的那一个。
 * 排期已到的里面取开始时间最晚的：那是已经推进到的最新一段，早于它的要么做完了要么被跳过。
 */
export function pickDueNodes<T extends { work_item_info?: { work_item_id?: string | number; work_item_type_key?: string }; schedule?: { start_time?: string; end_time?: string } }>(
  items: T[],
  today: string,
): T[] {
  const best = new Map<string, T>();
  for (const it of items) {
    // 缺陷没有排期这回事（实测分派给我的 6 个 schedule 全空），分派了就该修。
    const isIssue = it.work_item_info?.work_item_type_key === "issue";
    if (!isIssue && !scheduleDue(it.schedule, today)) continue;
    const id = String(it.work_item_info?.work_item_id ?? "");
    if (!id) continue;
    const cur = best.get(id);
    const at = (x: T) => (x.schedule?.start_time || x.schedule?.end_time || "").trim();
    if (!cur || at(it) > at(cur)) best.set(id, it);
  }
  return [...best.values()];
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

/**
 * 缺陷的「关联需求」。字段 key 是 _field_linked_story，字段名在中英文环境下分别是
 * 「关联需求」/「Linked Requirement」，所以 key 找不到时按名字兜一层。
 */
export function pickLinkedStory(fields: Array<{ key: string; name?: string; value: unknown }>): { id: string; name: string } | undefined {
  const hit = fields.find((f) => f.key === "_field_linked_story") ?? fields.find((f) => f.name && /关联需求|linked\s*requirement/i.test(f.name));
  const v = hit?.value as { id?: unknown; name?: unknown } | undefined;
  const id = v?.id === undefined || v.id === null ? "" : String(v.id);
  const name = typeof v?.name === "string" ? v.name.trim() : "";
  return id && name ? { id, name } : undefined;
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
    role_members?: Array<{ name: string; members: Array<{ name?: string; key?: string }> }>;
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

export const SELF_HOSTS = /(feishu\.cn|larksuite\.com|larkoffice\.com|bytedance\.)/i;

/**
 * 缺陷描述里的「测试环境」链接就是出问题的页面，是定位代码最强的线索——
 * 标题只写「【BO 后台】…」，归不到具体仓库。Meegle / 飞书自己的链接要排掉。
 */
/** 走查模板的「操作入口」写的是反引号包的站内路径而不是完整地址，同样能落到项目的地址前缀上。 */
const INLINE_PATH = /`(\/[A-Za-z0-9\-_/]{3,})`/g;

export function extractLinks(description: unknown): string[] {
  const text = typeof description === "string" ? description : JSON.stringify(description ?? "");
  // 非 ASCII 一律不算链接的一部分：中文描述里「见 https://x，然后…」会把后面半句话都粘进来
  const found = text.match(/https?:\/\/[^\s)\]<>"'|\u00a0-\uffff]+/g) ?? [];
  const out: string[] = [];
  for (const raw of found) {
    // 中文描述里 URL 后面常常直接跟句号顿号，连进来链接就废了
    const url = raw.replace(/[.,;:。，、；：！？]+$/u, "");
    if (SELF_HOSTS.test(url) || out.includes(url)) continue;
    out.push(url);
  }
  for (const m of text.matchAll(INLINE_PATH)) {
    if (!out.includes(m[1]!)) out.push(m[1]!);
  }
  return out.slice(0, 5);
}

export function toWorkItem(host: string, todo: TodoItem, item: WorkItem, schedules: NodeSchedules = {}): MeegleWorkItem {
  const a = item.work_item_attribute;
  const priority = (item.work_item_fields.find((f) => f.key === "priority")?.value as { label?: string } | undefined)?.label;
  const tags = (item.work_item_fields.find((f) => f.key === "tags")?.value as Array<{ label?: string }> | undefined)
    ?.map((x) => x.label)
    .filter((x): x is string => Boolean(x));
  const description = (item.work_item_fields.find((f) => f.key === "description")?.value as string | undefined)?.trim();
  const reporter = a.role_members?.find((r) => /reporter/i.test(r.name))?.members[0]?.name ?? a.create_by?.name;
  const docs = pickDocs(item.work_item_fields);
  const linkedStory = pickLinkedStory(item.work_item_fields);
  const nodeKey = nodeKeyOf(todo.node_info?.node_state_key, todo.work_item_info.work_item_id);
  const due = todo.schedule?.end_time?.trim();
  return {
    id: a.work_item_id,
    name: a.work_item_name.trim(),
    typeName: a.work_item_type.name,
    typeKey: a.work_item_type.key,
    links: extractLinks(item.work_item_fields.find((f) => f.key === "description")?.value),
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
    ...(linkedStory ? { linkedStory } : {}),
    ...(todo.node_info?.node_name ? { node: todo.node_info.node_name } : {}),
    projectName: todo.project_name ?? a.owned_project.simple_name,
    url: `https://${host}/${a.owned_project.simple_name}/${a.work_item_type.key}/detail/${a.work_item_id}`,
    createdAt: a.create_time,
    ...(due ? { due } : {}),
  };
}

export class MeegleConnector implements Connector {
  source = "meegle" as const;

  private me: string | undefined;

  constructor(private bin = "meegle") {}

  async fetchTodos(): Promise<Todo[]> {
    return (await this.fetchRaw()).map(([, d, host]) => toTodo(host, d));
  }

  async fetchWorkItems(): Promise<MeegleWorkItem[]> {
    return (await this.fetchRaw()).map(([it, d, host, sch]) => toWorkItem(host, it, d, sch));
  }

  /** 当前登录用户的 user_key。判断「这条需求里有没有我」要用它精确比对，不靠名字。 */
  async myKey(): Promise<string | undefined> {
    if (this.me !== undefined) return this.me || undefined;
    try {
      const res = await runJson<{ user_key?: string }>(this.bin, ["user", "me", "--format", "json"]);
      this.me = res.user_key ?? "";
    } catch {
      this.me = "";
    }
    return this.me || undefined;
  }

  /**
   * 「FE 发布」这个节点走完了没。这是任务出池的唯一判据（2026-09-20 与用户定）：
   * 需求只要前端还没发布，就一直留在池子里，哪怕当前节点流转到别人手上（测试、服务端）。
   * 节点名各空间可能不同，所以按名字模糊匹配，宁可认不出（继续留着）也不要误判出池。
   */
  async feReleased(projectKey: string, workItemId: string): Promise<boolean> {
    try {
      const d = await runJson<{ list?: Array<{ basic?: { name?: string; status?: string } }> }>(this.bin, [
        "workflow", "get-node",
        "--work-item-id", workItemId,
        "--project-key", projectKey,
        "--node-id-list", "_all",
        "--format", "json",
      ]);
      const fe = (d.list ?? [])
        .map((n) => n.basic)
        .find((b) => b?.name && /^\s*(FE|前端)\s*(Release|发布)\s*$/i.test(b.name));
      return fe?.status === "finished";
    } catch {
      return false;
    }
  }

  /**
   * 单独拉一条工单（不经 mywork todo，所以没分派给我的也能拿到）。
   * 用来看缺陷关联的那个需求里有没有我的角色。
   */
  async getWorkItem(projectKey: string, workItemId: string): Promise<{ name: string; statusKey: string; roles: Array<{ role: string; memberKeys: string[] }> } | undefined> {
    try {
      const d = await runJson<WorkItem>(this.bin, [
        "workitem", "get",
        "--work-item-id", workItemId,
        "--project-key", projectKey,
        "--fields", "priority,tags,description",
        "--format", "json",
      ]);
      const a = d.work_item_attribute;
      return {
        name: a.work_item_name.trim(),
        statusKey: a.work_item_status.key ?? "",
        roles: (a.role_members ?? []).map((r) => ({ role: r.name, memberKeys: r.members.map((m) => m.key).filter((k): k is string => Boolean(k)) })),
      };
    } catch {
      return undefined;
    }
  }

  /**
   * 按 project key + 工单号单拉一条，拼成和同步链路同构的 MeegleWorkItem。
   * 用户贴链接手动加进来的工单当前节点多半不在他手上（所以进不了 mywork todo），
   * 因此没有 node / 排期，只能拿工单自身的字段。
   */
  async fetchOne(projectKey: string, workItemId: string): Promise<MeegleWorkItem> {
    const auth = await runJson<AuthStatus>(this.bin, ["auth", "status", "--format", "json"]);
    if (!auth.authenticated || !auth.host) throw new Error("Meegle 未登录，请在终端执行 meegle auth login");
    const d = await runJson<WorkItem>(this.bin, [
      "workitem", "get",
      "--work-item-id", workItemId,
      "--project-key", projectKey,
      "--fields", "priority,tags,description,_field_linked_story,field_8fe714,field_8190c7,field_1f7126",
      "--format", "json",
    ]);
    const a = d.work_item_attribute;
    const todo: TodoItem = { project_key: projectKey, work_item_info: { work_item_id: Number(a.work_item_id), work_item_type_key: a.work_item_type.key } };
    return toWorkItem(auth.host, todo, d);
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

  private async fetchRaw(): Promise<Array<[TodoItem, WorkItem, string, NodeSchedules]>> {
    const auth = await runJson<AuthStatus>(this.bin, ["auth", "status", "--format", "json"]);
    if (!auth.authenticated || !auth.host) throw new Error("Meegle 未登录，请在终端执行 meegle auth login");

    // todo-scope=all 而不是默认的 in_progress：别人不更新需求状态时，节点还没流转到我，
    // 但我的开发排期已经到了——只取 in_progress 那些一条都拉不到（实测漏掉 4 个已到期的需求）。
    const all: TodoItem[] = [];
    for (let page = 1; ; page++) {
      const res = await runJson<TodoPage>(this.bin, ["mywork", "todo", "--action", "todo", "--todo-scope", "all", "--page-num", String(page), "--format", "json"]);
      const list = res.list ?? [];
      all.push(...list);
      if (list.length === 0 || all.length >= res.total) break;
    }
    // 有排期且已经到时间的才接；all 会把同一工单的每个节点各返回一条，按工单挑一个。
    const items = pickDueNodes(all, new Date().toISOString().slice(0, 10));

    const details = await mapLimit(items, 3, (it) =>
      runJson<WorkItem>(this.bin, [
        "workitem", "get",
        "--work-item-id", String(it.work_item_info.work_item_id),
        "--project-key", it.project_key,
        // 缺陷多要一个 _field_linked_story（Meegle 里的「关联需求」）：很多缺陷标题里
        // 根本没有需求名（「【BO】开关开到关没有弹出二次确认弹窗」），只有这个字段能关联上
        "--fields", it.work_item_info.work_item_type_key === "issue" ? "priority,tags,description,_field_linked_story" : "priority,tags,description,field_8fe714,field_8190c7,field_1f7126",
        "--format", "json",
      ]),
    );
    const kept = items
      .map((it, i) => [it, details[i]!] as const)
      .filter(([, d]) => keepWorkItem(d.work_item_attribute.work_item_type.key, d.work_item_attribute.work_item_status.key ?? ""));
    const schedules = await mapLimit(kept, 3, ([it]) => this.nodeSchedules(it));
    return kept.map(([it, d], i) => [it, d, auth.host!, schedules[i]!]);
  }
}
