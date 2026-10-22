import { briefRefusal, conversationKey, type Brief, type RunTrigger, type Task } from "@friday/shared";
import { record } from "../memory/audit.js";
import { listFeatures, matchFeatures } from "../memory/features.js";
import { CONV_SCAN_LIMIT, listInbox } from "../memory/inbox.js";
import { taskNode } from "../memory/infer.js";
import { getJob } from "../memory/jobs.js";
import { neighbors } from "../memory/links.js";
import { createRun } from "../memory/runs.js";
import { isFridayProject, loadProjects, projectDetail, type Project } from "../memory/projects.js";
import { addPending, createTask, findTaskBySource, getTask, listTasks, listTasksByKind, updateTask } from "../memory/tasks.js";
import { userSettings } from "../settings.js";
import { state } from "../scheduler/index.js";
import { briefable, briefBasis, briefPolicy, parseBrief, pickBriefQueue, renderBrief, reviewFor } from "./brief.js";
import { UNTRUSTED_NOTE, untrusted } from "./fence.js";
import { closeRun, fillRunCost } from "./runLog.js";
import { jobLog } from "./runner.js";
import { openSession } from "./sessions.js";
import { closeJobTerminal } from "./terminal.js";
import { TmuxMissingError } from "./tmux.js";

const SIZE_RULE = "新路由 / 新页面、接新接口、动公共组件（`components/` / `packages/` 这类目录）、预计改动文件 ≥ 5，任一命中就 `large`；把握不足也 `large`。";
const NO_CASES = "没有，按 PRD 自己推";

const anchorOf = (taskId: string): Task | undefined => findTaskBySource((s) => s.briefFor === taskId, true);
const running = (t: Task | undefined): boolean => Boolean(t?.source.jobId && getJob(t.source.jobId)?.status === "running");

function slackText(t: Task): string {
  const convs = new Set([t.source.conversation, ...neighbors(taskNode(t.id), "slack").map((n) => n.ref)].filter((c): c is string => !!c));
  if (!convs.size) return "";
  const msgs = listInbox(true, CONV_SCAN_LIMIT)
    .filter((i) => convs.has(conversationKey(i)))
    .sort((a, b) => Number(a.ts) - Number(b.ts));
  return msgs.map((i) => `- ${i.channelName || "私聊"} · ${i.userName}：${i.text}`).join("\n").slice(0, 4000);
}

