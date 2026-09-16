import { Hono } from "hono";
import { readResearchNote } from "../memory/research.js";
import { historyState, learnHistoryOnce, restoreMemorySnapshot } from "../agent/handbook.js";
import { recordLesson, reviewOnce } from "../agent/lessons.js";
import { applyTransition, confirmNode, listTaskTransitions, meegleState, nodeReadiness, rollbackNode, syncMeegleOnce, undoTransition } from "../agent/meegle.js";
import { z } from "zod";
import { AUTOSTART_CATEGORY, REPLY_CATEGORIES, type ReplyCategory, type StateTransition, type Task } from "@friday/shared";
import { undoWrite } from "../agent/autowrite.js";
import { executePending, finishTask, startAutonomousJob } from "../agent/pipeline.js";
import { loadProjects, resolveProject } from "../memory/projects.js";
import { matchProject } from "../agent/meegle.js";
import { terminalState } from "../agent/terminal.js";
import { setVerified } from "../agent/bridge.js";
import { deleteMessage, loadSlackCreds, postMessage, slackCaller, slackConfigured } from "../connectors/slack.js";
import { getEvent, listAudit, record, setEventStatus, undoPlan } from "../memory/audit.js";
import { createTask, getTask, taskBoard, updatePending, updateTask } from "../memory/tasks.js";
import { getThread, markAutoDone, threadCategory } from "../memory/threads.js";

const replyCategory = (t?: Task): ReplyCategory => {
  const th = t?.source.threadId ? getThread(t.source.threadId) : undefined;
  return th ? threadCategory(th) : "other";
};
const asCategory = (v: unknown): ReplyCategory => (REPLY_CATEGORIES.includes(v as ReplyCategory) ? (v as ReplyCategory) : "other");
const taskConfidence = (t?: Task): number => {
  const th = t?.source.threadId ? getThread(t.source.threadId) : undefined;
  return th?.brief?.confidence ?? 0;
};

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

