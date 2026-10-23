import { workItemOf, type ExternalRef, type StateTransition, type Task, type TaskSource, type TaskStatus, type Urgency } from "@friday/shared";
import { onSignal } from "./stage.js";
import { fillDocTitles, syncDocs } from "./docTitle.js";
import type { MeegleWorkItem } from "../connectors/meegle/client.js";
import "../connectors/meegle/index.js";
import { role, type WorkItemsRole } from "../connectors/roles.js";
import type { Caller } from "../connectors/invoke.js";
import { record } from "../memory/audit.js";
import { loadProjects, matchProjectByUrl, resolveProject, type Project } from "../memory/projects.js";
import { judgeIntake } from "./intake.js";
import { finishTask, startAutonomousJob } from "./pipeline.js";
import { addPending, createTask, findTaskBySource, getTask, listTasks, updateTask } from "../memory/tasks.js";
import { userSettings } from "../settings.js";
import { state } from "../scheduler/index.js";
import { runsForTask, setRunOutcome } from "../memory/runs.js";
import { holdClosedDefect, isFridayWork } from "./reproject.js";
import { clearHanded } from "./handedBugs.js";
import { getJob } from "../memory/jobs.js";
import { liveRootId, resolveRoot } from "./sessions.js";

export const workItemSyncState = { lastSyncAt: null as string | null, lastError: null as string | null, running: false };

const OPEN: TaskStatus[] = ["collected", "understood", "review"];
// 收工检查还要看卡住的和在做的：准备段失败卡住的缺陷被测试关了，原来一直挂着（2026-10-20）
const UNFINISHED: TaskStatus[] = [...OPEN, "blocked", "processing"];

/** 这张卡是不是这条工单：本体，或者并进来的 */
const holds = (s: TaskSource, id: string): boolean => workItemOf(s)?.id === id || (s.mergedIds ?? []).includes(id);
const parentId = (t: Task): string | undefined => workItemOf(t.source)?.parent?.id;
const isDefect = (t: Task): boolean => workItemOf(t.source)?.kind === "defect";

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
  const parent = findTaskBySource((s) => workItemOf(s)?.id === story.id, true);
  return parent?.project ?? matchProject(story.name, projects);
}

/**
 * 同一个需求下已经有一条在问归属了吗。有就别再问第二遍——答案是同一个。
 * 没挂在需求下的（parent 为空）各问各的，它们确实是不同的事。
 */
