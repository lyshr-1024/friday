import { AUTOSTART_CATEGORY, type StateTransition, type Task, type TaskStatus, type Urgency } from "@friday/shared";
import { MeegleConnector, type MeegleWorkItem } from "../connectors/meegle.js";
import { record } from "../memory/audit.js";
import { loadProjects, matchProjectByUrl, resolveProject, type Project } from "../memory/projects.js";
import { judgeIntake } from "./intake.js";
import { decideStart } from "./gate.js";
import { getThreshold } from "../memory/thresholds.js";
import { startAutonomousJob } from "./pipeline.js";
import { addPending, createTask, findTaskBySource, listTasks, updateTask } from "../memory/tasks.js";
import { syncSourceTodos } from "../memory/todos.js";
import { state } from "../scheduler/index.js";

export const meegleState = { lastSyncAt: null as string | null, lastError: null as string | null, running: false };

const OPEN: TaskStatus[] = ["collected", "understood", "review"];

/** 中文两个字（风控、基金）已经够独特，拉丁字母短词太容易撞进别的词里（bo 命中 bond），仍要三个。 */
function distinctive(name: string): boolean {
  return /[\u4e00-\u9fa5]/.test(name) ? name.length >= 2 : name.length >= 3;
}

/** 工单标题里出现项目名或别名就算属于那个项目。 */
export function matchProject(title: string, projects: Project[]): string | undefined {
  const t = title.toLowerCase();
  return projects.find((p) => [p.name, ...p.aliases].some((n) => distinctive(n) && t.includes(n.toLowerCase())))?.name;
}

/**
 * 顺着关联需求找项目：需求那条任务已经归好项目就直接用，否则拿需求标题再匹配一次。
 * 缺陷标题里往往只有【BO】这类泛指，需求标题才带得上项目名。
 */
export function projectOfStory(story: { id: string; name: string }, projects: Project[]): string | undefined {
  const parent = findTaskBySource((s) => s.meegleId === story.id, true);
  return parent?.project ?? matchProject(story.name, projects);
}

/**
 * 需求里我担着哪些角色。判据是 user_key，不靠名字。
 * 一个角色可以有多个成员（真实数据里 Business owner 常常两人），只要包含我就算。
 * 不按角色类型过滤：用户明确要求任何角色里有自己都算这需求归他。
 */
export function myRoles(roles: Array<{ role: string; memberKeys: string[] }>, me: string): string[] {
  return roles.filter((r) => r.memberKeys.includes(me)).map((r) => r.role);
}

/** 关了的需求不必再拉进来当容器。 */
const STORY_CLOSED = /^(CLOSED|RESOLVED|DONE|CANCELLED)$/i;

/**
 * 同一个需求下已经有一条在问归属了吗。有就别再问第二遍——答案是同一个。
 * 没挂在需求下的（linkedStoryId 为空）各问各的，它们确实是不同的事。
 */
export function alreadyAsking(task: Task, tasks?: Task[]): Task | undefined {
  const story = task.source.linkedStoryId;
  if (!story) return undefined;
  const pool = tasks ?? listTasks(OPEN, 500);
  return pool.find((t) => t.id !== task.id && t.attention === "intake" && t.source.linkedStoryId === story);
}

/**
 * 需求容器该不该跟着收尾：名下缺陷全部收工才收。
 * 容器本来就不在 Meegle 的分派列表里（当前节点在别人手上），不能按「不再分派给你」判。
 * 一条缺陷都没有时也不收——刚建出来还没挂上就被收掉了。
 */
export function containerDone(kids: Array<Pick<Task, "status">>): boolean {
  return kids.length > 0 && kids.every((x) => x.status === "done" || x.status === "ignored");
}

/**
 * 缺陷关联的需求不在任务板里（当前节点不在我手上，所以不在 mywork todo），
 * 但只要需求的角色成员里有我，它就是我的活——拉进来建一条任务当容器，
 * 名下的缺陷挂在它下面，列表里不再各自占一行。
 */
