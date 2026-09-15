import type { Todo } from "@friday/shared";
import type { Connector } from "./types.js";
import { mapLimit, runJson } from "./exec.js";

interface AuthStatus {
  authenticated: boolean;
  host: string | null;
}

interface TodoItem {
  project_key: string;
  project_name?: string;
  node_info?: { node_name?: string };
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
  priority?: string;
  node?: string;
  projectName: string;
  url: string;
  createdAt: string;
  due?: string;
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
    owned_project: { simple_name: string };
    work_item_status: { name: string };
    work_item_type: { key: string; name: string };
  };
  work_item_fields: Array<{ key: string; value: unknown }>;
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

export function toWorkItem(host: string, todo: TodoItem, item: WorkItem): MeegleWorkItem {
  const a = item.work_item_attribute;
  const priority = (item.work_item_fields.find((f) => f.key === "priority")?.value as { label?: string } | undefined)?.label;
  const due = todo.schedule?.end_time?.trim();
  return {
    id: a.work_item_id,
    name: a.work_item_name.trim(),
    typeName: a.work_item_type.name,
    typeKey: a.work_item_type.key,
    links: extractLinks(item.work_item_fields.find((f) => f.key === "description")?.value),
    status: a.work_item_status.name,
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
    return (await this.fetchRaw()).map(([it, d, host]) => toWorkItem(host, it, d));
  }

  private async fetchRaw(): Promise<Array<[TodoItem, WorkItem, string]>> {
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
        "--fields", "priority,description",
        "--format", "json",
      ]),
    );
    return details.map((d, i) => [items[i]!, d, auth.host!]);
  }
}
