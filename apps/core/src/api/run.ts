import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { RunResponse } from "@friday/shared";
import { decide } from "../agent/permission.js";
import { launchClaude } from "../agent/runner.js";
import { resolveProject } from "../memory/projects.js";
import { finishSession, startSession } from "../memory/sessions.js";
import { userSettings } from "../settings.js";

const body = z.object({
  project: z.string().trim().min(1),
  task: z.string().trim().max(4000).optional(),
});

export const run = new Hono().post("/run", async (c) => {
  const parsed = body.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "project 不能为空" }, 400);
  const { project, task } = parsed.data;

  const resolved = resolveProject(project);
  if (resolved.kind === "none") {
    return c.json({ error: `没找到项目「${project}」，请在 projects.md 里登记，或直接给目录路径` }, 404);
  }
  if (resolved.kind === "ambiguous") {
    const res: RunResponse = { status: "ambiguous", candidates: resolved.candidates.map((p) => ({ name: p.name, dir: p.dir })) };
    return c.json(res);
  }

  // 拉起的是交互式 Claude Code，写操作由它在终端里再向用户确认，因此归为可逆操作：放行并记日志。
  if (!decide("reversible").allowed) return c.json({ error: "操作被拒绝" }, 403);

  const id = startSession("run", `${resolved.project.name}: ${task ?? "(交互)"}`);
  const { terminal } = userSettings();
  try {
    const script = await launchClaude({ id, dir: resolved.project.dir, terminal, ...(task ? { task } : {}) });
    finishSession(id, `launched ${terminal} ${script}`);
    const res: RunResponse = { status: "launched", project: resolved.project.name, dir: resolved.project.dir, terminal, ...(task ? { task } : {}) };
    return c.json(res);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    finishSession(id, `failed: ${message}`);
    return c.json({ error: message }, 500);
  }
});
