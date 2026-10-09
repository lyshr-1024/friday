import { Hono } from "hono";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, resolve, sep } from "node:path";
import { getAttachment, saveAttachment } from "../memory/attachments.js";
import { readResearchNote } from "../memory/research.js";
import { fillDocTitles, mergeDocs, normUrl } from "../agent/docTitle.js";
import { historyState, learnHistoryOnce, restoreMemorySnapshot } from "../agent/handbook.js";
import { applyTransition, confirmNode, listTaskTransitions, meegleState, nodeReadiness, rollbackNode, syncMeegleOnce, undoTransition } from "../agent/meegle.js";
import { z } from "zod";
import { conversationKey, STAGE_ORDER, type InboxItem, type RollbackReason, type SlackConversation, type Stage, type StateTransition, type Task, type TaskStatus } from "@friday/shared";
import { CONV_SCAN_LIMIT, listInbox } from "../memory/inbox.js";
import { neighbors } from "../memory/links.js";
import { channelNode, taskNode } from "../memory/infer.js";
import { TmuxMissingError } from "../agent/tmux.js";
import { handToFriday, startTask } from "../agent/taskStart.js";
import { approvePending, finishTask, rejectTask, reopenTask } from "../agent/pipeline.js";
import { undoWrite } from "../memory/files.js";
import { deleteResearchNote } from "../memory/research.js";
import { loadProjects, resolveProject } from "../memory/projects.js";
import { requestProjectChange } from "../agent/reproject.js";
import { autostartPlan, runningAutonomous } from "../agent/autostart.js";
import { userSettings } from "../settings.js";
import { matchProject } from "../agent/meegle.js";
import { closeJobTerminal, closeTaskTerminal } from "../agent/terminal.js";
import { taskSession } from "../agent/sessionState.js";
import { setVerified } from "../agent/bridge.js";
import { answerHint, setStage } from "../agent/stage.js";
import { priorContext, priorText } from "../memory/roster.js";
import { deleteMessage, loadSlackCreds, slackCaller, slackConfigured } from "../connectors/slack.js";
import { getJob } from "../memory/jobs.js";
import { closeProjectAnchor, openProjectShell, openProjectTerminal, projectOverview, projectTerminals } from "../agent/projectTerminal.js";
import { getEvent, listAudit, record, setEventStatus, setEventUndo, undoPlan } from "../memory/audit.js";
import { createTask, deleteTask, getTask, listTasksByKind, restoreTask, taskBoard, updatePending, updateTask } from "../memory/tasks.js";
import { OKR_SUBMIT_LABEL, mergeEdits, submittable } from "../agent/weekly/submit.js";
import { draftWeeklyOnce } from "../agent/weekly/index.js";
import { parseWeek } from "../agent/weekly/week.js";
import { remove as removeOkrReport } from "../connectors/okr.js";
import type { OkrWeeklyDraft } from "@friday/shared";
import type { HandbookDraft } from "../agent/handbook.js";

const MENTION_MAX_BYTES = 1024 * 1024;
const IMAGE_MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

const worktreeOf = (t: Task) => t.source.worktree ?? (t.source.rootId ? getTask(t.source.rootId)?.source.worktree : undefined);

const docList = (t: Task) => t.source.docs ?? [];

const transitionInput = z.object({
  id: z.string().min(1),
  stateKey: z.string().min(1),
  label: z.string().min(1),
});

const newTask = z.object({
  title: z.string().trim().min(1).max(200),
  note: z.string().max(4000).optional(),
  url: z.string().url().optional(),
  project: z.string().max(80).optional(),
  due: z.iso.date().optional(),
});

/** 任务牵着的 Slack 对话。整个收件箱只读一次，别每条任务各读一遍。 */
function slackOf(all: InboxItem[]) {
  const byConv = new Map<string, InboxItem[]>();
  for (const i of all) {
    const key = conversationKey(i);
    (byConv.get(key) ?? byConv.set(key, []).get(key)!).push(i);
  }
  for (const items of byConv.values()) items.sort((a, b) => Number(a.ts) - Number(b.ts));
  const ctx = priorContext();
  return (t: Task): Task => {
    const conversations = neighbors(taskNode(t.id), "slack")
      .map((n) => {
        const items = byConv.get(n.ref) ?? [];
        const head = items[0];
        if (!head) return undefined;
        return {
          conv: n.ref,
          channelName: head.channelName,
          kind: head.kind,
          channelLinked: head.kind === "mention" && neighbors(channelNode(head.channelName), "task").some((x) => x.ref === t.id),
          userName: head.userName,
          items: items.map((i) => ({ ts: i.ts, userName: i.userName, text: i.text, permalink: i.permalink, ...(i.appLink ? { appLink: i.appLink } : {}) })),
          prior: priorText(head.prior ?? [], { kind: head.kind, peer: head.userName, peerId: head.userId }, ctx),
          source: n.source,
          why: n.why,
        };
      })
      .filter((x): x is SlackConversation => Boolean(x));
    return conversations.length ? { ...t, conversations } : t;
  };
}

