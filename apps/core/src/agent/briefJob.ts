import { conversationKey, isQueryTask, taskCategory, type Brief, type Task } from "@friday/shared";
import { record } from "../memory/audit.js";
import { listFeatures, matchFeatures } from "../memory/features.js";
import { CONV_SCAN_LIMIT, listInbox } from "../memory/inbox.js";
import { taskNode } from "../memory/infer.js";
import { getJob } from "../memory/jobs.js";
import { neighbors } from "../memory/links.js";
import { loadProjects, projectDetail, type Project } from "../memory/projects.js";
import { addPending, createTask, findTaskBySource, getTask, updateTask } from "../memory/tasks.js";
import { state } from "../scheduler/index.js";
import { briefable, briefBasis, briefPolicy, parseBrief, renderBrief, reviewFor } from "./brief.js";
import { UNTRUSTED_NOTE, untrusted } from "./fence.js";
import { jobLog } from "./runner.js";
import { openSession } from "./sessions.js";
import { closeJobTerminal } from "./terminal.js";

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

export function briefPrompt(t: Task, p: Project, rejected?: string): string {
  const features = matchFeatures(p.name, `${t.title}\n${t.source.description ?? ""}`);
  const docs = (t.source.docs ?? []).map((d) => `- ${d.title ?? d.url}：${d.url}`).join("\n");
  const slack = slackText(t);
  const knowledge = features
    .map((f) => [`- [${f.id}] ${f.name}`, f.aliases.length && `  别名：${f.aliases.join("、")}`, f.where && `  在哪：${f.where}`, f.paths.length && `  目录：${f.paths.join("、")}`, f.routes.length && `  路由：${f.routes.join("、")}`, f.summary && `  说明：${f.summary}`].filter(Boolean).join("\n"))
    .join("\n");
  const detail = projectDetail(p);
  return [
    rejected ? `上一轮的理解卡被用户退回，原因：${rejected}\n这一轮先照这个改。\n` : undefined,
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
    "5. 依赖 deps：只列确定要别人给的（接口、设计稿、配置、数据）；已经给了的写 status: ready，并在 evidence 里带上出处（链接或原话）。",
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

function refusal(t: Task): string {
  if (t.kind !== "meegle" && t.kind !== "verbal" && t.kind !== "doc" && t.kind !== "code") return "这类任务不建理解卡，只给要写代码的需求建";
  if (!t.project) return "还没定项目，先定项目再建理解卡";
  if (isQueryTask(t.source)) return "后台查询任务不建理解卡";
  if (t.source.storyContainer) return "这是挂缺陷的需求容器，不是分派给你的，不建理解卡";
  if (taskCategory(t.source) === "defect") return "缺陷不建理解卡，直接修";
  if (t.source.jobId) return "已经开过工了，不建理解卡";
  if (t.status !== "collected" && t.status !== "understood") return "已经在处理或收工了，不建理解卡";
  return "已经过了「未开始」阶段，不建理解卡";
}

export async function startBriefJob(taskId: string): Promise<{ jobId: string } | { error: string; status: 404 | 409 }> {
  const t = getTask(taskId);
  if (!t) return { error: "没有这条任务", status: 404 };
  if (!briefable(t)) return { error: refusal(t), status: 404 };
  const p = loadProjects().find((x) => x.name === t.project);
  if (!p) return { error: `注册表里没有项目「${t.project}」`, status: 404 };
  const found = anchorOf(t.id);
  if (running(found)) return { error: "这条需求的理解卡正在建", status: 409 };
  const anchor = found ?? createTask({ title: `理解卡：${t.title}`, kind: "project", project: p.name, source: { briefFor: t.id, repoDir: p.dir, headless: true } });
  const rejected = t.source.brief?.review === "rejected" ? t.source.brief.reviewNote : undefined;
  const jobId = await openSession(anchor, anchor, { kind: "query", project: p.name, repoDir: p.dir, task: briefPrompt(t, p, rejected) });
  updateTask(anchor.id, { status: "processing", source: { jobId } });
  updateTask(t.id, { progress: "Friday 在读需求、写理解卡", source: { briefFailed: undefined } });
  record({ taskId: t.id, action: "brief_build_start", why: "给这条需求写理解卡", how: `在 ${p.dir} 里起只读后台会话，读需求、代码和知识库`, evidence: { jobId, anchorId: anchor.id, project: p.name }, risk: "read" });
  return { jobId };
}

export function storeBrief(taskId: string, raw: unknown): { ok: true; review: Brief["review"] } | { ok: false; error: string } {
  const t = getTask(taskId);
  if (!t?.project) return { ok: false, error: "Friday 找不到这条需求" };
  const policy = briefPolicy(loadProjects().find((x) => x.name === t.project));
  const parsed = parseBrief(raw, { featureIds: new Set(listFeatures(t.project).map((f) => f.id)), basis: briefBasis(t) });
  if (typeof parsed === "string") return { ok: false, error: parsed };
  const review = reviewFor(parsed.size, policy);
  const rejections = t.source.brief?.rejections;
  const brief: Brief = { ...parsed, review, ...(rejections ? { rejections } : {}) };
  const text = renderBrief(brief);
  updateTask(t.id, {
    plan: text,
    pending: (t.pending ?? []).filter((a) => a.type !== "brief_approve"),
    progress: review === "pending" ? "理解卡写好了，等你看" : "理解卡写好了，按项目规则不用审",
    source: { brief, briefFailed: undefined },
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

export async function finishBriefJob(anchor: Task, jobId: string, exitCode: number): Promise<void> {
  const t = getTask(anchor.source.briefFor!);
  const startedAt = getJob(jobId)?.startedAt;
  const reported = Boolean(t?.source.brief && startedAt && t.source.brief.at >= startedAt);
  if (t && !reported) {
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
