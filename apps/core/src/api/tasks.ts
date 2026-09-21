import { Hono } from "hono";
import { readResearchNote } from "../memory/research.js";
import { historyState, learnHistoryOnce, restoreMemorySnapshot } from "../agent/handbook.js";
import { applyTransition, confirmNode, listTaskTransitions, meegleState, nodeReadiness, rollbackNode, syncMeegleOnce, undoTransition } from "../agent/meegle.js";
import { z } from "zod";
import { AUTOSTART_CATEGORY, REPLY_CATEGORIES, type ReplyCategory, type StateTransition, type Task } from "@friday/shared";
import { reviewOnce } from "../agent/lessons.js";
import { executePending, finishTask, startAutonomousJob, startInteractiveJob } from "../agent/pipeline.js";
import { undoWrite } from "../memory/files.js";
import { loadProjects, resolveProject } from "../memory/projects.js";
import { matchProject } from "../agent/meegle.js";
import { closeJobTerminal, closeTaskTerminal, terminalState } from "../agent/terminal.js";
import { setVerified } from "../agent/bridge.js";
import { deleteMessage, loadSlackCreds, postMessage, slackCaller, slackConfigured } from "../connectors/slack.js";
import { getJob } from "../memory/jobs.js";
import { getEvent, listAudit, record, setEventStatus, undoPlan } from "../memory/audit.js";
import { createTask, deleteTask, getTask, restoreTask, taskBoard, updatePending, updateTask } from "../memory/tasks.js";
import { getThread, markAutoDone, threadCategory } from "../memory/threads.js";

