import { tool } from "@anthropic-ai/claude-agent-sdk";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readdirSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ToolLevel, ToolOp, ToolRegistration } from "@friday/shared";
import { builtins } from "../connectors/builtin.js";
import { badUndo, stable, undoSpecSchema } from "../connectors/invoke.js";
import { listTools as mcpListTools, mcpServers, type McpToolInfo } from "../connectors/mcp.js";
import { listStdioTools } from "../connectors/mcpStdio.js";
import { getTool, listTools, removeTool, saveTool } from "../connectors/registry.js";
import { record } from "../memory/audit.js";
import { scheduleByConversation } from "../memory/schedules.js";
import { consentGate } from "./consent.js";
import { byYou, saidLast } from "./selfTools.js";

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const SCHEDULED = "定时任务里不能改 Friday 的配置，等用户回来。";
const inSchedule = (c?: string) => Boolean(c && scheduleByConversation(c));
const confirmGate = consentGate();
const removeGate = consentGate();
const CONFIRM = ["确认", "登记吧", "就这样"];
const REMOVE = ["删掉", "删掉吧"];
const RANK: Record<string, number> = { read: 0, reversible: 1, irreversible: 2, null: 3 };
const READ_NAME = /^(get|list|index|describe|search|query|read|export|preview|has)/;
const WRITE_VERB = new Set(["delete", "remove", "update", "create", "set", "deploy", "apply", "send", "post", "write", "drop", "exec", "run"]);
/** 名字按 _ - . 和驼峰拆词，哪一段是写动词都不算只读（get_and_delete、getAndDelete） */
const readName = (n: string) =>
  READ_NAME.test(n) && !n.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[\s_.-]+/).some((w) => WRITE_VERB.has(w.toLowerCase()));

const execOut = (cmd: string, args: string[]) =>
  new Promise<string | undefined>((resolve) => {
    execFile(cmd, args, { timeout: 5000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => resolve(err && !stdout && !stderr ? undefined : `${stdout}${stderr}`));
  });

const which = async (bin: string) => (await execOut("/usr/bin/which", [bin]))?.trim() || undefined;

function skillDirs(name: string): string[] {
  const found: string[] = [];
  const lower = name.toLowerCase();
  const user = join(homedir(), ".claude", "skills");
  if (existsSync(user)) for (const e of readdirSync(user)) if (e.toLowerCase().startsWith(lower)) found.push(join(user, e));
  const scan = (dir: string, depth: number) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = join(dir, e.name);
      if (e.name.toLowerCase().startsWith(lower) && /\/skills\/[^/]+$/.test(p)) found.push(p);
      else if (depth > 0) scan(p, depth - 1);
    }
  };
  scan(join(homedir(), ".claude", "plugins"), 6);
  return found;
}

const argsLine = (a: Record<string, string>) => Object.entries(a).map(([k, v]) => `${k}=${v}`).join(", ");
// 用户确认的是会真正跑的东西：连哪、敲什么命令、撤销调什么，不只是名字和等级
const opLine = (r: Pick<ToolRegistration, "connection">, o: ToolOp) =>
  [
    `${o.name} · ${o.level ?? "未定级"} · ${o.description.slice(0, 80)}`,
    o.template ? `  命令：${r.connection} ${o.template.join(" ")}` : "",
    o.undo ? `  撤销 = 调 ${o.undo.op}(${argsLine(o.undo.args)})${o.undo.before ? `，先调 ${o.undo.before.op}(${argsLine(o.undo.before.args)}) 取快照` : ""}` : "",
  ].filter(Boolean).join("\n");
const manifest = (r: ToolRegistration) =>
  `${r.name}（${r.transport} · 连接 ${r.connection}，${r.draft ? "草稿" : r.enabled ? "已启用" : "已停用"}）\n${r.ops.map((o) => `- ${opLine(r, o)}`).join("\n")}`;

const fetchOps = (reg: ToolRegistration): Promise<McpToolInfo[]> => (reg.transport === "mcp_stdio" ? listStdioTools(reg.connection) : mcpListTools(reg.connection));

const opSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500),
  inputSchema: z.object({}).passthrough(),
  level: z.enum(["read", "reversible", "irreversible"]),
  template: z.array(z.string()).optional().describe("cli 专用：argv 模板，{参数名} 换成参数值"),
  undo: undoSpecSchema.optional().describe("reversible 必须带：{op, args, before?: {op, args}}，op 是本工具里的操作名，args 的值都是字符串，可写 $args.x / $result.x / $before.x"),
});

function normalizeOp(o: z.infer<typeof opSchema>): ToolOp {
  let level: ToolLevel = o.level;
  if (level === "read" && !readName(o.name)) level = "irreversible";
  if (level === "reversible" && !o.undo) level = "irreversible";
  return {
    name: o.name, description: o.description, inputSchema: o.inputSchema as Record<string, unknown>, level, levelBy: "friday",
    ...(o.template ? { template: o.template } : {}),
    ...(o.undo ? { undo: o.undo } : {}),
  };
}

function audit(action: string, conversationId: string | undefined, what: string, how: string, name: string, before: ToolRegistration | undefined) {
  record({
    action, why: byYou(conversationId, what), how,
    evidence: { quote: saidLast(conversationId), name },
    risk: "reversible",
    undo: { kind: "restore_tool", name, before: before ?? null },
  });
}