export async function ensureStoryContainers(connector = new MeegleConnector()): Promise<number> {
  const orphans = new Map<string, { projectKey: string; name: string }>();
  for (const t of listTasks(OPEN, 500)) {
    const { linkedStoryId, linkedStoryName, meegleProject } = t.source;
    if (!linkedStoryId || !meegleProject) continue;
    // 只有「还开着的需求任务」才算容器已到位。已经收掉的不算——否则一旦被误收，
    // 它会被当成已存在而永远不再复活。
    const existing = findTaskBySource((s) => s.meegleId === linkedStoryId, true);
    if (existing && existing.status !== "done" && existing.status !== "ignored") continue;
    // 用户自己标忽略的别硬拉回来
    if (existing?.status === "ignored") continue;
    orphans.set(linkedStoryId, { projectKey: meegleProject, name: linkedStoryName ?? "" });
  }
  if (!orphans.size) return 0;
  const me = await connector.myKey();
  if (!me) {
    console.log("[meegle] 拿不到当前用户 key，跳过需求容器");
    return 0;
  }

  let made = 0;
  for (const [storyId, { projectKey, name }] of orphans) {
    // 这个容器之前建过又被收了（名下缺陷当时都完了），现在又来了新缺陷：拉回来复用，
    // 不必重新问一次 Meegle。只复活容器，不碰用户真正完成过的、分派给他的需求工单。
    const closedBefore = findTaskBySource((s) => s.meegleId === storyId && Boolean(s.storyContainer), true);
    if (closedBefore) {
      updateTask(closedBefore.id, { status: "understood" });
      record({ taskId: closedBefore.id, action: "story_container_revived", why: "名下还有没处理完的缺陷", how: "容器之前被自动收尾误收，拉回待办", evidence: { meegleId: storyId }, risk: "read" });
      made += 1;
      continue;
    }
    const story = await connector.getWorkItem(projectKey, storyId);
    if (!story) continue;
    if (STORY_CLOSED.test(story.statusKey)) continue;
    const roles = myRoles(story.roles, me);
    if (!roles.length) continue;
    const projects = loadProjects();
    const project = matchProject(story.name, projects);
    const t = createTask({
      title: story.name || name || `Meegle 需求 #${storyId}`,
      kind: "meegle",
      status: "understood",
      understanding: `Meegle 需求 #${storyId}，我在这个需求里担 ${roles.join("、")}。当前节点不在我手上（状态 ${story.statusKey}），但名下的缺陷要我改。`,
      source: { meegleId: storyId, meegleProject: projectKey, meegleType: "story", statusKey: story.statusKey, storyContainer: true },
      ...(project ? { project } : {}),
    });
    record({
      taskId: t.id,
      action: "story_container_created",
      why: `名下有分派给我的缺陷，而我在这个需求里担 ${roles.join("、")}`,
      how: "把需求拉进任务板当容器，缺陷挂在它下面",
      evidence: { meegleId: storyId, roles, statusKey: story.statusKey },
      risk: "read",
    });
    made += 1;
  }
  return made;
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
    item.linkedStory ? `属于需求「${item.linkedStory.name}」#${item.linkedStory.id}` : "",
    item.due ? `截止 ${item.due.slice(0, 10)}` : "",
  ]
    .filter(Boolean)
    .join("，");
  // 分派给我的工单一律先排队，不占「待我决定」：这个组织里 P0/P1 太常见，真要拍板的由 Slack/口头触发。
  const status: TaskStatus = "understood";
  // 描述里的页面链接比标题可靠得多：标题只写「【BO 后台】…」，归不到仓库；链接带域名和 app 段。
  // 再兜一层关联需求：缺陷标题常常不带需求名（「【BO】开关开到关没有弹出二次确认弹窗」），
  // 但它挂在哪个需求下是 Meegle 里填好的，需求那条已经归过项目就顺着拿。
  const project =
    matchProjectByUrl(item.links, projects)?.name ??
    matchProject(item.name, projects) ??
    (item.linkedStory ? projectOfStory(item.linkedStory, projects) : undefined);
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
    linkedStoryId: item.linkedStory?.id,
    linkedStoryName: item.linkedStory?.name,
  };
  return { title: item.name.slice(0, 200), priority, understanding: full, status, source, ...(project ? { project } : {}), ...(item.due ? { due: item.due } : {}) };
}

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
    const fresh: Array<{ task: Task; item: MeegleWorkItem }> = [];
    for (const item of items) {
      const input = workItemToTask(item, projects);
      const existing = findTaskBySource((s) => s.meegleId === item.id, true);
      if (!existing) {
        const t = createTask({ ...input, kind: "meegle", source: { meegleId: item.id, url: item.url, ...input.source } });
        record({ taskId: t.id, action: "task_create", why: "Meegle 把这个工单分派给你", how: "同步分派列表时建任务", evidence: { meegleId: item.id, node: item.node ?? null, priority: item.priority ?? null }, risk: "read" });
        added++;
        fresh.push({ task: t, item });
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
      // 需求容器本来就不在分派列表里（当前节点在别人手上），这正是它要当容器的原因——
      // 不能按「不再分派给你」把它收掉，否则建出来下次同步就没了。
      // 它的收尾由名下缺陷决定：缺陷都完了才跟着收。
      if (t.source.storyContainer) {
        const kids = listTasks().filter((x) => x.source.linkedStoryId === t.source.meegleId);
        if (!containerDone(kids)) continue;
        updateTask(t.id, { status: "done" });
        record({ taskId: t.id, action: "meegle_done", why: "名下的缺陷都处理完了", how: `${kids.length} 条缺陷全部收工，需求容器一起收尾`, evidence: { meegleId: t.source.meegleId }, risk: "read" });
        closed++;
        continue;
      }
      updateTask(t.id, { status: "done" });
      record({ taskId: t.id, action: "meegle_done", why: "这个工单不再分派给你（已流转或关闭）", how: "同步时发现它不在分派列表里，标记完成", evidence: { meegleId: t.source.meegleId }, risk: "read" });
      closed++;
    }
    // 缺陷关联的需求不在任务板里时，只要我在那个需求里担角色就拉进来当容器
    try {
      const made = await ensureStoryContainers(connector);
      if (made) console.log(`[meegle] 拉进 ${made} 条需求当容器`);
    } catch (e) {
      console.error(`[meegle] 建需求容器失败：${e instanceof Error ? e.message : String(e)}`);
    }
    meegleState.lastSyncAt = new Date().toISOString();
    meegleState.lastError = null;
    // 新工单逐条过一道「能不能自己动手」。放在最后、串行跑：判断要调模型，
    // 失败也不该影响同步本身已经完成的部分。
    for (const f of fresh) {
      try {
        await intakeWorkItem(f.task, f.item);
      } catch (e) {
        console.error(`[meegle] 判断 ${f.item.id} 能否开工时出错：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return { added, closed, reopened };
  } catch (e) {
    meegleState.lastError = e instanceof Error ? e.message : String(e);
    console.error(`[meegle] ${meegleState.lastError}`);
    return { added: 0, closed: 0, reopened: 0 };
  } finally {
    meegleState.running = false;
  }
}

/** 新工单的自动处置：能做的直接开终端，缺项目归属的问用户一句，其余排队。 */
export async function intakeWorkItem(task: Task, item: MeegleWorkItem, judge = judgeIntake): Promise<void> {
  const verdict = await judge(task, item.description ?? "", loadProjects());
  if (verdict.kind === "queue") {
    console.log(`[meegle] ${item.id} 排队：${verdict.why}`);
    return;
  }

  if (verdict.kind === "ask") {
    // 同一个需求下的几条缺陷归属是同一个答案，问一遍就够——实测一个需求下
    // 三条缺陷各问了一次「这是哪个项目的」，答一次该覆盖全部。
    const asked = alreadyAsking(task);
    if (asked) {
      updateTask(task.id, { progress: `等你回答「${asked.title.slice(0, 20)}」那条的归属，同一个需求下的一起定` });
      console.log(`[meegle] ${item.id} 的归属跟着同需求那条一起问，不重复提问`);
      return;
    }
    updateTask(task.id, { attention: "intake", progress: verdict.question });
    record({
      taskId: task.id,
      action: "intake_ask",
      why: verdict.why || "自己判断不了，需要用户给一句",
      how: verdict.question,
      evidence: { meegleId: item.id, ...(task.source.linkedStoryId ? { linkedStoryId: task.source.linkedStoryId } : {}) },
      risk: "read",
    });
    state.notices.push({ title: `有条工单要问你 · ${item.projectName}`, body: verdict.question });
    return;
  }

  const dir = resolveProject(verdict.project);
  if (dir.kind !== "match") {
    console.log(`[meegle] ${item.id} 排队：项目 ${verdict.project} 定位不到目录`);
    return;
  }
  const t = updateTask(task.id, { project: dir.project.name })!;
  const threshold = getThreshold(AUTOSTART_CATEGORY);
  const payload = { project: dir.project.name, dir: dir.project.dir, detail: verdict.detail, confidence: verdict.confidence, meegleId: item.id };

  if (decideStart(verdict.confidence, threshold) === "auto") {
    await startAutonomousJob(t, dir.project.name, dir.project.dir, verdict.detail);
    record({
      taskId: task.id,
      action: "intake_start",
      why: `置信度 ${verdict.confidence} 不低于开工阈值 ${threshold}：${verdict.why}`,
      how: `在 ${dir.project.name} 上自主开工`,
      evidence: { ...payload, auto: true },
      risk: "reversible",
    });
    state.notices.push({ title: `已开始做 · ${dir.project.name}`, body: item.name.slice(0, 120) });
    return;
  }

  // 阈值没到：挂成待审动作等用户点。用户点通过 / 打回的记录会回流成 lessons，阈值自己校准。
  // 状态留在待办里：一条还没开工的工单不是「阻塞你的事」，不该进「待我决定」。
  addPending(task.id, {
    type: "start_job",
    label: `开工：${dir.project.name}`,
    detail: verdict.detail,
    payload,
  }, { keepStatus: true });
  record({
    taskId: task.id,
    action: "intake_start_pending",
    why: threshold >= 100 ? `开工闸门默认关着（阈值 ${threshold}），等你点` : `置信度 ${verdict.confidence} 低于开工阈值 ${threshold}`,
    how: `拟在 ${dir.project.name} 上开工：${verdict.why}`,
    evidence: payload,
    risk: "reversible",
    status: "pending",
  });
  state.notices.push({ title: `有条工单可以开工 · ${dir.project.name}`, body: item.name.slice(0, 120) });
}

function toTodoLike(it: MeegleWorkItem) {
  const tag = [it.priority, it.typeName].filter(Boolean).join(" · ");
  return { id: `meegle:${it.id}`, text: `[${tag}] ${it.name}（${it.status}）`, source: "meegle" as const, sourceUrl: it.url, createdAt: it.createdAt, done: false, ...(it.due ? { due: it.due } : {}) };
}