const replyCategory = (t?: Task): ReplyCategory => {
  const th = t?.source.threadId ? getThread(t.source.threadId) : undefined;
  return th ? threadCategory(th) : "other";
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
  .post("/tasks/review", async (c) => c.json(await reviewOnce()))
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
      // 手动建的进待办，不是「Friday 在做」——建完还没人开始干
      status: "understood",
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
    // 打回 = 「这条不要发」：关掉这条线程的自动发送闸门
    if (t.source.threadId) markAutoDone(t.source.threadId, "slack_reply_sent");
    return c.json(updateTask(t.id, { status: "processing", pending: [], progress: `被打回：${reason ?? "无说明"}` }));
  })
  // 卡住的任务重新开工（比如用量上限恢复后）
  /** 项目注册表里的项目名，任务卡上手动归属用 */
  .get("/projects", (c) => c.json(loadProjects().map((p) => ({ name: p.name, dir: p.dir }))))
  /** 手动把任务归到某个项目：不再按标题猜，猜错了开工就改错仓库 */
  .post("/tasks/:id/project", async (c) => {
    const parsed = z.object({ project: z.string().min(1).nullable() }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "project 必填（传 null 解除）" }, 400);
    const name = parsed.data.project;
    if (name && resolveProject(name).kind !== "match") return c.json({ error: `项目注册表里没有 ${name}` }, 400);
    const before = getTask(c.req.param("id"));
    if (!before) return c.json({ error: "任务不存在" }, 404);
    const changed = (before.project ?? null) !== name;
    const t = updateTask(c.req.param("id"), { project: name ?? undefined })!;
    record({ taskId: t.id, action: name ? "project_set" : "project_cleared", why: "你手动指定了项目", how: name ? `归到 ${name}` : "解除项目归属", evidence: { project: name, from: before.project ?? null }, risk: "reversible" });
    // 改项目意味着之前那个终端开错地方了：它 cd 在旧项目目录里，留着只会继续
    // 在错的仓库上改代码。断掉，任务回到待办，等你点「开始做」在新项目上重开。
    const job = t.source.jobId ? getJob(t.source.jobId) : undefined;
    if (changed && before.project && job?.status === "running") {
      await closeJobTerminal(job.id, `项目从 ${before.project} 改成 ${name ?? "未定"}，旧终端开在错的目录里`, t.id);
      return c.json(updateTask(t.id, { status: "understood", source: { jobId: undefined } })!);
    }
    return c.json(t);
  })
  /** 手填文档链接：口头交代的任务没有 Meegle 同步下来的资料，得能自己贴。
      Meegle 任务同步会覆盖 req/tech/design，手填的 meegle 键它不碰。 */
  .post("/tasks/:id/docs", async (c) => {
    const url = z.string().trim().url().max(2000).or(z.literal(""));
    const parsed = z
      .object({ req: url.optional(), tech: url.optional(), design: url.optional(), meegle: url.optional() })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "链接得是完整的 URL（http/https）" }, 400);
    const before = getTask(c.req.param("id"));
    if (!before) return c.json({ error: "任务不存在" }, 404);
    // 空串表示删掉这一栏；没传的键保持原样
    const docs = { ...(before.source.docs ?? {}) };
    for (const [k, v] of Object.entries(parsed.data)) {
      if (v === undefined) continue;
      if (v === "") delete docs[k as keyof typeof docs];
      else docs[k as keyof typeof docs] = v;
    }
    const t = updateTask(c.req.param("id"), { source: { docs } })!;
    record({
      taskId: t.id,
      action: "docs_set",
      why: "你手动贴了文档链接",
      how: Object.keys(docs).length ? `现在有 ${Object.keys(docs).length} 个链接` : "清空了",
      evidence: { docs, from: before.source.docs ?? {} },
      risk: "reversible",
    });
    return c.json(t);
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
            ...(from.source.docs ? { docs: from.source.docs } : {}),
          }]
        : []),
      ...(from.source.merged ?? []),
    ].filter((m, i, a) => a.findIndex((x) => x.meegleId === m.meegleId) === i);
    const next = updateTask(into.id, { understanding, source: { mergedMeegleIds: ids, merged } })!;
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
    if (!t.project) return c.json({ error: "任务没有关联项目，先选个项目" }, 400);
    const r = resolveProject(t.project);
    if (r.kind !== "match") return c.json({ error: `找不到项目 ${t.project}` }, 400);
    const running = t.source.jobId ? getJob(t.source.jobId) : undefined;
    if (running?.status === "running") return c.json({ error: "这条任务已经有终端在跑了" }, 409);
    const docs = Object.values(t.source.docs ?? {}).filter(Boolean);
    const detail = [
      `我要开始做这条需求：${t.title}`,
      t.source.url ? `工单：${t.source.url}` : "",
      docs.length ? `文档：${docs.join(" ")}` : "",
      "",
      "先把需求和相关代码读一遍，跟我说你打算怎么改，别急着动手。",
    ].filter(Boolean).join("\n");
    return c.json(await startInteractiveJob(t, r.project.name, r.project.dir, detail));
  })
  .post("/tasks/:id/retry", async (c) => {
    const t = getTask(c.req.param("id"));
    if (!t) return c.json({ error: "任务不存在" }, 404);
    if (!t.project) return c.json({ error: "任务没有关联项目，无法开工" }, 400);
    const r = resolveProject(t.project);
    if (r.kind !== "match") return c.json({ error: `找不到项目 ${t.project}` }, 400);
    const running = t.source.jobId ? getJob(t.source.jobId) : undefined;
    if (running?.status === "running") return c.json({ error: "这条任务已经在跑了，先关掉那个终端再重新开工" }, 409);
    // understanding 是「Meegle Requirement #x，节点「y」在等你」这种元信息复述，
    // 拿它当任务描述等于什么都没说；优先用方案，其次标题，最后才退回 understanding。
    const detail = t.plan?.split("\n").find((l) => l.trim()) ?? t.title;
    record({ taskId: t.id, action: "retry", why: "你让它重新开工", how: "重新拉起自主 Claude Code 任务", evidence: { previousJobId: t.source.jobId ?? null }, risk: "reversible" });
    const next = await startAutonomousJob(t, r.project.name, r.project.dir, `${detail}\n\n背景：${t.understanding ?? ""}`);
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