export function toolAdminList(conversationId?: string) {
  return [
    tool(
      "tool_discover",
      "用户说「接一下 X」时先调：查本机有没有叫 X 的 MCP、命令行、skill，带回操作清单或 --help，供你判断怎么登记。只读。",
      { name: z.string().min(1).max(80).regex(/^[\w.-]+$/, "name 只能是字母数字下划线点横线") },
      async ({ name }) => {
        const out: string[] = [];
        const hits = mcpServers().filter((s) => s.name === name || s.name.includes(name));
        for (const s of hits) {
          try {
            const ops = s.http ? await mcpListTools(s.name) : await listStdioTools(s.name);
            out.push(`MCP「${s.name}」（${s.http ? "mcp_http" : "mcp_stdio"}）操作：\n${ops.map((o) => `- ${o.name}：${o.description.slice(0, 120)}`).join("\n")}`);
          } catch (e) {
            out.push(`MCP「${s.name}」列不出操作：${e instanceof Error ? e.message : String(e)}`);
          }
        }
        let hasCli = false;
        for (const bin of [name, `${name}-cli`]) {
          const path = await which(bin);
          if (!path) continue;
          hasCli = true;
          const help = await execOut(path, ["--help"]);
          out.push(`命令行 ${bin}（${path}）--help：\n${(help ?? "（没有输出）").slice(0, 4000)}`);
        }
        const skills = skillDirs(name);
        if (skills.length) out.push(`skill：${skills.join("、")}`);
        if (!hits.length && !hasCli) out.push(skills.length ? "只有 skill、没有 MCP 或命令行：Friday 调不了，只能交给终端里的 Claude。" : `没找到叫 ${name} 的 MCP、命令行或 skill。`);
        return text(out.join("\n\n"));
      },
    ),
    tool(
      "tool_register",
      "把一个外部工具登记成草稿（还不能用）。ops 的 level 由你按操作的后果提议：只读查询 read；能撤销的 reversible 且必须带 undo；其余 irreversible。登记后把返回的清单转告用户，等他确认或改等级，再 tool_update confirm。",
      {
        name: z.string().min(1).max(80),
        transport: z.enum(["mcp_http", "mcp_stdio", "cli"]),
        connection: z.string().min(1).describe("mcp：~/.claude.json 里的 server 名；cli：可执行文件"),
        scenario: z.string().min(1).max(300).describe("什么场景下用它"),
        skill: z.string().optional(),
        projects: z.array(z.string()).optional(),
        binaries: z.array(z.string()).optional(),
        ops: z.array(opSchema).min(1),
      },
      async ({ name, transport, connection, scenario, skill, projects, binaries, ops }) => {
        if (inSchedule(conversationId)) return text(SCHEDULED);
        if (builtins().some((b) => b.name === name)) return text(`已有同名内置工具 ${name}，换个名字。`);
        const prev = getTool(name);
        if (prev && !prev.draft) return text(`已有登记 ${name}，要改用 tool_update。`);
        const names = ops.map((o) => o.name);
        const dup = names.find((n, i) => names.indexOf(n) !== i);
        if (dup) return text(`操作名重复：${dup}`);
        for (const o of ops) {
          const bad = o.undo && badUndo(o.undo, ops);
          if (bad) return text(`${o.name} 的${bad}`);
        }
        const saved = saveTool({
          name, transport, connection, scenario, ...(skill ? { skill } : {}),
          projects: projects ?? [], roles: [], binaries: binaries ?? [],
          enabled: false, draft: true, ops: ops.map(normalizeOp),
        });
        audit("tool_registered", conversationId, `登记外部工具草稿 ${name}`, `登记 ${name}（${transport}）草稿，${saved.ops.length} 个操作`, name, prev);
        return text(`已登记草稿（还不能用）：\n${manifest(saved)}\n把清单转告用户；他说「确认」再 tool_update confirm，要改等级用 levels。`);
      },
    ),
    tool(
      "tool_update",
      "改已登记的工具或草稿：refresh 重新读 MCP 的操作清单；levels 按用户说的改操作等级；confirm 定稿启用（用户要单独回「确认」）。内置工具只能改 enabled / projects / scenario。",
      {
        name: z.string().min(1).max(80),
        confirm: z.boolean().optional(),
        refresh: z.boolean().optional(),
        scenario: z.string().max(300).optional(),
        projects: z.array(z.string()).optional(),
        enabled: z.boolean().optional(),
        levels: z.object({}).passthrough().optional().describe("{操作名: read|reversible|irreversible}"),
      },
      async ({ name, confirm, refresh, scenario, projects, enabled, levels }) => {
        if (inSchedule(conversationId)) return text(SCHEDULED);
        const reg = getTool(name);
        if (!reg) return text(`没有登记 ${name}`);
        if (reg.transport === "builtin" && (confirm || refresh || levels)) return text("内置工具只能改 enabled / projects / scenario。");
        if (refresh && reg.transport !== "mcp_http" && reg.transport !== "mcp_stdio") return text("只有 MCP 工具能 refresh。");
        const lv = (levels ?? {}) as Record<string, unknown>;
        const refusedRead: string[] = [];
        for (const [op, l] of Object.entries(lv)) {
          if (!reg.ops.some((o) => o.name === op)) return text(`${name} 里没有操作 ${op}`);
          if (l !== "read" && l !== "reversible" && l !== "irreversible") return text(`等级只能是 read / reversible / irreversible：${op}`);
        }
        if (confirm && !reg.draft) return text(`${name} 已经定稿了。`);
        if (enabled && reg.draft && !confirm) return text(`${name} 还是草稿，先让用户确认（confirm）再启用。`);
        let ops = reg.ops;
        const notes: string[] = [];
        if (refresh) {
          let fresh: McpToolInfo[];
          try {
            fresh = await fetchOps(reg);
          } catch (e) {
            return text(`没刷新成：${e instanceof Error ? e.message : String(e)}`);
          }
          const have = new Set(ops.map((o) => o.name));
          const gone = ops.filter((o) => !fresh.some((f) => f.name === o.name)).map((o) => o.name);
          const added = fresh.filter((f) => !have.has(f.name));
          ops = [
            ...ops.filter((o) => !gone.includes(o.name)),
            ...added.map((f): ToolOp => ({ name: f.name, description: f.description, inputSchema: f.inputSchema, level: null, levelBy: "friday" })),
          ];
          notes.push(`刷新：去掉 ${gone.length} 个，新增 ${added.length} 个（新增的未定级，不能用）`);
        }
        const changed = new Set<string>();
        let lowering = false;
        ops = ops.map((o) => {
          if (!(o.name in lv)) return o;
          let level = lv[o.name] as ToolLevel;
          if (level === "read" && !readName(o.name)) {
            refusedRead.push(o.name);
            return o;
          }
          if (level === "reversible" && !o.undo) level = "irreversible";
          if (level === o.level) return o;
          changed.add(o.name);
          if (RANK[level]! < RANK[String(o.level)]!) lowering = true;
          return { ...o, level };
        });
        if (refusedRead.length) return text(`${refusedRead.join("、")} 的名字不像只读操作，不能定成 read。`);
        const next = {
          ...reg,
          ops,
          scenario: scenario ?? reg.scenario,
          projects: projects ?? reg.projects,
          enabled: confirm ? true : (enabled ?? reg.enabled),
          draft: confirm ? false : reg.draft,
        };
        let consented = false;
        if (confirm || lowering) {
          // 问完到同意之间草稿可能被重新登记：连接、命令模板、撤销变了都得重问
          const key = `update|${name}|${createHash("sha1").update(stable({ transport: next.transport, connection: next.connection, ops: next.ops.map((o) => [o.name, o.level, o.template ?? null, o.undo ?? null]), enabled: next.enabled, draft: next.draft, scenario: next.scenario, projects: next.projects })).digest("hex")}`;
          const gate = confirmGate(conversationId, key, CONFIRM);
          if (!gate.ok) {
            const why = [confirm ? `启用 ${name}` : "", lowering ? "调低了操作的风险等级（调低后对应操作可直接执行）" : ""].filter(Boolean).join("，并");
            return text(`要${why}，改完的清单：\n${manifest(next)}\n没定级的操作不能用。确认请用户单独回一句「确认」，再用完全相同的参数调一次。`);
          }
          consented = true;
        }
        if (consented) next.ops = next.ops.map((o) => (changed.has(o.name) ? { ...o, levelBy: "user" as const } : o));
        if (changed.size) notes.push(`改等级：${[...changed].map((k) => `${k}→${String(next.ops.find((o) => o.name === k)!.level)}`).join("、")}`);
        if (scenario !== undefined) notes.push("改了场景");
        if (projects) notes.push("改了项目范围");
        if (enabled !== undefined && !confirm) notes.push(enabled ? "启用" : "停用");
        if (confirm) notes.push("定稿启用");
        const saved = saveTool(next);
        const summary = notes.join("；") || "无变化";
        audit("tool_updated", conversationId, `改外部工具 ${name}`, summary, name, reg);
        const demoted = saved.ops.filter((o) => lv[o.name] === "reversible" && o.level === "irreversible");
        return text(`改好了（${summary}，可在操作记录里撤销）。${demoted.length ? `\n${demoted.map((o) => o.name).join("、")} 没有撤销说明，按 irreversible 存。` : ""}\n${manifest(saved)}`);
      },
    ),
    tool(
      "tool_remove",
      "删掉一个已登记的外部工具（内置工具不能删，只能停用）。要用户单独回「删掉」才执行：先调一次拿说明转告他，他回了再调。",
      { name: z.string().min(1).max(80) },
      async ({ name }) => {
        if (inSchedule(conversationId)) return text(SCHEDULED);
        const reg = getTool(name);
        if (!reg) return text(`没有登记 ${name}`);
        if (reg.transport === "builtin") return text("内置工具只能停用");
        const gate = removeGate(conversationId, `remove|${name}`, REMOVE);
        if (!gate.ok) return text(`要删除工具 ${name}（${reg.ops.length} 个操作）。删后可在操作记录里撤销登记。确认请用户单独回一句「删掉」，再调一次。`);
        const before = removeTool(name);
        audit("tool_removed", conversationId, `删外部工具 ${name}`, `删除登记 ${name}`, name, before);
        return text(`已删除 ${name}（可在操作记录里撤销）。`);
      },
    ),
    tool("tools_list", "列出所有已登记的工具：连接方式、启用 / 草稿、各等级操作数、健康。", {}, async () => {
      const lines = listTools().map((r) => {
        const n = (l: ToolLevel | null) => r.ops.filter((o) => o.level === l).length;
        const health = r.health ? (r.health.ok ? "健康" : "异常") : "未检查";
        return `${r.name} · ${r.transport} · ${r.draft ? "草稿" : r.enabled ? "启用" : "停用"} · read ${n("read")} / reversible ${n("reversible")} / irreversible ${n("irreversible")} / 未定级 ${n(null)} · ${health}`;
      });
      return text(lines.join("\n") || "还没有登记工具。");
    }),
  ];
}