export function briefPrompt(t: Task, p: Project, note?: string): string {
  const features = matchFeatures(p.name, `${t.title}\n${t.source.description ?? ""}`);
  const docs = (t.source.docs ?? []).map((d) => `- ${d.title ?? d.url}：${d.url}`).join("\n");
  const slack = slackText(t);
  const knowledge = features
    .map((f) => [`- [${f.id}] ${f.name}`, f.aliases.length && `  别名：${f.aliases.join("、")}`, f.where && `  在哪：${f.where}`, f.paths.length && `  目录：${f.paths.join("、")}`, f.routes.length && `  路由：${f.routes.join("、")}`, f.summary && `  说明：${f.summary}`].filter(Boolean).join("\n"))
    .join("\n");
  const detail = projectDetail(p);
  return [
    note ? `上一轮的理解卡被用户退回，原因：${note}\n这一轮先照这个改。\n` : undefined,
    `给项目 ${p.name}（${p.dir}）的一条需求写理解卡。这是**只读**任务：只读需求和代码，不改任何文件、不建分支、不提交；改文件的工具会被守卫直接拒绝。`,
    "",
    `需求：\n${untrusted("task", `标题：${t.title}\n${t.source.description ?? ""}`)}`,
    t.source.meegleId ? `Meegle 工单：#${t.source.meegleId}` : undefined,
    docs ? `资料（PRD、设计稿等）：\n${untrusted("docs", docs)}` : undefined,
    slack ? `挂在这条需求上的 Slack 讨论：\n${untrusted("slack", slack)}` : undefined,
    knowledge ? `知识库里跟这条需求相关的功能（方括号里是功能 id）：\n${untrusted("knowledge", knowledge)}` : undefined,
    detail ? `项目说明：\n${detail}` : undefined,
    `这个项目的用例从哪来：${p.extra["用例"] ?? NO_CASES}`,
    "",
    "怎么做：",
    "1. 读需求：PRD 是飞书文档就用 lark-doc skill 读，其他网页用 friday_web_read（长文按返回的 offset 接着读）。读不到的写进 plan 里「要你拍板」那段，不要猜。",
    "2. 在仓库里 grep 定位要改哪里（页面、组件、接口、路由），方案落到具体文件。",
    "3. 用例：按上面「用例从哪来」导出；没有现成的就自己写，覆盖 golden path、边界、回归，至少一条。",
    `4. 规模 size：${SIZE_RULE}`,
    "5. 依赖 deps：只列确定要别人给的（接口、设计稿、配置、数据）；已经给了的写 status: ready，并在 evidence 里带上出处（链接或原话）。没亲自验证能拿到的（链接打不开、还在申请权限、只听说给了）一律写 pending。",
    "命令一律前台跑，不要放到后台（run_in_background 或末尾加 &）：会话要等后台命令结束才退出，放了就一直挂着。",
    "",
    "最后调一次 friday_brief 把理解卡报给 Friday：",
    "- todo：这条需求要做什么",
    "- deps：[{ what, from?, status: pending|ready, evidence?: { source: meegle|slack|user, url?, text?, at } }]",
    "- acceptance：{ source: cases|prd|own（用例来自现成用例 / PRD / 你自己写的）, cases: [用例，一条一句], note? }",
    "- release：怎么发（跟版本、单独发、要不要开关）",
    "- plan：方案（改哪些文件、怎么改；读不到、拿不准的写在「要你拍板」那段）",
    "- size：small | large；sizeWhy：一句话依据",
    "- features：涉及的知识库功能 id",
    "friday_brief 回错就照错误改了再调。成功后直接退出：不写报告文件、不调 friday_done，也不要问用户问题——没人在终端前。",
    UNTRUSTED_NOTE,
  ]
    .filter((l) => l !== undefined)
    .join("\n");
}

export const withoutApprove = (t: Task) => (t.pending ?? []).filter((a) => a.type !== "brief_approve");

const BUSY = { error: "这条需求的理解卡正在建", status: 409 } as const;
// 锚点的 jobId 要等 openSession 返回才写得上，这段空档里定时 tick 和手点会撞
const starting = new Set<string>();

export const briefBuilding = (taskId: string): boolean => starting.has(taskId) || running(anchorOf(taskId));

export async function startBriefJob(taskId: string, trigger: RunTrigger = "user"): Promise<{ jobId: string } | { error: string; status: 404 | 409 }> {
  if (starting.has(taskId)) return BUSY;
  const t = getTask(taskId);
  if (!t) return { error: "没有这条任务", status: 404 };
  const refused = briefRefusal(t);
  if (refused) return { error: refused, status: 404 };
  const p = loadProjects().find((x) => x.name === t.project);
  if (!p) return { error: `注册表里没有项目「${t.project}」`, status: 404 };
  const found = anchorOf(t.id);
  if (running(found)) return BUSY;
  starting.add(taskId);
  try {
    const anchor = found ?? createTask({ title: `理解卡：${t.title}`, kind: "project", project: p.name, source: { briefFor: t.id, repoDir: p.dir, headless: true } });
    const note = t.source.briefNote ?? (t.source.brief?.review === "rejected" ? t.source.brief.reviewNote : undefined);
    updateTask(anchor.id, { source: { briefBuild: { basis: briefBasis(t), ...(t.source.briefNote ? { note: t.source.briefNote } : {}) } } });
    const jobId = await openSession(anchor, anchor, { kind: "query", project: p.name, repoDir: p.dir, task: briefPrompt(t, p, note) });
    updateTask(anchor.id, { status: "processing", source: { jobId } });
    createRun({ id: jobId, jobId, taskId: t.id, project: p.name, kind: "brief", trigger });
    updateTask(t.id, { progress: "Friday 在读需求、写理解卡", pending: withoutApprove(getTask(t.id)!), source: { briefFailed: undefined } });
    record({ taskId: t.id, action: "brief_build_start", why: "给这条需求写理解卡", how: `在 ${p.dir} 里起只读后台会话，读需求、代码和知识库`, evidence: { jobId, anchorId: anchor.id, project: p.name }, risk: "read" });
    return { jobId };
  } finally {
    starting.delete(taskId);
  }
}