export function alreadyAsking(task: Task, tasks?: Task[]): Task | undefined {
  const story = parentId(task);
  if (!story) return undefined;
  const pool = tasks ?? listTasks(OPEN, 500);
  return pool.find((t) => t.id !== task.id && t.attention === "intake" && parentId(t) === story);
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
 * 缺陷关联的需求不在任务板里（当前节点不在我手上，所以不在 mywork todo）：拉进来建一条任务当容器，
 * 名下的缺陷挂在它下面，列表里不再各自占一行。不看我在需求里有没有角色——缺陷分派给我就是我的活，
 * 「清结算需求」那种角色里只有产品、服务端、QA 的，缺陷照样一条条散在列表里（2026-10-20）。
 */
export async function ensureContainers(items: WorkItemsRole = role("workItems")): Promise<number> {
  const orphans = new Map<string, { ref: ExternalRef; name: string; newest: string }>();
  for (const t of listTasks(OPEN, 500)) {
    const ext = workItemOf(t.source);
    const ref = ext && items.parentRef(ext);
    if (!ext?.parent || !ref) continue;
    const storyId = ext.parent.id;
    // 只有「还开着的需求任务」才算容器已到位。已经收掉的不算——否则一旦被误收，
    // 它会被当成已存在而永远不再复活。
    const existing = findTaskBySource((s) => holds(s, storyId), true);
    if (existing && existing.status !== "done" && existing.status !== "ignored") continue;
    // 用户自己标忽略的别硬拉回来
    if (existing?.status === "ignored") continue;
    const prev = orphans.get(storyId)?.newest ?? "";
    orphans.set(storyId, { ref, name: ext.parent.name ?? "", newest: t.createdAt > prev ? t.createdAt : prev });
  }
  if (!orphans.size) return 0;

  let made = 0;
  for (const [storyId, { ref, name, newest }] of orphans) {
    // 这个容器之前建过又被收了，现在名下又有开着的缺陷：拉回来复用，不必重新问一次 Meegle。
    // 只复活容器，不碰用户真正完成过的、分派给他的需求工单。
    const closedBefore = findTaskBySource((s) => workItemOf(s)?.id === storyId && Boolean(s.container), true);
    if (closedBefore) {
      // 你自己标完成的，当时还开着的缺陷算你看过了（多半已提测、等测试关），
      // 只有之后新来的缺陷才拉回——原来一律复活，标多少次完成都会被翻回来（2026-09-28）
      if (!closedBefore.source.autoClosed && newest <= closedBefore.updatedAt) continue;
      updateTask(closedBefore.id, { status: "understood", source: { autoClosed: undefined } });
      record({ taskId: closedBefore.id, action: "story_container_revived", why: "名下还有没处理完的缺陷", how: "容器之前被自动收尾误收，拉回待办", evidence: { meegleId: storyId }, risk: "read" });
      made += 1;
      continue;
    }
    const story = await items.get(ref);
    if (!story) continue;
    if (story.state === "done") continue;
    // 项目由用户手动指定，不按标题猜
    const project = undefined;
    const t = createTask({
      title: story.name || name || `Meegle 需求 #${storyId}`,
      kind: "work_item",
      status: "understood",
      stage: "todo",
      understanding: `Meegle 需求 #${storyId}，当前节点不在我手上（状态 ${story.stateLabel}），但名下有缺陷分派给我。`,
      source: { external: { ...ref, kind: items.kindOf(story.typeKey ?? "story"), ...(story.stateKey ? { state: { key: story.stateKey } } : {}) }, container: true },
      ...(project ? { project } : {}),
    });
    record({
      taskId: t.id,
      action: "story_container_created",
      why: "名下有分派给我的缺陷",
      how: "把需求拉进任务板当容器，缺陷挂在它下面",
      evidence: { meegleId: storyId, statusKey: story.stateKey },
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

export function workItemToTask(item: MeegleWorkItem, projects: Project[], manual = false, items: WorkItemsRole = role("workItems")) {
  const priority = priorityOf(item.priority);
  const ext = items.external(item);
  // 手动贴链接加进来的，当前节点多半不在他手上，别谎称「分派给你」
  const where = item.node ? `节点「${item.node}」在等你` : manual ? "你手动加进来的" : "分派给你";
  const understanding = [
    `Meegle ${item.typeName} #${item.id}，${where}，状态 ${item.status}`,
    item.priority ? `优先级 ${item.priority}` : "",
    ext.schedule?.frontend ? `后台前端排期 ${ext.schedule.frontend}` : "",
    ext.schedule?.backend ? `服务端排期 ${ext.schedule.backend}` : "",
    ext.tags?.length ? `标签 ${ext.tags.join("、")}` : "",
    ext.parent ? `属于需求「${ext.parent.name ?? ""}」#${ext.parent.id}` : "",
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
  const story = ext.parent?.id;
  const project = story ? findTaskBySource((s) => holds(s, story), true)?.project : undefined;
  const page = item.links[0];
  const full = page ? `${understanding}。出问题的页面：${page}` : understanding;
  // external 整个换掉，工单撤掉排期或标签时旧值才会被抹掉；description 始终写出（含 undefined）同理
  const source: TaskSource = { external: ext, description: item.description, docs: item.docs };
  // 新工单一律从「未开始」起步。Meegle 那边的状态不拿来定阶段——它依赖别人及时更新，不可信。
  return { title: item.name.slice(0, 200), priority, understanding: full, status, stage: "todo" as const, source, ...(project ? { project } : {}), ...(item.due ? { due: item.due } : {}) };
}

/** 按链接单拉一条 Meegle 工单建成任务。已经在板上的不重复建，直接返回那条。 */
export async function addWorkItemByRef(
  link: string,
  items: WorkItemsRole = role("workItems"),
): Promise<{ task: Task; existed: boolean } | { error: string }> {
  const ref = items.parseRef(link);
  if (!ref) return { error: "看不出这是哪条工单。需要完整的 Meegle 链接，形如 https://project.larksuite.com/<空间>/story/detail/<工单号>。" };
  const existing = findTaskBySource((s) => holds(s, ref.id), true);
  if (existing) return { task: existing, existed: true };
  const item = await items.fetchOne(ref);
  const input = workItemToTask(item, loadProjects(), true, items);
  const task = createTask({ ...input, kind: "work_item", source: { url: item.url, ...input.source } });
  record({ taskId: task.id, action: "task_create", why: "用户贴了工单链接让 Friday 建进任务板", how: "按链接单拉 Meegle 工单", evidence: { meegleId: item.id, projectKey: item.projectKey, status: item.status }, risk: "reversible" });
  return { task, existed: false };
}

function refOf(t: Task, items: WorkItemsRole): ExternalRef {
  const ext = workItemOf(t.source);
  if (!ext || !items.addressable(ext)) throw new Error("这条任务没有 Meegle 工单信息");
  return ext;
}

const clicked = (t: Task, label: string): Caller => ({ kind: "user", why: `你在 Friday 里点了「${label}」`, taskId: t.id });

export async function listTaskTransitions(t: Task, items: WorkItemsRole = role("workItems")): Promise<StateTransition[]> {
  return items.transitions(refOf(t, items));
}

/** 转到终态（Resolved / Closed…）就不用再修了，任务直接收掉，不必等下一次同步。 */
export async function applyTransition(t: Task, to: StateTransition, items: WorkItemsRole = role("workItems"), caller: Caller = clicked(t, to.label)): Promise<Task> {
  const ext = refOf(t, items);
  await items.transition(ext, to, caller, ext.state?.key);
  const moved = updateTask(t.id, { source: { external: { ...ext, state: { key: to.stateKey } } } })!;
  return items.stateOf(to.stateKey, to.label) === "done" ? (await finishTask(t.id, "done", `Meegle 流转到「${to.label}」`, { keepTerminal: true }))! : moved;
}

export async function transitionToInProgress(t: Task, items?: WorkItemsRole): Promise<{ moved: true; label: string } | { moved: false; why: string }> {
  const why = "Friday 在需求分支上修完并发到测试环境";
  try {
    const wi = items ?? role("workItems");
    const to = await wi.transitionFor(refOf(t, wi), "in_progress");
    if (!to) return { moved: false, why: `当前 ${workItemOf(t.source)?.state?.key ?? "未知"}，没有「开始处理」可走` };
    await applyTransition(t, to, wi, { kind: "friday", why, taskId: t.id });
    return { moved: true, label: to.label };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    record({ taskId: t.id, action: "meegle_transition", why, how: "workflow transition-state → IN PROGRESS", evidence: { meegleId: workItemOf(t.source)?.id, error }, risk: "read", status: "failed" });
    return { moved: false, why: error };
  }
}

function nodeRef(t: Task, items: WorkItemsRole): { ext: ExternalRef; nodeKey: string } {
  const ext = workItemOf(t.source);
  const key = ext && items.addressable(ext) ? items.node(ext)?.key : undefined;
  if (!ext || !key) throw new Error("这条任务没有可流转的 Meegle 节点");
  return { ext, nodeKey: key };
}

export async function nodeReadiness(t: Task, items: WorkItemsRole = role("workItems")): Promise<{ nodeKey: string; canConfirm: boolean; missing: string[] }> {
  const { ext, nodeKey } = nodeRef(t, items);
  const { missing } = await items.nodeReadiness(ext);
  return { nodeKey, canConfirm: missing.length === 0, missing };
}

export async function confirmNode(t: Task, items: WorkItemsRole = role("workItems"), caller: Caller = clicked(t, "完成当前节点")): Promise<Task> {
  await items.confirmNode(nodeRef(t, items).ext, caller);
  // 节点推给下游后这条多半不再分派给我；万一还在，下次同步会把它复活。
  // 提测不等于 MR 合了，终端和 worktree 都留着，测试打回来还能接着改
  return (await finishTask(t.id, "done", "完成了 Meegle 当前节点", { keepTerminal: true }))!;
}

/**
 * 并进来的那条工单同步到主任务上：状态、排期这些照写，工单号不能换成它的；keepParent 时所属需求也留主任务的。
 * 主任务本身不是工单（口头任务并进了工单）就不写引用
 */
function asHost(source: TaskSource, own: ExternalRef | undefined, keepParent: boolean): TaskSource {
  const { external, ...rest } = source;
  if (!own || !external) return rest;
  const next: ExternalRef = { ...external, id: own.id };
  if (keepParent) {
    if (own.parent) next.parent = own.parent;
    else delete next.parent;
  }
  return { ...rest, external: next };
}

/** 拉一次分派给我的 Meegle 工单：新工单建任务，已有的更新，不再分派给我的自动完成。 */
export async function syncWorkItemsOnce(items?: WorkItemsRole): Promise<{ added: number; closed: number; reopened: number }> {
  if (workItemSyncState.running) return { added: 0, closed: 0, reopened: 0 };
  workItemSyncState.running = true;
  try {
    const wi = items ?? role("workItems");
    const defects = userSettings().meegleDefects;
    const mine = (await wi.listMine()).filter((it) => defects || it.kind !== "defect");
    const projects = loadProjects();
    let added = 0;
    let reopened = 0;
    const fresh: Array<{ task: Task; item: MeegleWorkItem }> = [];
    for (const item of mine) {
      const input = workItemToTask(item, projects, false, wi);
      const existing = findTaskBySource((s) => holds(s, item.id), true);
      // 资料只增不删：你手贴的、已经取到的标题，同步都不能覆盖
      const docs = syncDocs(existing?.source.docs ?? [], input.source.docs ?? [], existing?.source.removedDocs);
      input.source.docs = docs.length ? docs : undefined;
      if (!existing) {
        const t = createTask({ ...input, kind: "work_item", source: { url: item.url, ...input.source } });
        record({ taskId: t.id, action: "task_create", why: "Meegle 把这个工单分派给你", how: "同步分派列表时建任务", evidence: { meegleId: item.id, node: item.node ?? null, priority: item.priority ?? null }, risk: "read" });
        added++;
        fillDocTitles(t.id);
        fresh.push({ task: t, item });
      } else if (OPEN.includes(existing.status)) {
        const { status: _s, project: inherited, ...rest } = input;
        // 跟着需求的项目走，但你单独给缺陷指定过的、Friday 已经在上面自主干过活的不覆盖（改那种得走回退清单）
        const patch = inherited && existing.source.projectBy !== "user" && !isFridayWork(existing) ? { ...rest, project: inherited } : rest;
        const own = workItemOf(existing.source);
        const isSelf = own?.id === item.id;
        if (existing.source.closedExternally) {
          // 关了又被 Reopen 分派回来：手上的改动还要用，「撤掉改动」收回
          updateTask(existing.id, { status: existing.source.jobId ? "processing" : "understood", progress: `Meegle 里又是 ${item.status}，接着改`, pending: (existing.pending ?? []).filter((p) => p.type !== "discard_changes"), source: { closedExternally: undefined } });
          record({ taskId: existing.id, action: "meegle_reopened", why: `Meegle 里这条缺陷又是 ${item.status}`, how: "撤回「撤掉改动」，改动留着接着用", evidence: { meegleId: item.id }, risk: "read" });
          reopened++;
        }
        if (isSelf) {
          // source 会与旧值合并，顺带把早先同步下来、还没有类型和排期的工单补齐。
          updateTask(existing.id, { ...patch, source: input.source });
        } else {
          // 这是并进来的另一个工单，不是本体：别拿它的标题覆盖主任务，
          // 也别让它的工单号和所属需求改掉主任务的身份与归属
          const { title: _t, understanding: _u, ...keep } = patch;
          updateTask(existing.id, { ...keep, source: asHost(input.source, own, true) });
        }
      } else if ((existing.status === "done" || existing.status === "ignored") && item.state === "reopened") {
        // Friday 里已经收工，Meegle 里却被 Reopen 又分派回来：拉回待办并提醒。
        // 只认 Reopen 状态——用户在 Friday 里主动标完成而 Meegle 还挂着的，不能每 15 分钟翻回来。
        // 交给需求会话修的那一轮 -p 还在跑：这轮不动，它退出后卡片仍是收工的，下一轮同步再处理
        if (existing.source.handedAt && existing.source.jobId && getJob(existing.source.jobId)?.status === "running") continue;
        const { status: _s, ...patch } = input;
        // 阶段也得跟着回退，留着「已上线」这类旧阶段是个早就不成立的结论：一般回「进行中」等你重新判；
        // 交给需求会话修过、需求还在测试中的回「未开始」，门禁下一轮把它重新交代进去，带上这句没过的原因
        const story = existing.source.handedAt ? resolveRoot(existing) : undefined;
        const rehand = story && story.id !== existing.id && story.stage === "testing";
        const own = workItemOf(existing.source);
        const synced = own?.id === item.id ? input.source : asHost(input.source, own, false);
        const source = { ...synced, ...clearHanded(existing).source, ...(rehand ? { handBackNote: `测试在 Meegle 里把它 Reopen 了（${item.status}），上一轮的修法没过` } : {}) };
        updateTask(existing.id, { ...patch, status: "understood", attention: undefined, pending: [], source, stage: rehand ? "todo" : "dev", stageBy: "auto", stagePrev: existing.stage, releasedAt: undefined });
        record({ taskId: existing.id, action: "meegle_reopened", why: "Meegle 里这个工单被 Reopen，又分派给你", how: `状态 ${item.status}，从${existing.status === "done" ? "已完成" : "已忽略"}拉回待办`, evidence: { meegleId: item.id }, risk: "read" });
        // 合进去的改动被打回来了：这是比「被你改过」更强的负信号
        for (const r of runsForTask(existing.id)) if (r.outcome === "merged_as_is" || r.outcome === "merged_modified" || r.outcome === "closed_unverified") setRunOutcome(r.id, "reopened", `Meegle ${item.status}`);
        state.notices.push({ title: `Meegle 工单 Reopen · ${item.projectName}`, body: item.name.slice(0, 120), taskId: existing.id });
        reopened++;
      }
      if (existing && docs.length > (existing.source.docs ?? []).length) fillDocTitles(existing.id);
    }
    const live = new Set(mine.map((it) => it.id));
    let closed = 0;
    for (const t of listTasks(UNFINISHED, 500)) {
      const ext = workItemOf(t.source);
      if (t.kind !== "work_item" || !ext || live.has(ext.id)) continue;
      // 已经挂着「撤掉改动」等你定，别每轮再问一次 Meegle、再挂一条
      if (t.source.closedExternally) continue;
      // 关了缺陷拉取就不知道它还在不在分派列表里，不能当作「不再分派给你」收掉
      if (!defects && isDefect(t)) continue;
      // 需求容器本来就不在分派列表里（当前节点在别人手上），这正是它要当容器的原因——
      // 不能按「不再分派给你」把它收掉，否则建出来下次同步就没了。
      // 它的收尾由名下缺陷决定：缺陷都完了才跟着收。
      if (t.source.container) {
        const kids = listTasks().filter((x) => {
          const story = parentId(x);
          return Boolean(story && holds(t.source, story));
        });
        if (!containerDone(kids)) continue;
        updateTask(t.id, { source: { autoClosed: true } });
        await finishTask(t.id, "done", "名下的缺陷都处理完了", { keepTerminal: true });
        record({ taskId: t.id, action: "meegle_done", why: "名下的缺陷都处理完了", how: `${kids.length} 条缺陷全部收工，需求容器一起收尾`, evidence: { meegleId: ext.id }, risk: "read" });
        closed++;
        continue;
      }
      // 不在 mywork todo 里只说明当前节点不在你手上（流去测试 / 服务端了），不代表这件事完了。
      // 出池的唯一判据是「FE 发布」节点走完（2026-09-20 与用户定）：只要前端还没发布，
      // 需求就一直留在池子里，你还要持续关注它。
      if (!wi.addressable(ext)) continue;
      // 它已经不在 mywork todo 里，上面那轮刷不到它，这里单独问一次把节点状态跟上
      const now = await wi.get(ext);
      if (now && now.stateKey !== ext.state?.key) {
        updateTask(t.id, { source: { external: { ...ext, state: { key: now.stateKey } } } });
      }
      // 缺陷没有「FE 发布」节点，只等它就永远收不掉（实测 21 条 CLOSED 的缺陷一直挂着，
      // 还把名下的需求容器每 15 分钟复活一次）。已经到终态的不必再等。
      if (now && now.state === "done") {
        const status = now.stateLabel || now.stateKey;
        // 缺陷关了，手上的改动可能已经没用了（你在别处改好了、需求变了）：有就挂着等你定撤不撤
        if (isDefect(t) && holdClosedDefect(t, status)) {
          state.notices.push({ title: "缺陷已关，改动要不要撤", body: t.title.slice(0, 120), taskId: t.id });
          continue;
        }
        // 在需求会话里改的拆不出来，只提一句
        const rootId = isDefect(t) && (t.source.jobId || t.source.handedAt) ? (liveRootId(t) ?? (t.source.handedAt ? t.source.rootId : undefined)) : undefined;
        const root = rootId ? getTask(rootId) : undefined;
        const why = `Meegle 里已经是 ${status}${root ? `；它在需求「${root.title}」的会话里改过，改动跟需求混在同一条分支上，要撤得你在需求终端里自己 revert` : ""}`;
        await finishTask(t.id, "done", why, { keepTerminal: true });
        if (root) updateTask(t.id, { progress: why });
        record({ taskId: t.id, action: "meegle_done", why, how: "工单已到终态，收工", evidence: { meegleId: ext.id, statusKey: now.stateKey }, risk: "read" });
        closed++;
        continue;
      }
      if (now && isDefect(t) && now.state === "testing") {
        onSignal(t.id, { signal: "meegle_in_testing", to: "testing", ask: "已经提测了？", why: `Meegle 里流转到 ${now.stateLabel}，当前负责人已不是你` });
        continue;
      }
      if (!(await wi.released(ext))) continue;
      await finishTask(t.id, "done", "「FE 发布」节点已经走完", { keepTerminal: true });
      record({ taskId: t.id, action: "meegle_done", why: "「FE 发布」节点已经走完", how: "前端已发布，从需求池里收掉", evidence: { meegleId: ext.id }, risk: "read" });
      closed++;
    }
    // 缺陷关联的需求不在任务板里时，拉进来当容器
    try {
      const made = await ensureContainers(wi);
      if (made) console.log(`[meegle] 拉进 ${made} 条需求当容器`);
    } catch (e) {
      console.error(`[meegle] 建需求容器失败：${e instanceof Error ? e.message : String(e)}`);
    }
    workItemSyncState.lastSyncAt = new Date().toISOString();
    workItemSyncState.lastError = null;
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
    workItemSyncState.lastError = e instanceof Error ? e.message : String(e);
    console.error(`[meegle] ${workItemSyncState.lastError}`);
    return { added: 0, closed: 0, reopened: 0 };
  } finally {
    workItemSyncState.running = false;
  }
}

/** 新工单的自动处置：判一次 intake，存在卡上给人看，并在卡上没定项目时猜一个。 */
export async function intakeWorkItem(task: Task, item: MeegleWorkItem, judge = judgeIntake): Promise<void> {
  const verdict = await judge(task, item.description ?? "", loadProjects());
  // 判断结果落在卡上：卡片上能看到 Friday 凭什么这么判，判成 start 的用它猜项目（开不开工看理解卡，不看这里）
  updateTask(task.id, {
    source: {
      intake: {
        kind: verdict.kind,
        why: verdict.why,
        at: new Date().toISOString(),
        ...(verdict.kind === "start" ? { confidence: verdict.confidence, project: verdict.project, detail: verdict.detail } : {}),
      },
    },
  });
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
      evidence: { meegleId: item.id, ...(parentId(task) ? { linkedStoryId: parentId(task) } : {}) },
      risk: "read",
    });
    state.notices.push({ title: `有条工单要问你 · ${item.projectName}`, body: verdict.question, taskId: task.id });
    return;
  }

  // 项目由你在任务卡上手动选，选完就直接开工（见 POST /tasks/:id/project）。
  // 这里既不替你猜项目，也不挂「开工」待审——那等于让你为同一件事点两次。
  console.log(`[meegle] ${item.id} 进待办，等你在卡上选项目：${verdict.why}`);
}
