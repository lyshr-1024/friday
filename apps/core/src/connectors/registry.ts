import type { ToolHealth, ToolOp, ToolRegistration } from "@friday/shared";
import { db } from "../memory/db.js";

interface ToolRow {
  name: string; transport: ToolRegistration["transport"]; connection: string; scenario: string; skill: string | null;
  projects: string; roles: string; binaries: string; enabled: number; draft: number; health: string | null;
  created_at: string; updated_at: string;
}

interface OpRow {
  tool: string; name: string; description: string; input_schema: string; level: ToolOp["level"];
  level_by: ToolOp["levelBy"]; template: string | null; undo: string | null;
}

const toOp = (r: OpRow): ToolOp => ({
  name: r.name, description: r.description, inputSchema: JSON.parse(r.input_schema) as Record<string, unknown>,
  level: r.level, levelBy: r.level_by,
  ...(r.template ? { template: JSON.parse(r.template) as string[] } : {}),
  ...(r.undo ? { undo: JSON.parse(r.undo) as NonNullable<ToolOp["undo"]> } : {}),
});

const toTool = (r: ToolRow, ops: OpRow[]): ToolRegistration => ({
  name: r.name, transport: r.transport, connection: r.connection, scenario: r.scenario,
  ...(r.skill ? { skill: r.skill } : {}),
  projects: JSON.parse(r.projects) as string[], roles: JSON.parse(r.roles) as string[], binaries: JSON.parse(r.binaries) as string[],
  enabled: r.enabled === 1, draft: r.draft === 1,
  ops: ops.map(toOp),
  ...(r.health ? { health: JSON.parse(r.health) as ToolHealth } : {}),
  createdAt: r.created_at, updatedAt: r.updated_at,
});

const opsOf = (name: string) =>
  db().prepare("SELECT * FROM tool_ops WHERE tool = ? ORDER BY rowid").all(name) as unknown as OpRow[];

export function getTool(name: string): ToolRegistration | undefined {
  const r = db().prepare("SELECT * FROM tools WHERE name = ?").get(name) as unknown as ToolRow | undefined;
  return r ? toTool(r, opsOf(name)) : undefined;
}

export function listTools(opts: { enabled?: boolean } = {}): ToolRegistration[] {
  const rows = db().prepare("SELECT * FROM tools ORDER BY created_at, name").all() as unknown as ToolRow[];
  return rows
    .filter((r) => opts.enabled === undefined || (r.enabled === 1) === opts.enabled)
    .map((r) => toTool(r, opsOf(r.name)));
}

export function saveTool(reg: Omit<ToolRegistration, "createdAt" | "updatedAt">): ToolRegistration {
  const d = db();
  const now = new Date().toISOString();
  const prev = d.prepare("SELECT created_at, health FROM tools WHERE name = ?").get(reg.name) as unknown as { created_at: string; health: string | null } | undefined;
  const health = reg.health ? JSON.stringify(reg.health) : (prev?.health ?? null);
  d.exec("BEGIN");
  try {
    d.prepare(
      `INSERT INTO tools (name, transport, connection, scenario, skill, projects, roles, binaries, enabled, draft, health, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET transport = excluded.transport, connection = excluded.connection, scenario = excluded.scenario,
         skill = excluded.skill, projects = excluded.projects, roles = excluded.roles, binaries = excluded.binaries,
         enabled = excluded.enabled, draft = excluded.draft, health = excluded.health, updated_at = excluded.updated_at`,
    ).run(reg.name, reg.transport, reg.connection, reg.scenario, reg.skill ?? null, JSON.stringify(reg.projects), JSON.stringify(reg.roles), JSON.stringify(reg.binaries), reg.enabled ? 1 : 0, reg.draft ? 1 : 0, health, prev?.created_at ?? now, now);
    d.prepare("DELETE FROM tool_ops WHERE tool = ?").run(reg.name);
    const ins = d.prepare("INSERT INTO tool_ops (tool, name, description, input_schema, level, level_by, template, undo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    for (const o of reg.ops) {
      // builtin 的撤销由 run 返回，登记里不写 undo 说明
      const level = o.level === "reversible" && !o.undo && reg.transport !== "builtin" ? "irreversible" : o.level;
      ins.run(reg.name, o.name, o.description, JSON.stringify(o.inputSchema), level, o.levelBy, o.template ? JSON.stringify(o.template) : null, o.undo ? JSON.stringify(o.undo) : null);
    }
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
  return getTool(reg.name)!;
}

export function removeTool(name: string): ToolRegistration | undefined {
  const before = getTool(name);
  if (!before) return undefined;
  const d = db();
  d.exec("BEGIN");
  try {
    d.prepare("DELETE FROM tool_ops WHERE tool = ?").run(name);
    d.prepare("DELETE FROM tools WHERE name = ?").run(name);
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
  return before;
}

export function setHealth(name: string, h: ToolHealth): void {
  db().prepare("UPDATE tools SET health = ? WHERE name = ?").run(JSON.stringify(h), name);
}

export function guardedBinaries(): string[] {
  return [...new Set(listTools({ enabled: true }).flatMap((t) => t.binaries))];
}

export const usableOps = (reg: ToolRegistration): ToolOp[] => reg.ops.filter((o) => o.level !== null);