export function storeBrief(taskId: string, raw: unknown, build: NonNullable<Task["source"]["briefBuild"]>): { ok: true; review: Brief["review"] } | { ok: false; error: string } {
  const t = getTask(taskId);
  if (!t?.project) return { ok: false, error: "Friday 找不到这条需求" };
  if (!briefable(t)) return { ok: false, error: "需求已经开工或收工，理解卡不挂了" };
  const policy = briefPolicy(loadProjects().find((x) => x.name === t.project));
  const parsed = parseBrief(raw, { featureIds: new Set(listFeatures(t.project).map((f) => f.id)), basis: build.basis });
  if (typeof parsed === "string") return { ok: false, error: parsed };
  const review = reviewFor(parsed.size, policy);
  const rejections = t.source.brief?.rejections;
  const brief: Brief = { ...parsed, review, ...(rejections ? { rejections } : {}) };
  const text = renderBrief(brief);
  updateTask(t.id, {
    plan: text,
    pending: withoutApprove(t),
    progress: review === "pending" ? "理解卡写好了，等你看" : "理解卡写好了，按项目规则不用审",
    // 建卡期间你又说了新的原话，这张卡没带上它，留给下一次
    source: { brief, briefFailed: undefined, ...(t.source.briefNote === build.note ? { briefNote: undefined } : {}) },
  });
  if (review === "pending") addPending(t.id, { type: "brief_approve", label: "方案看过，开工", detail: text, payload: {} }, { keepStatus: true });
  record({
    taskId: t.id,
    action: "brief_built",
    why: "建卡会话报上来理解卡",
    how: `规模 ${brief.size === "small" ? "小" : "大"}、送审「${policy}」→ ${review === "pending" ? "等你审" : "不用审"}、用例 ${brief.acceptance.cases.length} 条`,
    evidence: { size: brief.size, policy, review, cases: brief.acceptance.cases.length, features: brief.features },
    risk: "reversible",
  });
  if (review === "pending") state.notices.push({ title: `理解卡写好了，等你看 · ${t.project}`, body: t.title.slice(0, 200), taskId: t.id });
  return { ok: true, review };
}

export async function rebuildBrief(taskId: string, note?: string): ReturnType<typeof startBriefJob> {
  const t = getTask(taskId);
  if (t && note && briefable(t)) {
    const b = t.source.brief;
    updateTask(t.id, { pending: withoutApprove(t), source: { briefNote: note, ...(b ? { brief: { ...b, review: "rejected" as const, reviewNote: note } } : {}) } });
  }
  return startBriefJob(taskId);
}

export function rejectBrief(taskId: string, reason: string): Task | undefined {
  const t = getTask(taskId);
  const b = t?.source.brief;
  if (!t || !b) return undefined;
  const rejections = (b.rejections ?? 0) + 1;
  const updated = updateTask(t.id, {
    pending: withoutApprove(t),
    ...(rejections > 1 ? { progress: "方案被打回两次，等你在会话里说怎么改，说完点「重建」" } : {}),
    source: { brief: { ...b, review: "rejected", reviewNote: reason, rejections } },
  });
  record({ taskId: t.id, action: "brief_rejected", why: reason, how: rejections > 1 ? `第 ${rejections} 次打回，不再自动重建，等你在会话里说` : "照你给的原因自动重建一次", evidence: { reason, rejections }, risk: "reversible" });
  if (rejections === 1) {
    const failed = (why: string) => updateTask(t.id, { source: { briefFailed: { at: new Date().toISOString(), why } } });
    void startBriefJob(t.id, "retry")
      .then((r) => {
        if ("error" in r) failed(r.error);
      })
      .catch((e) => failed(e instanceof Error ? e.message : String(e)));
  }
  return updated;
}

