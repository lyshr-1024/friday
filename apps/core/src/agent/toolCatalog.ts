import type { ToolRegistration } from "@friday/shared";
import { invokeTool, type Caller, type InvokeResult } from "../connectors/invoke.js";
import { getTool, listTools, usableOps } from "../connectors/registry.js";

const PRESELECT_MAX = 3000;

const serves = (t: ToolRegistration, project?: string) => !project || !t.projects.length || t.projects.includes(project);

const usable = () => listTools({ enabled: true }).filter((t) => !t.draft && usableOps(t).length);

export function catalogLines(project?: string): string[] {
  return usable()
    .filter((t) => serves(t, project))
    .map((t) => `${t.name} · ${t.scenario}`);
}

export function describeTool(name: string, project?: string): string {
  const t = getTool(name);
  if (!t) return `${name} 不可用：没登记`;
  if (!t.enabled) return `${name} 不可用：没启用`;
  if (t.draft) return `${name} 不可用：还没登记完`;
  const ops = usableOps(t);
  if (!ops.length) return `${name} 不可用：操作都还没定级，先让用户定`;
  if (!serves(t, project)) return `${name} 不可用：只给 ${t.projects.join("、")} 用`;
  return [
    `${t.name} · ${t.scenario}`,
    ...ops.map((o) => {
      const schema = { ...o.inputSchema };
      delete schema.$schema;
      return `- ${o.name}（${o.level}）：${o.description}\n  参数：${JSON.stringify(schema)}`;
    }),
  ].join("\n");
}

export function preselect(project: string): string {
  return usable()
    .filter((t) => t.projects.includes(project))
    .map((t) => describeTool(t.name, project))
    .join("\n\n")
    .slice(0, PRESELECT_MAX);
}

export const CATALOG_HINT = "要用时先 tool_describe 看操作和参数，再 tool_call；不可逆的会挂待审或要用户说「执行」。";

export const catalogBlock = (project?: string): string[] => {
  const lines = catalogLines(project);
  return lines.length ? ["【外部工具】", ...lines, CATALOG_HINT] : [];
};

/** 模型会话调工具：连不上、外部报错都折成 refused，不往上抛 */
export async function invokeForModel(caller: Caller, tool: string, op: string, args: Record<string, unknown>): Promise<InvokeResult> {
  try {
    return await invokeTool(caller, tool, op, args);
  } catch (e) {
    return { kind: "refused", why: `没调成：${e instanceof Error ? e.message : String(e)}` };
  }
}

export const heldText = (seq: number | undefined, tool: string, op: string) => `已挂待审 #${seq ?? "?"}：执行 ${tool}.${op}，等用户点头`;
