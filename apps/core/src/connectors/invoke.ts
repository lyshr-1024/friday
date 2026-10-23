import type { ToolOp, ToolRegistration } from "@friday/shared";
import { record } from "../memory/audit.js";
import { addPending, getTask } from "../memory/tasks.js";
import { builtin, type OpResult } from "./builtin.js";
import { fillTemplate, runCli } from "./cli.js";
import { callTool } from "./mcp.js";
import { getTool } from "./registry.js";

export type Caller =
  | { kind: "friday"; why: string; taskId?: string; approvedPendingId?: string }
  | { kind: "user"; why: string; taskId?: string; quote?: string }
  | { kind: "model"; why: string; conversationId?: string; taskId?: string; jobId?: string; quote?: string }
  | { kind: "schedule"; why: string; scheduleId: string };

export type InvokeResult =
  | { kind: "ok"; text: string; value?: unknown }
  | { kind: "held"; pendingId: string }
  | { kind: "needs_consent"; summary: string }
  | { kind: "refused"; why: string };

type Exec = OpResult & { audit?: string };

const refused = (why: string): InvokeResult => ({ kind: "refused", why });

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const dig = (v: unknown, path: string[]): unknown =>
  path.reduce<unknown>((cur, k) => (cur && typeof cur === "object" ? (cur as Record<string, unknown>)[k] : undefined), v);

function resolve(spec: Record<string, string>, scope: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(spec).map(([k, expr]) => {
      const m = /^\$(args|result|before)(?:\.(.+))?$/.exec(expr);
      return [k, m ? dig(scope[m[1]!], m[2] ? m[2].split(".") : []) : expr];
    }),
  );
}

async function execOp(reg: ToolRegistration, op: ToolOp, args: Record<string, unknown>): Promise<Exec> {
  if (reg.transport === "builtin") {
    const code = builtin(reg.name)?.ops.find((o) => o.name === op.name)!;
    return { ...(await code.run(args)), ...(code.audit ? { audit: code.audit } : {}) };
  }
  if (reg.transport === "mcp_http") {
    const r = await callTool(reg.connection, op.name, args);
    if (r.isError) throw new Error(`${reg.name}.${op.name} 失败：${r.text.slice(0, 500)}`);
    return { text: r.text, value: parseJson(r.text) };
  }
  if (reg.transport === "cli") {
    if (!op.template) throw new Error(`${reg.name}.${op.name} 没有命令模板`);
    const out = await runCli(reg.connection, fillTemplate(op.template, args));
    return { text: out, value: parseJson(out) };
  }
  throw new Error("stdio 还没接");
}

export async function invokeTool(caller: Caller, tool: string, opName: string, args: Record<string, unknown>): Promise<InvokeResult> {
  const reg = getTool(tool);
  if (!reg || !reg.enabled || reg.draft) return refused(`工具 ${tool} 没登记或没启用`);
  const op = reg.ops.find((o) => o.name === opName);
  if (!op || (reg.transport === "builtin" && !builtin(tool)?.ops.some((o) => o.name === opName))) return refused(`${tool} 里没有操作 ${opName}`);
  const level = op.level;
  if (level === null) return refused(`${opName} 还没定级，先让用户定`);

  if (caller.kind === "model" && caller.taskId && reg.projects.length) {
    const project = getTask(caller.taskId)?.project;
    if (!project || !reg.projects.includes(project)) return refused(`${tool} 只给 ${reg.projects.join("、")} 用，这条任务的项目是 ${project ?? "未定"}`);
  }

  if (level === "irreversible") {
    if (caller.kind === "friday" && !caller.approvedPendingId) throw new Error(`不可逆操作 ${tool}.${opName} 必须带已批准的待审动作`);
    if (caller.kind === "model") {
      const shown = JSON.stringify(args);
      if (!caller.taskId) return { kind: "needs_consent", summary: `要执行 ${tool}.${opName}（参数 ${shown.slice(0, 300)}），撤不回` };
      const t = addPending(caller.taskId, {
        type: "tool_call",
        label: `执行 ${tool}.${opName}`,
        detail: shown.slice(0, 500),
        payload: { tool, op: opName, args, conversationId: caller.conversationId, jobId: caller.jobId },
      });
      const pending = t?.pending?.at(-1);
      if (!pending) return refused(`任务 ${caller.taskId} 不在了`);
      return { kind: "held", pendingId: pending.id };
    }
  }

  let before: unknown;
  const spec = reg.transport === "builtin" || level !== "reversible" ? undefined : op.undo;
  if (spec?.before) {
    const snapOp = reg.ops.find((o) => o.name === spec.before!.op);
    if (!snapOp) return refused(`${tool} 里没有撤销要用的操作 ${spec.before.op}`);
    before = (await execOp(reg, snapOp, resolve(spec.before.args, { args }))).value;
  }

  const res = await execOp(reg, op, args);
  const undo = spec
    ? { kind: "tool_undo" as const, tool, op: spec.op, args: resolve(spec.args, { args, result: res.value, before }) }
    : res.undo;

  if (level !== "read" || caller.kind === "model") {
    record({
      ...("taskId" in caller && caller.taskId ? { taskId: caller.taskId } : {}),
      action: res.audit ?? `${tool}_${opName}`,
      why: caller.why,
      how: `调 ${tool}.${opName}`,
      evidence: { tool, op: opName, args, caller: caller.kind, ...("quote" in caller && caller.quote ? { quote: caller.quote } : {}), ...res.evidence },
      risk: level,
      ...(caller.kind === "friday" && caller.approvedPendingId ? { status: "approved" as const } : {}),
      ...(undo ? { undo } : {}),
    });
  }
  return { kind: "ok", text: res.text, ...(res.value !== undefined ? { value: res.value } : {}) };
}
