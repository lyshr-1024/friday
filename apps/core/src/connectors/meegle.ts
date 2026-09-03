import type { Todo } from "@friday/shared";
import type { Connector } from "./types.js";
import { mapLimit, runJson } from "./exec.js";

interface AuthStatus {
  authenticated: boolean;
  host: string | null;
}

interface TodoItem {
  project_key: string;
  work_item_info: { work_item_id: number; work_item_type_key: string };
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

export class MeegleConnector implements Connector {
  source = "meegle" as const;

  constructor(private bin = "meegle") {}

  async fetchTodos(): Promise<Todo[]> {
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
        "--fields", "priority",
        "--format", "json",
      ]),
    );
    return details.map((d) => toTodo(auth.host!, d));
  }
}