function saveBrief(t: Task, brief: Brief, pending = t.pending): Task {
  const text = renderBrief(brief);
  return updateTask(t.id, { plan: text, pending: (pending ?? []).map((a) => (a.type === "brief_approve" ? { ...a, detail: text } : a)), source: { brief } })!;
}

export function setBriefSize(taskId: string, size: Brief["size"]): Task | string {
  const t = getTask(taskId);
  if (!t) return "没有这条任务";
  const b = t.source.brief;
  if (!b) return "这条任务还没有理解卡";
  const refused = briefRefusal(t);
  if (refused) return refused;
  const policy = briefPolicy(loadProjects().find((x) => x.name === t.project));
  const review = b.review === "approved" || b.review === "rejected" ? b.review : reviewFor(size, policy);
  let updated = saveBrief(t, { ...b, size, review }, review === "pending" ? t.pending : withoutApprove(t));
  if (review === "pending" && !t.pending?.some((a) => a.type === "brief_approve")) updated = addPending(t.id, { type: "brief_approve", label: "方案看过，开工", detail: updated.plan!, payload: {} }, { keepStatus: true })!;
  record({ taskId: t.id, action: "brief_resized", why: "你改了规模", how: `${b.size === "small" ? "小" : "大"} → ${size === "small" ? "小" : "大"}，送审「${policy}」→ ${review}`, evidence: { from: b.size, to: size, policy, review }, risk: "reversible" });
  return updated;
}

export function markDepReady(taskId: string, match: string | number): Task | string {
  const t = getTask(taskId);
  if (!t) return "没有这条任务";
  const b = t.source.brief;
  if (!b) return "这条任务还没有理解卡";
  const i = typeof match === "number" ? match : b.deps.findIndex((d) => d.what.includes(match));
  const dep = b.deps[i];
  if (!dep) return typeof match === "number" ? `没有第 ${match + 1} 条依赖` : `理解卡的依赖里没有「${match}」：${b.deps.map((d) => d.what).join("、") || "一条都没有"}`;
  if (dep.status === "ready") return t;
  const deps = b.deps.map((d, j) => (j === i ? { ...d, status: "ready" as const, evidence: { source: "user" as const, at: new Date().toISOString(), text: "你标的到了" } } : d));
  const updated = saveBrief(t, { ...b, deps });
  record({ taskId: t.id, action: "brief_dep_ready", why: "你标了依赖到了", how: dep.what, evidence: { index: i, what: dep.what }, risk: "reversible" });
  return updated;
}

/** 交卡后给会话自己退出的时间；还在跑多半是在等它自己放到后台的命令 */
export const ANCHOR_EXIT_GRACE_MS = 30_000;

export function closeAfterReport(jobId: string, anchorId: string): void {
  setTimeout(() => {
    if (getJob(jobId)?.status !== "running") return;
    closeJobTerminal(jobId, "理解卡交了，会话没自己退出（多半在等后台命令）", anchorId).catch((e) => console.error("[brief] 关掉交完卡的会话失败", e));
  }, ANCHOR_EXIT_GRACE_MS).unref();
}

export async function finishBriefJob(anchor: Task, jobId: string, exitCode: number): Promise<void> {
  const t = getTask(anchor.source.briefFor!);
  const startedAt = getJob(jobId)?.startedAt;
  const reported = Boolean(t?.source.brief && startedAt && t.source.brief.at >= startedAt);
  closeRun(jobId, reported ? "report" : exitCode === -1 ? "window_closed" : "no_report");
  fillRunCost(jobId);
  if (t && !reported && briefable(t)) {
    const why = exitCode !== 0 ? "会话异常退出" : "没调 friday_brief 就退出了";
    updateTask(t.id, { progress: why, source: { briefFailed: { at: new Date().toISOString(), why, log: jobLog(jobId) } } });
  }
  record({
    ...(t ? { taskId: t.id } : {}),
    action: "brief_build_done",
    why: reported ? "理解卡建完了" : "理解卡没建成",
    how: `退出码 ${exitCode}${reported ? "" : `，日志 ${jobLog(jobId)}`}`,
    evidence: { jobId, anchorId: anchor.id, exitCode },
    risk: "read",
    status: reported ? "done" : "failed",
  });
  await closeJobTerminal(jobId, "理解卡建完了", anchor.id);
  updateTask(anchor.id, { status: "done" });
}

