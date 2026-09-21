import { AUTOSTART_CATEGORY, type StateTransition, type Task, type TaskStatus, type Urgency } from "@friday/shared";
import { MeegleConnector, type MeegleWorkItem } from "../connectors/meegle.js";
import { record } from "../memory/audit.js";
import { loadProjects, matchProjectByUrl, resolveProject, type Project } from "../memory/projects.js";
import { judgeIntake } from "./intake.js";
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
    const existing = findTaskBySource((s) => s.meegleId === linkedStoryId || (s.mergedMeegleIds ?? []).includes(linkedStoryId), true);
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
    // 项目由用户手动指定，不按标题猜
    const project = undefined;
    const t = createTask({
      title: story.name || name || `Meegle 需求 #${storyId}`,
      kind: "meegle",
      status: "understood",
      stage: "todo",
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

export function workItemToTask(item: MeegleWorkItem, projects: Project[], manual = false) {
  const priority = priorityOf(item.priority);
  // 手动贴链接加进来的，当前节点多半不在他手上，别谎称「分派给你」
  const where = item.node ? `节点「${item.node}」在等你` : manual ? "你手动加进来的" : "分派给你";
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
  // 不自动猜项目：标题里有没有项目名跟它属于哪个仓库没关系（「养牛计划1.0」这种一个字
  // 都对不上），猜错了开工就改错仓库。项目由你在任务卡上手动指定。
  // 唯一的例外是缺陷跟着它所属的需求走——那是 Meegle 里填好的事实，不是猜的。
  const project = item.linkedStory
    ? findTaskBySource(
        (s) => s.meegleId === item.linkedStory!.id || (s.mergedMeegleIds ?? []).includes(item.linkedStory!.id),
        true,
      )?.project
    : undefined;
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
  // 新工单一律从「未开始」起步。Meegle 那边的状态不拿来定阶段——它依赖别人及时更新，不可信。
  return { title: item.name.slice(0, 200), priority, understanding: full, status, stage: "todo" as const, source, ...(project ? { project } : {}), ...(item.due ? { due: item.due } : {}) };
}

/**
 * 从 Meegle 链接里拆出 project key 和工单号：
 * https://project.larksuite.com/projectlb/story/detail/24487610 → projectlb / 24487610
 * 光给一串数字不行——project key 只能从链接来。
 */
export function parseMeegleRef(input: string): { projectKey: string; workItemId: string } | undefined {
  const m = /\/([A-Za-z0-9_-]+)\/[A-Za-z0-9_]+\/detail\/(\d+)/.exec(input.trim());
  return m ? { projectKey: m[1]!, workItemId: m[2]! } : undefined;
}

/** 按链接单拉一条 Meegle 工单建成任务。已经在板上的不重复建，直接返回那条。 */
export async function addMeegleByRef(
  link: string,
  connector = new MeegleConnector(),
): Promise<{ task: Task; existed: boolean } | { error: string }> {
  const ref = parseMeegleRef(link);
  if (!ref) return { error: "看不出这是哪条工单。需要完整的 Meegle 链接，形如 https://project.larksuite.com/<空间>/story/detail/<工单号>。" };
  const existing = findTaskBySource((s) => s.meegleId === ref.workItemId || (s.mergedMeegleIds ?? []).includes(ref.workItemId), true);
  if (existing) return { task: existing, existed: true };
  const item = await connector.fetchOne(ref.projectKey, ref.workItemId);
  const input = workItemToTask(item, loadProjects(), true);
  const task = createTask({ ...input, kind: "meegle", source: { meegleId: item.id, url: item.url, ...input.source } });
  record({ taskId: task.id, action: "task_create", why: "用户贴了工单链接让 Friday 建进任务板", how: "按链接单拉 Meegle 工单", evidence: { meegleId: item.id, projectKey: ref.projectKey, status: item.status }, risk: "reversible" });
  return { task, existed: false };
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
      const existing = findTaskBySource((s) => s.meegleId === item.id || (s.mergedMeegleIds ?? []).includes(item.id), true);
      if (!existing) {
        const t = createTask({ ...input, kind: "meegle", source: { meegleId: item.id, url: item.url, ...input.source } });
        record({ taskId: t.id, action: "task_create", why: "Meegle 把这个工单分派给你", how: "同步分派列表时建任务", evidence: { meegleId: item.id, node: item.node ?? null, priority: item.priority ?? null }, risk: "read" });
        added++;
        fresh.push({ task: t, item });
      } else if (OPEN.includes(existing.status)) {
        const { status: _s, ...patch } = input;
        const isSelf = existing.source.meegleId === item.id;
        if (isSelf) {
          // source 会与旧值合并，顺带把早先同步下来、还没有类型和排期的工单补齐。
          updateTask(existing.id, { ...patch, source: input.source });
        } else {
          // 这是并进来的另一个工单，不是本体：别拿它的标题覆盖主任务，
          // 也别让它的 linkedStoryId 改掉主任务的归属
          const { linkedStoryId: _l, ...rest } = input.source;
          const { title: _t, understanding: _u, ...keep } = patch;
          updateTask(existing.id, { ...keep, source: rest });
        }
      } else if ((existing.status === "done" || existing.status === "ignored") && /reopen/i.test(item.status)) {
        // Friday 里已经收工，Meegle 里却被 Reopen 又分派回来：拉回待办并提醒。
        // 只认 Reopen 状态——用户在 Friday 里主动标完成而 Meegle 还挂着的，不能每 15 分钟翻回来。
        const { status: _s, ...patch } = input;
        // 阶段也得跟着回退：Friday 里标着「已上线」的活又被打回来了，
        // 留着旧阶段会让卡片显示一个早就不成立的结论。回到「进行中」等你重新判。
        updateTask(existing.id, { ...patch, status: "understood", attention: undefined, pending: [], source: input.source, stage: "dev", stageBy: "auto", stagePrev: existing.stage, releasedAt: undefined });
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
        const own = new Set([...(t.source.meegleId ? [t.source.meegleId] : []), ...(t.source.mergedMeegleIds ?? [])]);
        const kids = listTasks().filter((x) => x.source.linkedStoryId && own.has(x.source.linkedStoryId));
        if (!containerDone(kids)) continue;
        updateTask(t.id, { status: "done" });
        record({ taskId: t.id, action: "meegle_done", why: "名下的缺陷都处理完了", how: `${kids.length} 条缺陷全部收工，需求容器一起收尾`, evidence: { meegleId: t.source.meegleId }, risk: "read" });
        closed++;
        continue;
      }
      // 不在 mywork todo 里只说明当前节点不在你手上（流去测试 / 服务端了），不代表这件事完了。
      // 出池的唯一判据是「FE 发布」节点走完（2026-09-20 与用户定）：只要前端还没发布，
      // 需求就一直留在池子里，你还要持续关注它。
      if (!t.source.meegleProject) continue;
      // 它已经不在 mywork todo 里，上面那轮刷不到它，这里单独问一次把节点状态跟上
      const now = await connector.getWorkItem(t.source.meegleProject, t.source.meegleId);
      if (now && now.statusKey !== t.source.statusKey) {
        updateTask(t.id, { source: { statusKey: now.statusKey } });
      }
      if (!(await connector.feReleased(t.source.meegleProject, t.source.meegleId))) continue;
      updateTask(t.id, { status: "done" });
      record({ taskId: t.id, action: "meegle_done", why: "「FE 发布」节点已经走完", how: "前端已发布，从需求池里收掉", evidence: { meegleId: t.source.meegleId }, risk: "read" });
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

  // 项目由你在任务卡上手动选，选完就直接开工（见 POST /tasks/:id/project）。
  // 这里既不替你猜项目，也不挂「开工」待审——那等于让你为同一件事点两次。
  console.log(`[meegle] ${item.id} 进待办，等你在卡上选项目：${verdict.why}`);
}

function toTodoLike(it: MeegleWorkItem) {
  const tag = [it.priority, it.typeName].filter(Boolean).join(" · ");
  return { id: `meegle:${it.id}`, text: `[${tag}] ${it.name}（${it.status}）`, source: "meegle" as const, sourceUrl: it.url, createdAt: it.createdAt, done: false, ...(it.due ? { due: it.due } : {}) };
}
