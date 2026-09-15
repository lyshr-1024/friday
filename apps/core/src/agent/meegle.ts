import type { StateTransition, Task, TaskStatus, Urgency } from "@friday/shared";
import { MeegleConnector, type MeegleWorkItem } from "../connectors/meegle.js";
import { record } from "../memory/audit.js";
import { loadProjects, matchProjectByUrl, type Project } from "../memory/projects.js";
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
  const understanding = [
    `Meegle ${item.typeName} #${item.id}，${where}，状态 ${item.status}`,
    item.priority ? `优先级 ${item.priority}` : "",
    item.feDue ? `后台前端排期 ${item.feDue}` : "",
    item.beDue ? `服务端排期 ${item.beDue}` : "",
    item.tags?.length ? `标签 ${item.tags.join("、")}` : "",
    item.due ? `截止 ${item.due.slice(0, 10)}` : "",
  ]
    .filter(Boolean)
    .join("，");
  // 分派给我的工单一律先排队，不占「待我决定」：这个组织里 P0/P1 太常见，真要拍板的由 Slack/口头触发。
  const status: TaskStatus = "understood";
  // 描述里的页面链接比标题可靠得多：标题只写「【BO 后台】…」，归不到仓库；链接带域名和 app 段。
  const project = matchProjectByUrl(item.links, projects)?.name ?? matchProject(item.name, projects);
  const page = item.links[0];
  const full = page ? `${understanding}。出问题的页面：${page}` : understanding;
  // 这些键始终写出（含 undefined），工单撤掉排期或标签时 source 的 merge 才能抹掉旧值
  const source = {
    meegleType: item.typeKey,
    meegleTags: item.tags,
    feDue: item.feDue,
    beDue: item.beDue,
    meegleProject: item.projectKey,
    statusKey: item.statusKey,
    reporter: item.reporter,
    description: item.description,
    docs: item.docs,
    nodeKey: item.nodeKey,
    nodeName: item.node,
  };
  return { title: item.name.slice(0, 200), priority, understanding: full, status, source, ...(project ? { project } : {}), ...(item.due ? { due: item.due } : {}) };
}

const OPEN: TaskStatus[] = ["collected", "understood", "review"];

/** 缺陷转到这个状态就不用我修了，任务直接收掉，不必等下一次同步。 */
const DONE_STATE = "RESOLVED";

function meegleRef(t: Task): { projectKey: string; workItemId: string } {
  const { meegleProject, meegleId } = t.source;
  if (!meegleProject || !meegleId) throw new Error("这条任务没有 Meegle 工单信息");
  return { projectKey: meegleProject, workItemId: meegleId };
}

export async function listTaskTransitions(t: Task, connector = new MeegleConnector()): Promise<StateTransition[]> {
  const { projectKey, workItemId } = meegleRef(t);
  return connector.listTransitions(projectKey, workItemId);
}

export async function applyTransition(t: Task, to: StateTransition, connector = new MeegleConnector()): Promise<Task> {
  const { projectKey, workItemId } = meegleRef(t);
  const from = t.source.statusKey ?? "";
  await connector.transitionState(projectKey, workItemId, to.id);
  record({
    taskId: t.id,
    action: "meegle_transition",
    why: `你在 Friday 里点了「${to.label}」`,
    how: `workflow transition-state → ${to.stateKey}`,
    evidence: { meegleId: workItemId, from, to: to.stateKey },
    risk: "reversible",
    ...(from ? { undo: { kind: "meegle_state" as const, projectKey, workItemId, backTo: from } } : {}),
  });
  const done = to.stateKey === DONE_STATE;
  return updateTask(t.id, { source: { statusKey: to.stateKey }, ...(done ? { status: "done" as TaskStatus, pending: [] } : {}) })!;
}

function nodeRef(t: Task): { projectKey: string; workItemId: string; nodeKey: string } {
  const { meegleProject, meegleId, nodeKey } = t.source;
  if (!meegleProject || !meegleId || !nodeKey) throw new Error("这条任务没有可流转的 Meegle 节点");
  return { projectKey: meegleProject, workItemId: meegleId, nodeKey };
}

export async function nodeReadiness(t: Task, connector = new MeegleConnector()): Promise<{ nodeKey: string; canConfirm: boolean; missing: string[] }> {
  const { projectKey, workItemId, nodeKey } = nodeRef(t);
  const { missing } = await connector.nodeReadiness(projectKey, workItemId, nodeKey);
  return { nodeKey, canConfirm: missing.length === 0, missing };
}

export async function confirmNode(t: Task, connector = new MeegleConnector()): Promise<Task> {
  const { projectKey, workItemId, nodeKey } = nodeRef(t);
  await connector.transitionNode(projectKey, workItemId, nodeKey, "confirm");
  record({
    taskId: t.id,
    action: "meegle_node_confirm",
    why: "你在 Friday 里点了「完成当前节点」",
    how: `workflow transition ${nodeKey} confirm`,
    evidence: { meegleId: workItemId, nodeKey },
    risk: "reversible",
    undo: { kind: "meegle_node" as const, projectKey, workItemId, nodeKey },
  });
  // 节点推给下游后这条多半不再分派给我；万一还在，下次同步会把它复活
  return updateTask(t.id, { status: "done", pending: [] })!;
}

export async function rollbackNode(plan: { projectKey: string; workItemId: string; nodeKey: string }, connector = new MeegleConnector()): Promise<boolean> {
  await connector.transitionNode(plan.projectKey, plan.workItemId, plan.nodeKey, "rollback", "Friday 撤销了这次流转");
  return true;
}

/** 撤销一笔流转：重新问 Meegle 现在能不能转回去，不能就如实失败。 */
export async function undoTransition(plan: { projectKey: string; workItemId: string; backTo: string }, connector = new MeegleConnector()): Promise<boolean> {
  const back = (await connector.listRawTransitions(plan.projectKey, plan.workItemId)).find((x) => x.state_key === plan.backTo);
  if (!back) return false;
  await connector.transitionState(plan.projectKey, plan.workItemId, String(back.id));
  return true;
}

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
        const t = createTask({ ...input, kind: "meegle", source: { meegleId: item.id, url: item.url, ...input.source } });
        record({ taskId: t.id, action: "task_create", why: "Meegle 把这个工单分派给你", how: "同步分派列表时建任务", evidence: { meegleId: item.id, node: item.node ?? null, priority: item.priority ?? null }, risk: "read" });
        added++;
      } else if (OPEN.includes(existing.status)) {
        const { status: _s, ...patch } = input;
        // source 会与旧值合并，顺带把早先同步下来、还没有类型和排期的工单补齐。
        updateTask(existing.id, { ...patch, source: input.source });
      } else if ((existing.status === "done" || existing.status === "ignored") && /reopen/i.test(item.status)) {
        // Friday 里已经收工，Meegle 里却被 Reopen 又分派回来：拉回待办并提醒。
        // 只认 Reopen 状态——用户在 Friday 里主动标完成而 Meegle 还挂着的，不能每 15 分钟翻回来。
        const { status: _s, ...patch } = input;
        updateTask(existing.id, { ...patch, status: "understood", attention: undefined, pending: [], source: input.source });
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