export const tasks = new Hono()
  .get("/tasks/:id/research", (c) => {
    const t = getTask(c.req.param("id"));
    if (!t?.source.researchFile) return c.json({ error: "这条任务没有研究笔记" }, 404);
    return c.json({ file: t.source.researchFile, content: readResearchNote(t.source.researchFile) });
  })
  .post("/tasks/learn-history", async (c) => c.json({ ...(await learnHistoryOnce(true)), ...(historyState.lastError ? { error: historyState.lastError } : {}) }))
  .post("/tasks/okr-weekly", async (c) => {
    const { week } = (await c.req.json().catch(() => ({}))) as { week?: string };
    const w = week ? parseWeek(week) : undefined;
    if (week && !w) return c.json({ error: "week 格式应为 2026W0921-0927，且从周一开始" }, 400);
    return c.json(await draftWeeklyOnce({ week: w, manual: true }));
  })
  .put("/tasks/:id/okr-draft", async (c) => {
    // 先读 body 再查任务：反过来的话，如果这两步之间恰好有一次提交把待审动作重新挂上去，
    // 合并就会拿旧 payload 覆盖掉那次提交刚写下的 submitted 状态
    const body = (await c.req.json().catch(() => ({}))) as { rows?: unknown };
    const t = getTask(c.req.param("id"));
    const action = t?.pending?.find((p) => p.type === "okr_submit");
    if (!t || !action) return c.json({ error: "这条任务没有待提交的周报" }, 404);
    if (!Array.isArray(body.rows)) return c.json({ error: "rows 必须是数组" }, 400);
    const rows = body.rows.filter(
      (r): r is { objectId: number; content?: string; pct?: number; checked?: boolean } =>
        typeof r === "object" && r !== null && typeof (r as { objectId?: unknown }).objectId === "number",
    );
    const draft = mergeEdits(action.payload as unknown as OkrWeeklyDraft, rows);
    const n = submittable(draft);
    const label = action.label.startsWith("重试") ? `重试剩下的 ${n} 条` : OKR_SUBMIT_LABEL(n);
    const next = updatePending(t.id, action.id, { payload: draft as unknown as Record<string, unknown>, label });
    return next ? c.json(next) : c.json({ error: "任务不存在" }, 404);
  })
  .post("/tasks/sync-meegle", async (c) => c.json({ ...(await syncMeegleOnce()), ...(meegleState.lastError ? { error: meegleState.lastError } : {}) }))
  .get("/tasks", async (c) => {
    const board = taskBoard();
    const plan = { now: Date.now(), running: runningAutonomous(), minConfidence: userSettings().autonomousMinConfidence, enabled: userSettings().autonomous };
    const withSession = (t: Task): Task => {
      const autostart = autostartPlan(t, plan);
      return { ...t, session: taskSession(t), ...(autostart ? { autostart } : {}) };
    };
    const withSlack = slackOf(listInbox(true, CONV_SCAN_LIMIT));
    return c.json({
      ...board,
      tasks: board.tasks.map((t) => withSlack(withSession(t))),
      meegleSyncedAt: meegleState.lastSyncAt,
      slackConfigured: await slackConfigured(),
    });
  })
  .get("/tasks/:id/handbook-draft", async (c) => {
    const action = getTask(c.req.param("id"))?.pending?.find((p) => p.type === "handbook_apply");
    if (!action) return c.json({ error: "这批手册改动已经处理过了" }, 404);
    const { draftView } = await import("../agent/handbook.js");
    const p = action.payload as { draft: HandbookDraft; skip?: string[] };
    return c.json(draftView(p.draft, p.skip ?? []));
  })
  // 勾掉的条目只记下来，通过时才剔掉；卡上点通过和会话里说「通过」都按这份走
  .put("/tasks/:id/handbook-skip", async (c) => {
    const id = c.req.param("id");
    const action = getTask(id)?.pending?.find((p) => p.type === "handbook_apply");
    if (!action) return c.json({ error: "这批手册改动已经处理过了" }, 404);
    const { skip } = (await c.req.json().catch(() => ({}))) as { skip?: unknown };
    if (!Array.isArray(skip) || !skip.every((k) => typeof k === "string")) return c.json({ error: "skip 应该是字符串数组" }, 400);
    updatePending(id, action.id, { payload: { ...action.payload, skip } });
    return c.json({ skip });
  })
  .get("/routines", (c) => c.json({ weekly: listTasksByKind("okr_weekly"), learn: listTasksByKind("handbook") }))
  .get("/tasks/:id", (c) => {
    const t = getTask(c.req.param("id"));
    return t ? c.json(t) : c.json({ error: "任务不存在" }, 404);
  })
  // 口头 / 文档：程序化建任务（UI 入口已并入对话，开工由会话里确认后 run_claude）
  .post("/tasks", async (c) => {
    const parsed = newTask.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "title 不能为空" }, 400);
    const { title, note, url, project, due } = parsed.data;
    const projects = loadProjects();
    const named = project ? resolveProject(project, projects) : undefined;
    const target = named?.kind === "match" ? named.project : projects.find((p) => p.name === matchProject(title, projects));
    const projectName = target?.name ?? project;
    const t = createTask({
      title,
      kind: url ? "doc" : "verbal",
      source: { ...(note ? { note } : {}), ...(url ? { url } : {}) },
      ...(projectName ? { project: projectName } : {}),
      ...(due ? { due } : {}),
      // 手动建的进待办，不是「Friday 在做」——建完还没人开始干
      status: "understood",
    });
    record({ taskId: t.id, action: "task_create", why: "你交代的", how: url ? "带文档链接建任务" : "建任务", evidence: { title, note: note ?? null, url: url ?? null, project: projectName ?? null }, risk: "read" });
    return c.json(t, 201);
  })
  .post("/tasks/:id/approve/:actionId", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { text?: string };
    try {
      return c.json(await approvePending(c.req.param("id"), c.req.param("actionId"), body.text));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  })
  .post("/tasks/:id/reject", async (c) => {
    const { reason } = (await c.req.json().catch(() => ({}))) as { reason?: string };
    const t = rejectTask(c.req.param("id"), reason);
    return t ? c.json(t) : c.json({ error: "任务不存在" }, 404);
  })
  .get("/tasks/:id/mentions", (c) => {
    const t = getTask(c.req.param("id"));
    if (!t) return c.json({ error: "任务不存在" }, 404);
    const q = (c.req.query("q") ?? "").toLowerCase();
    const wt = worktreeOf(t);
    let files: string[] = [];
    if (wt) {
      try {
        files = execFileSync("git", ["-C", wt, "ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8", timeout: 5_000, maxBuffer: 16 * 1024 * 1024 }).split("\n").filter(Boolean);
      } catch {}
    }
    const hit = (s: string) => !q || s.toLowerCase().includes(q);
    return c.json([
      ...files.filter(hit).slice(0, 20).map((f) => ({ kind: "file" as const, label: f.split("/").pop() ?? f, ref: f })),
      ...docList(t).filter((d) => hit(d.title ?? d.url)).map((d) => ({ kind: "doc" as const, label: d.title ?? d.url, ref: d.url })),
      ...(t.report?.screenshots ?? []).filter((s) => hit(s.name)).map((s) => ({ kind: "shot" as const, label: s.name, ref: s.id })),
    ]);
  })
  .post("/tasks/:id/mention", async (c) => {
    const p = z.object({ kind: z.enum(["file", "doc", "shot"]), ref: z.string().min(1).max(1000) }).safeParse(await c.req.json().catch(() => null));
    const t = getTask(c.req.param("id"));
    if (!p.success || !t) return c.json({ error: "kind / ref 必填" }, 400);
    if (p.data.kind === "doc") return c.json({ text: p.data.ref });
    if (p.data.kind === "shot") {
      const a = getAttachment(p.data.ref);
      if (!a) return c.json({ error: "截图不在了" }, 400);
      const { path: _, ...attachment } = a;
      return c.json({ attachmentId: a.id, attachment });
    }
    const wt = worktreeOf(t);
    const abs = wt ? resolve(wt, p.data.ref) : "";
    const real = abs && existsSync(abs) ? realpathSync(abs) : "";
    if (!wt || !real || !real.startsWith(realpathSync(wt) + sep)) return c.json({ error: "文件不在这条任务的 worktree 里" }, 400);
    const st = statSync(real);
    if (!st.isFile()) return c.json({ error: "只能引入普通文件" }, 400);
    if (st.size > MENTION_MAX_BYTES) return c.json({ error: "文件超过 1MB，太大了不引入" }, 400);
    const data = readFileSync(real);
    const mime = IMAGE_MIME[extname(real).toLowerCase()];
    if (!mime && data.subarray(0, 8192).includes(0)) return c.json({ error: "二进制文件不能引入" }, 400);
    const attachment = saveAttachment(basename(real), mime ?? "text/plain", data);
    return c.json({ attachmentId: attachment.id, attachment });
  })
  // 卡住的任务重新开工（比如用量上限恢复后）
  /** 项目注册表里的项目名，任务卡上手动归属用 */
  .get("/projects", (c) => c.json(loadProjects().map((p) => ({ name: p.name, dir: p.dir }))))
  .get("/projects/terminals", (c) => c.json(projectTerminals()))
  .get("/projects/:name/overview", (c) => {
    const o = projectOverview(decodeURIComponent(c.req.param("name")));
    return o ? c.json(o) : c.json({ error: "注册表里没有这个项目" }, 404);
  })
  // fresh：关掉现在这段 Claude、全新开一段（上下文太大时用），不接回旧对话
  .post("/projects/:name/terminal", async (c) => {
    const { fresh } = (await c.req.json().catch(() => ({}))) as { fresh?: boolean };
    try {
      const r = await openProjectTerminal(decodeURIComponent(c.req.param("name")), fresh === true);
      return "error" in r ? c.json(r, 404) : c.json(r);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  })
  .delete("/projects/:name/terminal", async (c) => {
    const r = await closeProjectAnchor(decodeURIComponent(c.req.param("name")), "claude");
    return "error" in r ? c.json(r, 404) : c.json(r);
  })
  .post("/projects/:name/shell", async (c) => {
    try {
      const r = await openProjectShell(decodeURIComponent(c.req.param("name")));
      return "error" in r ? c.json(r, 404) : c.json(r);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  })
  .delete("/projects/:name/shell", async (c) => {
    const r = await closeProjectAnchor(decodeURIComponent(c.req.param("name")), "shell");
    return "error" in r ? c.json(r, 404) : c.json(r);
  })
  /** 手动把任务归到某个项目：不再按标题猜，猜错了开工就改错仓库 */
  .post("/tasks/:id/project", async (c) => {
    const parsed = z.object({ project: z.string().min(1).nullable() }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "project 必填（传 null 解除）" }, 400);
    const name = parsed.data.project;
    if (name && resolveProject(name).kind !== "match") return c.json({ error: `项目注册表里没有 ${name}` }, 400);
    const r = requestProjectChange(c.req.param("id"), name);
    if (!r) return c.json({ error: "任务不存在" }, 404);
    if (r.kind === "refused") return c.json({ error: r.why }, 409);
    if (r.kind !== "set") return c.json(r.task);
    const t = r.task;
    record({ taskId: t.id, action: name ? "project_set" : "project_cleared", why: "你手动指定了项目", how: name ? `归到 ${name}` : "解除项目归属", evidence: { project: name, from: r.before ?? null }, risk: "reversible" });
    // 你自己的终端开在旧项目目录里，留着只会继续在错的仓库上改。断掉，任务回到待办；
    // worktree 里是你的改动，留着进遗留列表，删不删你定
    const job = t.source.jobId ? getJob(t.source.jobId) : undefined;
    if (r.before && job?.status === "running") {
      await closeJobTerminal(job.id, `项目从 ${r.before} 改成 ${name ?? "未定"}，旧终端开在错的目录里`, t.id);
      return c.json(updateTask(t.id, { status: "understood", source: { jobId: undefined } })!);
    }
    return c.json(t);
  })
  .post("/tasks/:id/docs", async (c) => {
    const p = z.object({ url: z.string().trim().url().max(2000) }).safeParse(await c.req.json().catch(() => null));
    const t = getTask(c.req.param("id"));
    if (!p.success || !/^https?:\/\//i.test(p.data.url)) return c.json({ error: "链接得是完整的 URL（http/https）" }, 400);
    if (!t) return c.json({ error: "任务不存在" }, 404);
    const next = updateTask(t.id, { source: { docs: mergeDocs(t.source.docs ?? [], [{ url: p.data.url, from: "user" }]), removedDocs: (t.source.removedDocs ?? []).filter((u) => u !== normUrl(p.data.url)) } })!;
    record({ taskId: t.id, action: "doc_added", why: "你贴了一份资料", how: p.data.url, evidence: { url: p.data.url }, risk: "reversible" });
    fillDocTitles(t.id, p.data.url);
    return c.json(next);
  })
  .delete("/tasks/:id/docs", (c) => {
    const url = c.req.query("url") ?? "";
    const t = getTask(c.req.param("id"));
    if (!t || !url) return c.json({ error: "url 必填" }, 400);
    const gone = normUrl(url);
    const next = updateTask(t.id, { source: { docs: (t.source.docs ?? []).filter((d) => normUrl(d.url) !== gone), removedDocs: [...new Set([...(t.source.removedDocs ?? []), gone])] } })!;
    record({ taskId: t.id, action: "doc_removed", why: "你删了一份资料", how: url, evidence: { url }, risk: "reversible" });
    return c.json(next);
  })
  /**
   * 把另一条需求并进这条：二期跟一期是同一件事、同一个分支，板上不该并排两条。
   * 被并掉那条的工单号记进 mergedMeegleIds，同步才认得出它、不会重新建一条。
   */
  .post("/tasks/:id/merge", async (c) => {
    const parsed = z.object({ fromTaskId: z.string().min(1) }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "fromTaskId 必填" }, 400);
    const into = getTask(c.req.param("id"));
    const from = getTask(parsed.data.fromTaskId);
    if (!into || !from) return c.json({ error: "任务不存在" }, 404);
    if (into.id === from.id) return c.json({ error: "不能和自己合并" }, 400);

    const ids = [
      ...(into.source.mergedMeegleIds ?? []),
      ...(from.source.meegleId ? [from.source.meegleId] : []),
      ...(from.source.mergedMeegleIds ?? []),
    ].filter((x, i, a) => a.indexOf(x) === i && x !== into.source.meegleId);
    // 两边的描述都留着：合并不是丢掉一半内容
    const understanding = [into.understanding, `—— 并入 #${from.source.meegleId ?? from.id}「${from.title}」——`, from.understanding]
      .filter(Boolean)
      .join("\n\n");
    // 名字和链接一起存下来：被合掉那条马上就删了，只留号码的话卡片上没法显示也点不开
    const merged = [
      ...(into.source.merged ?? []),
      ...(from.source.meegleId
        ? [{
            meegleId: from.source.meegleId,
            title: from.title,
            ...(from.source.url ? { url: from.source.url } : {}),
            ...(from.source.docs?.length ? { docs: from.source.docs } : {}),
          }]
        : []),
      ...(from.source.merged ?? []),
    ].filter((m, i, a) => a.findIndex((x) => x.meegleId === m.meegleId) === i);
    const next = updateTask(into.id, { understanding, source: { mergedMeegleIds: ids, merged, docs: mergeDocs(into.source.docs ?? [], from.source.docs ?? []) } })!;
    const row = deleteTask(from.id);
    record({
      taskId: into.id,
      action: "task_merged",
      why: "两条需求是同一件事，二期接着一期做",
      how: `把「${from.title}」并进「${into.title}」`,
      evidence: { fromTaskId: from.id, fromMeegleId: from.source.meegleId ?? null, mergedMeegleIds: ids },
      risk: "reversible",
      ...(row ? { undo: { kind: "restore_task", row } } : {}),
    });
    return c.json(next);
  })
  /** 二期在一期分支上接着开：记下基线任务，开工时从它的分支检出 */
  .post("/tasks/:id/base", async (c) => {
    const parsed = z.object({ baseTaskId: z.string().min(1).nullable() }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "baseTaskId 必填（传 null 解除）" }, 400);
    const t = getTask(c.req.param("id"));
    if (!t) return c.json({ error: "任务不存在" }, 404);
    const base = parsed.data.baseTaskId;
    if (base) {
      const b = getTask(base);
      if (!b) return c.json({ error: "基线任务不存在" }, 404);
      if (base === t.id) return c.json({ error: "不能基于自己" }, 400);
    }
    const next = updateTask(t.id, { source: { baseTaskId: base ?? undefined } });
    record({ taskId: t.id, action: base ? "base_set" : "base_cleared", why: "二期要在一期分支上接着开", how: base ? `基线改成任务 ${base}` : "解除基线", evidence: { baseTaskId: base }, risk: "reversible" });
    return next ? c.json(next) : c.json({ error: "任务不存在" }, 404);
  })
  // 我自己做：开个交互式终端，把需求交代进去。状态归 Friday 管，活儿归我干。
  .post("/tasks/:id/start", async (c) => {
    const t = getTask(c.req.param("id"));
    if (!t) return c.json({ error: "任务不存在" }, 404);
    const r = await startTask(t);
    return "error" in r ? c.json({ error: r.error }, r.status) : c.json(r.task);
  })
  .post("/tasks/:id/root", async (c) => {
    const parsed = z.object({ adopt: z.boolean() }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "adopt 必填（true / false）" }, 400);
    const t = getTask(c.req.param("id"));
    if (!t) return c.json({ error: "任务不存在" }, 404);
    if (!t.source.rootId || !t.source.rootGuess) return c.json({ error: "这条任务没有待确认的归属" }, 409);
    const rootId = t.source.rootId;
    if (!parsed.data.adopt) {
      const next = updateTask(t.id, { source: { rootId: undefined, rootGuess: undefined } });
      record({ taskId: t.id, action: "root_rejected", why: "你说 Friday 推断的归属不对", how: "去掉挂靠的需求，回到独立任务", evidence: { rootId }, risk: "reversible" });
      return next ? c.json(next) : c.json({ error: "任务不存在" }, 404);
    }
    const cleared = updateTask(t.id, { source: { rootGuess: undefined } })!;
    const r = await startTask(cleared);
    if ("error" in r) {
      updateTask(t.id, { source: { rootGuess: true } });
      return c.json({ error: r.error }, r.status);
    }
    record({ taskId: t.id, action: "root_adopted", why: "你确认了 Friday 推断的归属", how: "去掉「推断」标记，进需求的会话", evidence: { rootId }, risk: "reversible" });
    return c.json(r.task);
  })
  .post("/tasks/:id/retry", async (c) => {
    const t = getTask(c.req.param("id"));
    if (!t) return c.json({ error: "任务不存在" }, 404);
    const r = await handToFriday(t);
    return "error" in r ? c.json({ error: r.error }, r.status) : c.json(r.task);
  })
  // 「通过前请确认」勾选状态；全部勾完 = 这轮验收通过，Friday 推进下一步
  .post("/tasks/:id/verify", async (c) => {
    const parsed = z.object({ index: z.number().int().min(0), checked: z.boolean() }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "index / checked 必填" }, 400);
    const t = await setVerified(c.req.param("id"), parsed.data.index, parsed.data.checked);
    return t ? c.json(t) : c.json({ error: "任务不存在或没有验证点" }, 404);
  })
  // 星标关注：列表顶上单独一组
  .post("/tasks/:id/pin", async (c) => {
    const parsed = z.object({ pinned: z.boolean() }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "pinned 必填" }, 400);
    const t = updateTask(c.req.param("id"), { pinned: parsed.data.pinned });
    return t ? c.json(t) : c.json({ error: "任务不存在" }, 404);
  })
  // 阶段：想拨哪拨哪，不限方向——测试打回、上线回滚都是常事。
  // 往回拨要说清是「Friday 推错了」还是「确实被打回了」，只有前者进学习。
  .post("/tasks/:id/stage", async (c) => {
    const parsed = z
      .object({
        stage: z.enum(STAGE_ORDER as [Stage, ...Stage[]]),
        reason: z.enum(["misjudged", "bounced"]).optional(),
        note: z.string().max(500).optional(),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "stage 必填，且得是五个阶段之一" }, 400);
    const t = setStage(c.req.param("id"), parsed.data.stage, parsed.data.reason as RollbackReason | undefined, parsed.data.note);
    return t ? c.json(t) : c.json({ error: "任务不存在" }, 404);
  })
  // 回答卡片上那一问（「看起来提测了？」）。答什么都算一次经验
  .post("/tasks/:id/stage-hint", async (c) => {
    const parsed = z.object({ yes: z.boolean() }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "yes 必填" }, 400);
    const t = answerHint(c.req.param("id"), parsed.data.yes);
    return t ? c.json(t) : c.json({ error: "任务不存在" }, 404);
  })
  .get("/tasks/:id/transitions", async (c) => {
    const t = getTask(c.req.param("id"));
    if (!t) return c.json({ error: "任务不存在" }, 404);
    try {
      return c.json({ transitions: await listTaskTransitions(t) });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
    }
  })
  .post("/tasks/:id/transition", async (c) => {
    const t = getTask(c.req.param("id"));
    if (!t) return c.json({ error: "任务不存在" }, 404);
    const parsed = transitionInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "需要 id / stateKey / label" }, 400);
    try {
      return c.json(await applyTransition(t, parsed.data as StateTransition));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      record({ taskId: t.id, action: "meegle_transition_failed", why: `流转到 ${parsed.data.stateKey} 失败`, how: message, risk: "read", status: "failed" });
      return c.json({ error: message }, 502);
    }
  })
  .get("/tasks/:id/node", async (c) => {
    const t = getTask(c.req.param("id"));
    if (!t) return c.json({ error: "任务不存在" }, 404);
    if (!t.source.nodeKey) return c.json({ error: "这条任务没有可流转的 Meegle 节点" }, 400);
    try {
      return c.json(await nodeReadiness(t));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
    }
  })
  .post("/tasks/:id/node/confirm", async (c) => {
    const t = getTask(c.req.param("id"));
    if (!t) return c.json({ error: "任务不存在" }, 404);
    if (!t.source.nodeKey) return c.json({ error: "这条任务没有可流转的 Meegle 节点" }, 400);
    try {
      return c.json(await confirmNode(t));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      record({ taskId: t.id, action: "meegle_node_failed", why: "完成节点失败", how: message, risk: "read", status: "failed" });
      return c.json({ error: message }, 502);
    }
  })
  .post("/tasks/:id/done", async (c) => {
    const t = await finishTask(c.req.param("id"), "done", "你把任务标记完成");
    return t ? c.json(t) : c.json({ error: "任务不存在" }, 404);
  })
  .post("/tasks/:id/ignore", async (c) => {
    const t = await finishTask(c.req.param("id"), "ignored", "你忽略了这条任务");
    return t ? c.json(t) : c.json({ error: "任务不存在" }, 404);
  })
  /** 收工了的任务重新打开；会话被关了但 worktree 还在就接回原来的对话 */
  .post("/tasks/:id/reopen", async (c) => {
    const r = await reopenTask(c.req.param("id"));
    return r ? c.json(r) : c.json({ error: "任务不存在" }, 404);
  })
  .patch("/tasks/:id", async (c) => {
    const parsed = z
      .object({ title: z.string().trim().min(1).max(200).optional(), understanding: z.string().max(4000).optional() })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success || (parsed.data.title === undefined && parsed.data.understanding === undefined)) {
      return c.json({ error: "title 或 understanding 至少给一个" }, 400);
    }
    const t = updateTask(c.req.param("id"), parsed.data);
    return t ? c.json(t) : c.json({ error: "任务不存在" }, 404);
  })
  .delete("/tasks/:id", async (c) => {
    const id = c.req.param("id");
    const before = getTask(id);
    if (!before) return c.json({ error: "任务不存在" }, 404);
    // 终端还开着就一并收掉，不然留下孤儿 claude 进程和「运行中」的 job
    await closeTaskTerminal(before, "任务被删除");
    const row = deleteTask(id);
    if (!row) return c.json({ error: "任务不存在" }, 404);
    record({
      taskId: id,
      action: "delete_task",
      why: "你在任务上选了删除",
      how: `从任务表里删掉「${before.title}」`,
      evidence: { title: before.title, status: before.status },
      risk: "reversible",
      undo: { kind: "restore_task", row },
    });
    return c.json({ ok: true });
  })
  .get("/audit", (c) => c.json(listAudit({ ...(c.req.query("taskId") ? { taskId: c.req.query("taskId")! } : {}), limit: Number(c.req.query("limit") ?? 200) })))
  .post("/audit/:id/undo", async (c) => {
    const plan = undoPlan(c.req.param("id"));
    if (!plan) return c.json({ error: "这笔不可撤销" }, 400);
    if (plan.kind === "delete_slack_message") {
      const creds = await loadSlackCreds();
      if (!creds) return c.json({ error: "Slack 未接入" }, 400);
      try {
        await deleteMessage(slackCaller(creds), plan.channel, plan.ts);
      } catch (e) {
        return c.json({ error: `撤回失败：${e instanceof Error ? e.message : String(e)}` }, 409);
      }
      setEventStatus(c.req.param("id"), "undone");
      return c.json({ ok: true });
    }
    if (plan.kind === "restore_task") {
      if (!restoreTask(plan.row)) return c.json({ error: "撤销失败（任务已不能恢复）" }, 409);
      const ev = getEvent(c.req.param("id"));
      if (ev?.action === "task_merged" && ev.taskId) {
        const back = String((ev.evidence as { fromMeegleId?: string }).fromMeegleId ?? "");
        const into = getTask(ev.taskId);
        if (into && back) {
          updateTask(into.id, {
            source: {
              mergedMeegleIds: (into.source.mergedMeegleIds ?? []).filter((x) => x !== back),
              merged: (into.source.merged ?? []).filter((m) => m.meegleId !== back),
            },
          });
        }
      }
      setEventStatus(c.req.param("id"), "undone");
      return c.json({ ok: true });
    }
    if (plan.kind === "stage_set") {
      // 撤回一次阶段变更：拨回它变更前停的那一档。
      // 从 released 撤回时任务要回板上，交给 setStage 的回滚分支处理。
      const cur = getTask(plan.taskId);
      if (!cur) return c.json({ error: "任务已不在" }, 409);
      if (plan.stage) setStage(plan.taskId, plan.stage as Stage, "misjudged", "你撤回了这次阶段变更");
      else updateTask(plan.taskId, { stage: undefined, stageBy: undefined, stagePrev: undefined });
      setEventStatus(c.req.param("id"), "undone");
      return c.json({ ok: true });
    }
    if (plan.kind === "delete_okr_reports") {
      const remaining = [...plan.ids];
      for (const reportId of plan.ids) {
        try {
          await removeOkrReport(reportId);
          remaining.shift();
          // 删一条就记一条：中途再失败的话，重试只用剩下的，不会对已经删掉的再删一次
          setEventUndo(c.req.param("id"), { kind: "delete_okr_reports", ids: remaining });
        } catch (e) {
          const removed = plan.ids.length - remaining.length;
          return c.json({ error: `删了 ${removed} 条，第 ${removed + 1} 条（report id ${reportId}）删不掉：${e instanceof Error ? e.message : String(e)}。被锁定的报告只能去平台上改` }, 409);
        }
      }
      setEventStatus(c.req.param("id"), "undone");
      return c.json({ ok: true });
    }
    if (plan.kind === "reopen_task") {
      if (!updateTask(plan.id, { status: plan.status as TaskStatus })) return c.json({ error: "任务已不在" }, 409);
      setEventStatus(c.req.param("id"), "undone");
      return c.json({ ok: true });
    }
    if (plan.kind === "delete_research") {
      if (!deleteResearchNote(plan.file)) return c.json({ error: "笔记已经不在了" }, 409);
      setEventStatus(c.req.param("id"), "undone");
      return c.json({ ok: true });
    }
    if (plan.kind === "restore_memory") {
      restoreMemorySnapshot(plan.snapshot);
      setEventStatus(c.req.param("id"), "undone");
      return c.json({ ok: true });
    }
    if (plan.kind === "meegle_node" || plan.kind === "meegle_state") {
      try {
        const done = plan.kind === "meegle_node" ? await rollbackNode(plan) : await undoTransition(plan);
        if (!done) return c.json({ error: "Meegle 不允许转回原状态，请去网页操作" }, 409);
      } catch (e) {
        return c.json({ error: `转回失败：${e instanceof Error ? e.message : String(e)}` }, 409);
      }
      setEventStatus(c.req.param("id"), "undone");
      return c.json({ ok: true });
    }
    const ok = undoWrite(plan);
    if (ok) setEventStatus(c.req.param("id"), "undone");
    return ok ? c.json({ ok: true }) : c.json({ error: "撤销失败（内容可能已被改动）" }, 409);
  });