export const tasks = new Hono()
  .get("/tasks/:id/research", (c) => {
    const t = getTask(c.req.param("id"));
    if (!t?.source.researchFile) return c.json({ error: "这条任务没有研究笔记" }, 404);
    return c.json({ file: t.source.researchFile, content: readResearchNote(t.source.researchFile) });
  })
  .post("/tasks/review", async (c) => c.json(await reviewOnce(true)))
  .post("/tasks/learn-history", async (c) => c.json({ ...(await learnHistoryOnce(true)), ...(historyState.lastError ? { error: historyState.lastError } : {}) }))
  .post("/tasks/sync-meegle", async (c) => c.json({ ...(await syncMeegleOnce()), ...(meegleState.lastError ? { error: meegleState.lastError } : {}) }))
  .get("/tasks", async (c) => {
    const board = taskBoard();
    return c.json({
      ...board,
      tasks: board.tasks.map((t) => (t.source.jobId && t.status === "processing" ? { ...t, terminal: terminalState(t.source.jobId) } : t)),
      meegleSyncedAt: meegleState.lastSyncAt,
      slackConfigured: await slackConfigured(),
    });
  })
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
      status: "processing",
    });
    record({ taskId: t.id, action: "task_create", why: "你交代的", how: url ? "带文档链接建任务" : "建任务", evidence: { title, note: note ?? null, url: url ?? null, project: projectName ?? null }, risk: "read" });
    return c.json(t, 201);
  })
  .post("/tasks/:id/approve/:actionId", async (c) => {
    const before = getTask(c.req.param("id"));
    const action = before?.pending?.find((p) => p.id === c.req.param("actionId"));
    const draft = action?.detail ?? "";
    // 用户在确认框里改过要发的文本：先落到待审动作上，发出去和记账的都是改后的
    const body = (await c.req.json().catch(() => ({}))) as { text?: string };
    if (typeof body.text === "string" && body.text.trim() && action) {
      updatePending(before!.id, action.id, { detail: body.text.trim(), payload: { ...action.payload, text: body.text.trim() } });
    }
    const text = body.text?.trim() || draft;
    const creds = await loadSlackCreds();
    const call = creds ? slackCaller(creds) : undefined;
    try {
      const t: Task = await executePending(
        c.req.param("id"),
        c.req.param("actionId"),
        {
          slackPost: async (channel, body, threadTs) => {
            if (!call) throw new Error("Slack 未接入");
            return postMessage(call, channel, body, threadTs);
          },
        },
        text ? { text } : undefined,
      );
      const final = text?.trim() || draft;
      // 只有回复类动作才算「Friday 起草、用户拍板」的经验；git_merge 这类审核动作不代表对话质量，不该污染 lesson 统计。
      // 会话里改过的草稿在改那一刻已记过 edited_approved，这里再记一条 approved 会把统计冲成「判得很准」
      if (action?.type === "slack_reply" && draft && !action.payload.edited) {
        recordLesson({ taskId: t.id, category: replyCategory(before), kind: final === draft ? "approved" : "edited_approved", draft, final, confidence: taskConfidence(before) });
      }
      // 点了开工同样是拍板：这条记进 autostart 的经验，阈值据此校准
      if (action?.type === "start_job") {
        recordLesson({ taskId: t.id, category: AUTOSTART_CATEGORY, kind: "approved", draft: action.detail, confidence: Number(action.payload.confidence ?? 0) });
      }
      return c.json(t);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      record({ taskId: c.req.param("id"), action: "approve_failed", why: "执行审核通过的动作失败", how: message, risk: "irreversible", status: "failed" });
      return c.json({ error: message }, 500);
    }
  })
  .post("/tasks/:id/reject", async (c) => {
    const { reason } = (await c.req.json().catch(() => ({}))) as { reason?: string };
    const t = getTask(c.req.param("id"));
    if (!t) return c.json({ error: "任务不存在" }, 404);
    record({ taskId: t.id, action: "review_rejected", why: reason ?? "你打回了", how: "任务退回处理中，待审核动作作废", evidence: { reason: reason ?? null, dropped: (t.pending ?? []).map((p) => p.label) }, risk: "read" });
    const firstPending = t.pending?.[0];
    // 只有回复类动作被打回才记 lesson——用户说的是「这条不要发」，git_merge 这类审核动作打回不代表对话质量。
    if (firstPending?.type === "slack_reply") {
      recordLesson({ taskId: t.id, category: replyCategory(t), kind: "rejected", feedback: reason ?? "", draft: firstPending.detail ?? "", confidence: taskConfidence(t) });
    }
    // 打回开工 = 「这活你不该自己接」，是校准开工阈值最直接的信号
    if (firstPending?.type === "start_job") {
      recordLesson({ taskId: t.id, category: AUTOSTART_CATEGORY, kind: "rejected", feedback: reason ?? "", draft: firstPending.detail ?? "", confidence: Number(firstPending.payload.confidence ?? 0) });
    }
    // 打回是用户表达「这条不要发」的最强信号：关掉这条线程的自动发送闸门，下一轮新消息不能绕过审核直接发出去。
    if (t.source.threadId) markAutoDone(t.source.threadId, "slack_reply_sent");
    return c.json(updateTask(t.id, { status: "processing", pending: [], progress: `被打回：${reason ?? "无说明"}` }));
  })
  // 卡住的任务重新开工（比如用量上限恢复后）
  .post("/tasks/:id/retry", async (c) => {
    const t = getTask(c.req.param("id"));
    if (!t) return c.json({ error: "任务不存在" }, 404);
    if (!t.project) return c.json({ error: "任务没有关联项目，无法开工" }, 400);
    const r = resolveProject(t.project);
    if (r.kind !== "match") return c.json({ error: `找不到项目 ${t.project}` }, 400);
    const detail = t.plan?.split("\n").find((l) => l.trim()) ?? t.understanding ?? t.title;
    record({ taskId: t.id, action: "retry", why: "你让它重新开工", how: "重新拉起自主 Claude Code 任务", evidence: { previousJobId: t.source.jobId ?? null }, risk: "reversible" });
    const next = await startAutonomousJob({ ...t, source: { ...t.source, jobId: undefined } }, r.project.name, r.project.dir, `${detail}\n\n背景：${t.understanding ?? ""}`);
    return c.json(next);
  })
  .post("/tasks/:id/conversation", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { conversationId?: string };
    if (!body.conversationId) return c.json({ error: "需要 conversationId" }, 400);
    const t = updateTask(c.req.param("id"), { source: { conversationId: body.conversationId } });
    return t ? c.json(t) : c.json({ error: "任务不存在" }, 404);
  })
  // 「通过前请确认」勾选状态；全部勾完 = 这轮验收通过，Friday 推进下一步
  .post("/tasks/:id/verify", async (c) => {
    const parsed = z.object({ index: z.number().int().min(0), checked: z.boolean() }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "index / checked 必填" }, 400);
    const t = setVerified(c.req.param("id"), parsed.data.index, parsed.data.checked);
    return t ? c.json(t) : c.json({ error: "任务不存在或没有验证点" }, 404);
  })
  // 星标关注：列表顶上单独一组
  .post("/tasks/:id/pin", async (c) => {
    const parsed = z.object({ pinned: z.boolean() }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "pinned 必填" }, 400);
    const t = updateTask(c.req.param("id"), { pinned: parsed.data.pinned });
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
      const ev = getEvent(c.req.param("id"));
      // 只有 Friday 自动发出去又被撤回的才算它判断失误，人工批准发出的不记这一笔
      if (ev?.action === "slack_reply_sent" && ev.evidence.auto === true) {
        recordLesson({ ...(ev.taskId ? { taskId: ev.taskId } : {}), category: asCategory(ev.evidence.category), kind: "auto_undone", final: String(ev.evidence.text ?? ""), confidence: Number(ev.evidence.confidence ?? 0) });
      }
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
