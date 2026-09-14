import type { TaskStatus, Urgency } from "@friday/shared";
import { MeegleConnector, type MeegleWorkItem } from "../connectors/meegle.js";
import { record } from "../memory/audit.js";
import { loadProjects, type Project } from "../memory/projects.js";
import { createTask, findTaskBySource, listTasks, updateTask } from "../memory/tasks.js";
import { syncSourceTodos } from "../memory/todos.js";
import { state } from "../scheduler/index.js";

export const meegleState = { lastSyncAt: null as string | null, lastError: null as string | null, running: false };

/** 工单标题里出现项目名或别名（≥3 个字符）就算属于那个项目。 */
export function matchProject(title: string, projects: Project[]): string | undefined {
  const t = title.toLowerCase();
  return projects.find((p) => [p.name, ...p.aliases].some((n) => n.length >= 3 && t.includes(n.toLowerCase())))?.name;
}

export function priorityOf(label?: string): Urgency {
  if (!label) return "normal";
  if (/^P[01]\b|紧急|urgent/i.test(label)) return "high";
  if (/^P2\b/i.test(label)) return "normal";
  return "low";
}

export function workItemToTask(item: MeegleWorkItem, projects: Project[]) {
  const priority = priorityOf(item.priority);
  const where = item.node ? `节点「${item.node}」在等你` : "分派给你";
  const understanding = [`Meegle ${item.typeName} #${item.id}，${where}，状态 ${item.status}`, item.priority ? `优先级 ${item.priority}` : "", item.due ? `截止 ${item.due.slice(0, 10)}` : ""]
    .filter(Boolean)
    .join("，");
  // 分派给我的工单一律先排队，不占「待我决定」：这个组织里 P0/P1 太常见，真要拍板的由 Slack/口头触发。
  const status: TaskStatus = "understood";
  const project = matchProject(item.name, projects);
  return { title: item.name.slice(0, 200), priority, understanding, status, ...(project ? { project } : {}), ...(item.due ? { due: item.due } : {}) };
}

const OPEN: TaskStatus[] = ["collected", "understood", "review"];

/** 拉一次分派给我的 Meegle 工单：新工单建任务，已有的更新，不再分派给我的自动完成。 */
export async function syncMeegleOnce(connector = new MeegleConnector()): Promise<{ added: number; closed: number; reopened: number }> {
  if (meegleState.running) return { added: 0, closed: 0, reopened: 0 };
  meegleState.running = true;
  try {
    const items = await connector.fetchWorkItems();
    syncSourceTodos("meegle", items.map(toTodoLike));
    const projects = loadProjects();
    let added = 0;
    let reopened = 0;
    for (const item of items) {
      const input = workItemToTask(item, projects);
      const existing = findTaskBySource((s) => s.meegleId === item.id, true);
      if (!existing) {
        const t = createTask({ ...input, kind: "meegle", source: { meegleId: item.id, url: item.url, meegleType: item.typeKey } });
        record({ taskId: t.id, action: "task_create", why: "Meegle 把这个工单分派给你", how: "同步分派列表时建任务", evidence: { meegleId: item.id, node: item.node ?? null, priority: item.priority ?? null }, risk: "read" });
        added++;
      } else if (OPEN.includes(existing.status)) {
        const { status: _s, ...patch } = input;
        // source 会与旧值合并，顺带把早先同步下来、还没有类型的工单补上 meegleType。
        updateTask(existing.id, { ...patch, source: { meegleType: item.typeKey } });
      } else if ((existing.status === "done" || existing.status === "ignored") && /reopen/i.test(item.status)) {
        // Friday 里已经收工，Meegle 里却被 Reopen 又分派回来：拉回待办并提醒。
        // 只认 Reopen 状态——用户在 Friday 里主动标完成而 Meegle 还挂着的，不能每 15 分钟翻回来。
        const { status: _s, ...patch } = input;
        updateTask(existing.id, { ...patch, status: "understood", attention: undefined, pending: [], source: { meegleType: item.typeKey } });
        record({ taskId: existing.id, action: "meegle_reopened", why: "Meegle 里这个工单被 Reopen，又分派给你", how: `状态 ${item.status}，从${existing.status === "done" ? "已完成" : "已忽略"}拉回待办`, evidence: { meegleId: item.id }, risk: "read" });
        state.notices.push({ title: `Meegle 工单 Reopen · ${item.projectName}`, body: item.name.slice(0, 120) });
        reopened++;
      }
    }
    const live = new Set(items.map((it) => it.id));
    let closed = 0;
    for (const t of listTasks(OPEN, 500)) {
      if (t.kind !== "meegle" || !t.source.meegleId || live.has(t.source.meegleId)) continue;
      updateTask(t.id, { status: "done" });
      record({ taskId: t.id, action: "meegle_done", why: "这个工单不再分派给你（已流转或关闭）", how: "同步时发现它不在分派列表里，标记完成", evidence: { meegleId: t.source.meegleId }, risk: "read" });
      closed++;
    }
    meegleState.lastSyncAt = new Date().toISOString();
    meegleState.lastError = null;
    return { added, closed, reopened };
  } catch (e) {
    meegleState.lastError = e instanceof Error ? e.message : String(e);
    console.error(`[meegle] ${meegleState.lastError}`);
    return { added: 0, closed: 0, reopened: 0 };
  } finally {
    meegleState.running = false;
  }
}

function toTodoLike(it: MeegleWorkItem) {
  const tag = [it.priority, it.typeName].filter(Boolean).join(" · ");
  return { id: `meegle:${it.id}`, text: `[${tag}] ${it.name}（${it.status}）`, source: "meegle" as const, sourceUrl: it.url, createdAt: it.createdAt, done: false, ...(it.due ? { due: it.due } : {}) };
}
