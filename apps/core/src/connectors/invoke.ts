import { z } from "zod";
import type { ToolOp, ToolRegistration, ToolUndoSpec } from "@friday/shared";
import { record } from "../memory/audit.js";
import { addPending, getTask } from "../memory/tasks.js";
import { builtin, type OpResult } from "./builtin.js";
import { fillTemplate, runCli } from "./cli.js";
import { callTool } from "./mcp.js";
import { callStdio } from "./mcpStdio.js";
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

/** 键排序后的 JSON：同一组参数换个顺序也认成同一个 */
export const stable = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(stable).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v ?? null);

const strMap = z.object({}).catchall(z.string());
export const undoSpecSchema = z.object({
  op: z.string().min(1),
  args: strMap,
  before: z.object({ op: z.string().min(1), args: strMap }).strict().optional(),
}).strict();

/** 撤销说明的形状和指向的操作；不对就返回原因 */
export function badUndo(spec: unknown, ops: Pick<ToolOp, "name">[]): string | undefined {
  const p = undoSpecSchema.safeParse(spec);
  if (!p.success) return `撤销说明格式不对（要 {op, args, before?}，args 的值都是字符串）：${z.prettifyError(p.error)}`;
  const missing = [p.data.op, p.data.before?.op].filter((o): o is string => Boolean(o) && !ops.some((x) => x.name === o));
  return missing.length ? `撤销说明里的操作不存在：${missing.join("、")}` : undefined;
}

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

const builtinOp = (tool: string, op: string) => builtin(tool)?.ops.find((o) => o.name === op);

async function execOp(reg: ToolRegistration, op: ToolOp, args: Record<string, unknown>): Promise<Exec> {
  if (reg.transport === "builtin") {
    const code = builtinOp(reg.name, op.name)!;
    return { ...(await code.run(args)), ...(code.audit ? { audit: code.audit } : {}) };
  }
  if (reg.transport === "mcp_http") {
    const r = await callTool(reg.connection, op.name, args);
    if (r.isError) throw new Error(`${reg.name}.${op.name} 失败：${r.text.slice(0, 500)}`);
    return { text: r.text, value: parseJson(r.text) ?? parseJson(r.blocks?.[0] ?? "") };
  }
  if (reg.transport === "cli") {
    if (!op.template) throw new Error(`${reg.name}.${op.name} 没有命令模板`);
    const out = await runCli(reg.connection, fillTemplate(op.template, args));
    return { text: out, value: parseJson(out) };
  }
  if (reg.transport === "mcp_stdio") {
    const r = await callStdio(reg.connection, op.name, args);
    if (r.isError) throw new Error(`${reg.name}.${op.name} 失败：${r.text.slice(0, 500)}`);
    return { text: r.text, value: parseJson(r.text) };
  }
  throw new Error(`未知传输 ${reg.transport}`);
}

export async function invokeTool(caller: Caller, tool: string, opName: string, rawArgs: Record<string, unknown>): Promise<InvokeResult> {
  const reg = getTool(tool);
  if (!reg || !reg.enabled || reg.draft) return refused(`工具 ${tool} 没登记或没启用`);
  const op = reg.ops.find((o) => o.name === opName);
  const code = reg.transport === "builtin" ? builtinOp(tool, opName) : undefined;
  if (!op || (reg.transport === "builtin" && !code)) return refused(`${tool} 里没有操作 ${opName}`);
  const level = op.level;
  if (level === null) return refused(`${opName} 还没定级，先让用户定`);

  let args = rawArgs;
  if (code) {
    const parsed = z.object(code.input).strict().safeParse(rawArgs);
    if (!parsed.success) return refused(`${tool}.${opName} 参数不对：${z.prettifyError(parsed.error)}`);
    args = parsed.data as Record<string, unknown>;
  }
  const spec: ToolUndoSpec | undefined = reg.transport === "builtin" || level !== "reversible" ? undefined : op.undo;
  if (spec) {
    const bad = badUndo(spec, reg.ops);
    if (bad) return refused(`${tool}.${opName} 的${bad}，先修登记再调`);
  }

  if (caller.kind === "model" && caller.taskId && reg.projects.length) {
    const project = getTask(caller.taskId)?.project;
    if (!project || !reg.projects.includes(project)) return refused(`${tool} 只给 ${reg.projects.join("、")} 用，这条任务的项目是 ${project ?? "未定"}`);
  }

  if (level === "irreversible") {
    if (caller.kind === "friday" && !caller.approvedPendingId) throw new Error(`不可逆操作 ${tool}.${opName} 必须带已批准的待审动作`);
    if (caller.kind === "model") {
      const shown = JSON.stringify(args);
      if (!caller.taskId) return { kind: "needs_consent", summary: `要执行 ${tool}.${opName}（参数 ${shown.slice(0, 300)}），撤不回` };
      const same = stable({ tool, op: opName, args });
      // 模型没等到结果又调了一次：批两次就是不可逆操作执行两遍
      const dup = getTask(caller.taskId)?.pending?.find((p) => p.type === "tool_call" && stable({ tool: p.payload.tool, op: p.payload.op, args: p.payload.args }) === same);
      if (dup) return { kind: "held", pendingId: dup.id };
      const t = addPending(caller.taskId, {
        type: "tool_call",
        label: `执行 ${tool}.${opName}`,
        detail: shown.slice(0, 500),
        payload: { tool, op: opName, args, conversationId: caller.conversationId, jobId: caller.jobId },
      }, { keepStatus: true });
      const pending = t?.pending?.at(-1);
      if (!pending) return refused(`任务 ${caller.taskId} 不在了`);
      return { kind: "held", pendingId: pending.id };
    }
  }

  let before: unknown;
  if (spec?.before) {
    const snapOp = reg.ops.find((o) => o.name === spec.before!.op);
    if (!snapOp) return refused(`${tool} 里没有撤销要用的操作 ${spec.before.op}`);
    if (snapOp.level !== "read") return refused(`撤销前取快照的操作 ${tool}.${snapOp.name} 不是只读，不执行`);
    before = (await execOp(reg, snapOp, resolve(spec.before.args, { args }))).value;
  }

  const res = await execOp(reg, op, args);
  const undoArgs = spec ? resolve(spec.args, { args, result: res.value, before }) : undefined;
  // 已经写出去了，账必须记；撤销参数取不到就不带撤销，免得撤的时候把空值写回去
  const lost = undoArgs ? Object.keys(undoArgs).filter((k) => undoArgs[k] === undefined) : [];
  const undo = spec ? (lost.length ? undefined : { kind: "tool_undo" as const, tool, op: spec.op, args: undoArgs! }) : res.undo;

  if (level !== "read" || caller.kind === "model") {
    record({
      ...("taskId" in caller && caller.taskId ? { taskId: caller.taskId } : {}),
      action: res.audit ?? `${tool}_${opName}`,
      why: caller.why,
      how: `调 ${tool}.${opName}${lost.length ? `；撤销要的 ${lost.join("、")} 没取到值，这次撤不了` : ""}`,
      evidence: { tool, op: opName, args, caller: caller.kind, ...("quote" in caller && caller.quote ? { quote: caller.quote } : {}), ...res.evidence },
      risk: level,
      ...(caller.kind === "friday" && caller.approvedPendingId ? { status: "approved" as const } : {}),
      ...(undo ? { undo } : {}),
    });
  }
  return { kind: "ok", text: res.text, ...(res.value !== undefined ? { value: res.value } : {}) };
}
