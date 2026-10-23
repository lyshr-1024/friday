import { z } from "zod";
import type { ToolLevel } from "@friday/shared";
import type { Undo } from "../memory/audit.js";
import { getTool, saveTool } from "./registry.js";

/** evidence 会合进这次调用的账（如 slack 发送的 ts / permalink） */
export interface OpResult { text: string; value?: unknown; undo?: Undo; evidence?: Record<string, unknown> }

export interface BuiltinOp {
  name: string; description: string; input: z.ZodRawShape; level: ToolLevel;
  /** 记账用的 action 名；不给就是 `${tool}_${op}` */
  audit?: string;
  run(args: Record<string, unknown>): Promise<OpResult>;
}

export interface BuiltinTool { name: string; scenario: string; roles: string[]; binaries: string[]; ops: BuiltinOp[]; health?(): Promise<void> }

const defined = new Map<string, BuiltinTool>();

export function defineBuiltin(t: BuiltinTool): void {
  defined.set(t.name, t);
}

export const builtin = (name: string): BuiltinTool | undefined => defined.get(name);

export const builtins = (): BuiltinTool[] => [...defined.values()];

/** 启动时调：每个 builtin upsert 成登记（levelBy "builtin"、draft false），保留已有的 enabled / projects */
export function seedBuiltins(): void {
  for (const t of defined.values()) {
    const prev = getTool(t.name);
    saveTool({
      name: t.name, transport: "builtin", connection: t.name, scenario: t.scenario,
      projects: prev?.projects ?? [], roles: t.roles, binaries: t.binaries,
      enabled: prev?.enabled ?? true, draft: false,
      ops: t.ops.map((o) => ({
        name: o.name, description: o.description, inputSchema: z.toJSONSchema(z.object(o.input)) as Record<string, unknown>,
        level: o.level, levelBy: "builtin",
      })),
    });
  }
}
