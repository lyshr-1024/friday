import { Hono } from "hono";
import { z } from "zod";
import type { RunResponse } from "@friday/shared";
import { decide } from "../agent/permission.js";
import { addMessage, conversationExists } from "../memory/conversations.js";
import { NO_TASK, startAutonomousJob } from "../agent/pipeline.js";
import { recentDuplicate } from "../memory/jobs.js";
import { createTask } from "../memory/tasks.js";
import { resolveProject } from "../memory/projects.js";
import { finishSession, startSession } from "../memory/sessions.js";

const body = z.object({
  project: z.string().trim().min(1),
  task: z.string().trim().max(4000).optional(),
  conversationId: z.string().uuid().optional(),
});

export const run = new Hono().post("/run", async (c) => {
  const parsed = body.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "project 不能为空" }, 400);
  const { project, task, conversationId } = parsed.data;
  if (!task?.trim()) return c.json({ error: NO_TASK }, 400);
  const conv = conversationId && conversationExists(conversationId) ? conversationId : undefined;
  if (conv) addMessage(conv, { role: "user", kind: "run", content: `跑 ${project}${task ? ` ${task}` : ""}` });

  const resolved = resolveProject(project);
  if (resolved.kind === "none") {
    const error = `没找到项目「${project}」，请在 projects.md 里登记，或直接给目录路径`;
    if (conv) addMessage(conv, { role: "assistant", kind: "error", content: error });
    return c.json({ error }, 404);
  }
  if (resolved.kind === "ambiguous") {
    const res: RunResponse = { status: "ambiguous", candidates: resolved.candidates.map((p) => ({ name: p.name, dir: p.dir })) };
    if (conv) addMessage(conv, { role: "assistant", kind: "run", content: `「${project}」匹配到多个项目，请用完整名字`, payload: res });
    return c.json(res);
  }

  // Friday 在 worktree 里干活、守卫只拦保护分支，合并要你点头，因此归为可逆操作：放行并记日志。
  if (!decide("reversible").allowed) return c.json({ error: "操作被拒绝" }, 403);

  const dup = recentDuplicate(resolved.project.dir, task);
  if (dup) {
    const res: RunResponse = { status: "launched", project: dup.project, dir: dup.dir, jobId: dup.id, ...(dup.task ? { task: dup.task } : {}) };
    return c.json(res);
  }
  const id = startSession("run", `${resolved.project.name}: ${task}`);
  try {
    const t = createTask({ title: `${resolved.project.name}：${task}`.slice(0, 80), kind: "code", source: conv ? { conversationId: conv } : {}, project: resolved.project.name, status: "understood", understanding: task });
    const started = await startAutonomousJob(t, resolved.project.name, resolved.project.dir, task, "user");
    if (started.status === "blocked" || !started.source.jobId) throw new Error(started.progress ?? "没开成");
    const jobId = started.source.jobId;
    finishSession(id, `launched tmux ${jobId}`);
    const res: RunResponse = { status: "launched", project: resolved.project.name, dir: resolved.project.dir, jobId, ...(task ? { task } : {}) };
    if (conv) addMessage(conv, { role: "assistant", kind: "run", content: `已在 ${res.project} 上开工`, payload: res });
    return c.json(res);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    finishSession(id, `failed: ${message}`);
    if (conv) addMessage(conv, { role: "assistant", kind: "error", content: message });
    return c.json({ error: message }, 500);
  }
});
