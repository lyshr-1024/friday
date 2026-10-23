import { Hono } from "hono";
import { z } from "zod";
import type { ToolLevel, ToolRegistration } from "@friday/shared";
import { checkHealth } from "../connectors/health.js";
import { getTool, listTools, saveTool } from "../connectors/registry.js";
import { record } from "../memory/audit.js";

const STALE_MS = 10 * 60_000;

const counts = (t: ToolRegistration) => {
  const c: Record<ToolLevel | "unset", number> = { read: 0, reversible: 0, irreversible: 0, unset: 0 };
  for (const o of t.ops) c[o.level ?? "unset"]++;
  return c;
};

export const tools = new Hono()
  .get("/tools", async (c) => {
    const now = Date.now();
    await Promise.all(listTools().filter((t) => !t.health || now - Date.parse(t.health.at) > STALE_MS).map((t) => checkHealth(t.name)));
    return c.json({ tools: listTools().map((t) => ({ ...t, counts: counts(t) })) });
  })
  .patch("/tools/:name", async (c) => {
    const name = c.req.param("name");
    const before = getTool(name);
    if (!before) return c.json({ error: "没有这个工具" }, 404);
    const parsed = z.object({ enabled: z.boolean() }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "需要 enabled: boolean" }, 400);
    const { enabled } = parsed.data;
    const after = saveTool({ ...before, enabled });
    record({
      action: "tool_updated",
      why: `你在设置页${enabled ? "启用" : "停用"}了工具 ${name}`,
      how: `PATCH /tools/${name}`,
      evidence: { name, enabled },
      risk: "reversible",
      undo: { kind: "restore_tool", name, before },
    });
    return c.json(after);
  });