function checkBasis(): void {
  const projects = loadProjects();
  for (const t of listTasks(["collected", "understood"])) {
    const b = t.source.brief;
    if (!b || briefBuilding(t.id)) continue;
    if (b.basis === briefBasis(t)) {
      if (b.review === "none" && reviewFor(b.size, briefPolicy(projects.find((x) => x.name === t.project))) === "pending") requireReview(t, b);
      continue;
    }
    if (b.review === "rejected") {
      if (b.stale) continue;
      // 打回的卡丢了就丢了打回次数，下一次打回又会自动重建，「两次就停」形同虚设
      updateTask(t.id, { source: { brief: { ...b, stale: true } } });
      record({ taskId: t.id, action: "brief_stale", why: "需求正文在理解卡被打回之后变了", how: "卡上标「已过期」，打回原因和次数留着，等你重建", evidence: { basis: b.basis, now: briefBasis(t) }, risk: "read" });
    } else if (b.review === "approved") {
      const asking = t.pending?.some((a) => a.type === "brief_approve");
      if (b.stale && asking) continue;
      if (!b.stale) {
        updateTask(t.id, { source: { brief: { ...b, stale: true } } });
        record({ taskId: t.id, action: "brief_stale", why: "需求正文在理解卡审过之后变了", how: "卡上标「已过期」，不自动重建，挂「方案看过，开工」等你再批一次或重建", evidence: { basis: b.basis, now: briefBasis(t) }, risk: "read" });
      }
      // 不挂的话「按这个做」和卡上的批准都没东西可批，过期只能靠重建解除
      if (!asking) addPending(t.id, { type: "brief_approve", label: "方案看过，开工", detail: `需求变了，这张卡写在变之前。还按这个做就批准，不然点重建。\n\n${renderBrief(b)}`, payload: {} }, { keepStatus: true });
    } else {
      updateTask(t.id, { pending: withoutApprove(t), source: { brief: undefined } });
      record({ taskId: t.id, action: "brief_stale_rebuild", why: "需求正文在理解卡审过之前变了", how: "撤掉旧理解卡和待审动作；自主开工开着就进队列重建，关着等你手点「建理解卡」", evidence: { basis: b.basis, now: briefBasis(t) }, risk: "reversible" });
    }
  }
}

function requireReview(t: Task, b: Brief): void {
  const friday = isFridayProject(t.project);
  const updated = saveBrief(t, { ...b, review: "pending" });
  if (!t.pending?.some((a) => a.type === "brief_approve")) addPending(t.id, { type: "brief_approve", label: "方案看过，开工", detail: updated.plan!, payload: {} }, { keepStatus: true });
  record({ taskId: t.id, action: "brief_review_required", why: friday ? "friday 项目的方案一律要你审" : "项目的「方案送审」改成要审了", how: "原来按规则不用审的理解卡改成等你审，挂「方案看过，开工」", evidence: { size: b.size }, risk: "reversible" });
}

export async function briefTick(): Promise<"started" | "busy" | "idle"> {
  checkBasis();
  if (!userSettings().autonomous) return "idle";
  if (listTasksByKind("project", 500).some((a) => a.source.briefFor && running(a))) return "busy";
  const next = pickBriefQueue(listTasks(["collected", "understood"]));
  if (!next) return "idle";
  try {
    const r = await startBriefJob(next.id, "autostart");
    if (!("error" in r)) return "started";
    if (r.status === 404) updateTask(next.id, { source: { briefFailed: { at: new Date().toISOString(), why: r.error } } });
    return "busy";
  } catch (e) {
    if (!(e instanceof TmuxMissingError)) throw e;
    console.warn(`[brief] ${e.message}，本轮不再尝试`);
    return "idle";
  }
}
