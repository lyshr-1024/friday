# 外部工具注册处 · 第一步（拆代码）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Friday 业务代码不再含外部系统的规则，所有外部调用经注册处的统一入口 `invokeTool` 按风险等级放行 / 记账 / 挂待审；接新工具在对话里完成；堵上终端会话加载全局 MCP 的漏洞。任务数据字段不动（那是第二步）。

**Architecture:** 新增注册处（SQLite 表 `tools` + `tool_ops`，`connectors/registry.ts`）和统一入口（`connectors/invoke.ts`）。现有 Meegle / Slack / Lark / 读网页改成进程内的 builtin 工具，放在 `connectors/<名字>/`，同时对 Friday 代码提供「角色」接口（`connectors/roles.ts`），对模型会话提供按需加载的操作；OKR 登记为 `mcp_http` 工具。模型会话只看到工具目录，经 `tool_describe` / `tool_call` 调用。

**Tech Stack:** TypeScript、Node `node:sqlite`、hono、zod、vitest、`@anthropic-ai/claude-agent-sdk`（`tool` / `createSdkMcpServer`）、`@modelcontextprotocol/sdk` 1.30（已在 core 依赖里，用于 stdio）。

**Spec:** `docs/superpowers/specs/2026-10-23-tool-registry-design.md`

## Global Constraints

- 只做设计稿「4.7 第一步」：`TaskSource` / `TaskKind` / `LinkKind` / `inbox` 表的字段名和值**一律不改**。`packages/shared` 的 `taskCategory` 仍按 `meegleType` 原值判断（库里存的是原值），第二步再收。
- 风险等级三档 `read` / `reversible` / `irreversible`；`reversible` 必须带撤销说明，否则按 `irreversible` 存；未定级（`level: null`）的操作对任何调用方都不可用。
- Friday 自己的代码调 `irreversible` 操作必须带已批准的待审动作 id，否则**抛错**；模型会话调 `irreversible`：有任务挂待审 `tool_call`，没任务走两步同意。
- 不把任何 builtin 挪到外部进程；本机能力（git / tmux / worktree / 守卫 / `localDev` / `stageWatch`）不进注册处。
- `--strict-mcp-config` 只加给 Friday 驾驶的会话（`kind !== "interactive"`），用户驾驶的项目终端不变。
- 守卫拦「已登记工具的 `binaries`」：`meegle`、`lark-cli`、`agent-browser`；没登记的命令行不拦（已知旁路）。主对话 Skill 模式不动。
- `todos` 表不删，只停止读写。
- 代码目录用 `connectors/`，不新建 `tools/`（避免和会话工具 `agent/tools.ts` 混淆）；`agent/toolAdmin.ts` 不许 import `agent/tools.ts`（循环导入会 TDZ，见 CLAUDE.md「consent.ts」一条）。
- 业务文件第一步不改名（`agent/meegle.ts`、`agent/slack/*` 保持原路径）。
- 提交信息中文，每个任务至少一提交，不覆盖 git author；结尾带 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。
- 测试命令：`cd apps/core && pnpm vitest run <文件>`；全量 `pnpm -r test`、`pnpm -r typecheck`（仓库根目录）。
- 真机验证只 kill 自己 `$!` 记下的 PID，前后各看一次 `lsof -nP 2>/dev/null | grep -c /dev/ptmx`；core 跑在活着的父进程下（`ppid === 1` 会自退）。

**对设计稿的两处更正（计划按更正后的执行）：**
1. 设计稿 4.2 写「每次调用写 `activity`（已有表）」——`activity` 表其实是 shell 活动记录，不适用。改为：模型会话的调用（含 `read`）和所有 `reversible` / `irreversible` 调用写 `audit`；Friday 代码的 `read` 调用不记（每轮同步几十次，记了是噪音）。
2. 设计稿 4.4 说角色绑定在设置里。第一步每个角色只有一个实现，绑定用 `UserSettings.roles`（带默认值），不进对话可改的 `SETTINGS_KEYS` 白名单、不加设置页控件。

## Review Focus

1. **MCP 工具升级后操作变了**：刷新登记（`tool_update refresh`）后，少了的操作再被调用应得到「没有操作 X」的 `refused`，不是抛 500；多出来的操作 `level: null`，不暴露。→ Task 2、Task 9 各一条测试。
2. **`~/.claude.json` 读不到 / server 被删**：该工具健康显示失败、`tool_call` 返回可读错误；builtin 工具与同步链路不受影响。→ Task 11 测试。
3. **重名**：用户全局 MCP 里有个和 builtin 同名的 server（如 `slack`），`tool_register` 必须拒绝，builtin 不被覆盖。→ Task 9 测试。
4. **两步同意被绕过**：同一轮里模型连调两次 `tool_call` 不能自己批准自己；问与同意之间参数变了要重问。→ Task 8 测试。
5. **守卫误拦 / 漏拦**：`cat meegle.md`、`grep -r lark-cli docs/` 不拦；`npx lark-cli docs +fetch`、`/opt/homebrew/bin/meegle mywork todo`、`cd x && meegle …` 要拦。→ Task 10 测试。

---

### Task 1: 注册处的类型与存储

**Files:**
- Modify: `packages/shared/src/index.ts`（加类型；`PendingActionType` 加 `"tool_call"`）
- Modify: `apps/core/src/memory/schema.ts`（两张新表）
- Create: `apps/core/src/connectors/registry.ts`
- Test: `apps/core/src/connectors/registry.test.ts`

**Interfaces:**
- Produces（`packages/shared`）:
  ```ts
  export type ToolTransport = "builtin" | "mcp_http" | "mcp_stdio" | "cli";
  export type ToolLevel = "read" | "reversible" | "irreversible";
  /** 取值表达式：「$args.x」「$result.x」「$before.x」，其余当字面量 */
  export interface ToolUndoSpec { op: string; before?: { op: string; args: Record<string, string> }; args: Record<string, string> }
  export interface ToolOp {
    name: string; description: string; inputSchema: Record<string, unknown>;
    level: ToolLevel | null; levelBy: "friday" | "user" | "builtin";
    /** cli 专用：argv 模板，元素里的 {name} 换成参数值 */
    template?: string[];
    undo?: ToolUndoSpec;
  }
  export interface ToolHealth { at: string; ok: boolean; error?: string }
  export interface ToolRegistration {
    name: string; transport: ToolTransport; connection: string; scenario: string;
    skill?: string; projects: string[]; roles: string[]; binaries: string[];
    enabled: boolean; draft: boolean; ops: ToolOp[]; health?: ToolHealth;
    createdAt: string; updatedAt: string;
  }
  ```
- Produces（`connectors/registry.ts`）:
  - `listTools(opts?: { enabled?: boolean }): ToolRegistration[]`
  - `getTool(name: string): ToolRegistration | undefined`
  - `saveTool(reg: Omit<ToolRegistration, "createdAt" | "updatedAt">): ToolRegistration`（upsert，`ops` 整体替换；`reversible` 且没 `undo` 的操作存成 `irreversible`）
  - `removeTool(name: string): ToolRegistration | undefined`（返回删前快照）
  - `setHealth(name: string, h: ToolHealth): void`
  - `guardedBinaries(): string[]`（启用工具的 `binaries` 去重）
  - `usableOps(reg: ToolRegistration): ToolOp[]`（`level !== null`）

- [ ] **Step 1: 写失败测试** `registry.test.ts`：
  - `saveTool 往返`：存一条含两个 op 的登记，`getTool` 读回字段一致，`createdAt` 有值。
  - `reversible 没 undo 存成 irreversible`：`saveTool` 一个 `{ level: "reversible" }` 无 `undo` 的 op，读回 `level === "irreversible"`。
  - `saveTool 覆盖 ops`：同名再存只剩新的 ops。
  - `guardedBinaries 只算启用的`：两条工具，一条 `enabled: false`，结果只含启用那条的 binaries 且去重。
  - `usableOps 去掉未定级`：`level: null` 的不在结果里。
- [ ] **Step 2: 跑测试确认失败** `cd apps/core && pnpm vitest run src/connectors/registry.test.ts` → FAIL（模块不存在）
- [ ] **Step 3: 实现** 表结构：`tools(name TEXT PRIMARY KEY, transport, connection, scenario, skill, projects TEXT JSON, roles TEXT JSON, binaries TEXT JSON, enabled INTEGER, draft INTEGER, health TEXT JSON, created_at, updated_at)`、`tool_ops(tool TEXT, name TEXT, description, input_schema TEXT JSON, level TEXT NULL, level_by, template TEXT JSON, undo TEXT JSON, PRIMARY KEY(tool, name))`；`CREATE TABLE IF NOT EXISTS` 放进 `SCHEMA`，老库启动时自动建（不需要 `migrate()` 分支）。`saveTool` 在一个事务里删旧 ops 再插。
- [ ] **Step 4: 跑测试确认通过**，再跑 `pnpm -r typecheck`。
- [ ] **Step 5: 提交** `注册处：工具登记的类型与存储`

### Task 2: 统一入口 `invokeTool`、builtin 定义、待审 `tool_call` 与通用撤销

**Files:**
- Create: `apps/core/src/connectors/builtin.ts`、`apps/core/src/connectors/invoke.ts`、`apps/core/src/connectors/cli.ts`
- Modify: `apps/core/src/memory/audit.ts`（`Undo` 加 `{ kind: "tool_undo"; tool: string; op: string; args: Record<string, unknown> }`）
- Modify: `apps/core/src/agent/pipeline.ts`（`executePending` 加 `tool_call` 分支）
- Modify: `apps/core/src/api/tasks.ts`（`POST /audit/:id/undo` 加 `tool_undo` 分支）
- Test: `apps/core/src/connectors/invoke.test.ts`、`apps/core/src/connectors/cli.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `getTool` / `usableOps`；`connectors/mcp.ts` 的 `callTool(server, tool, args)`；`memory/tasks.ts` 的 `addPending`、`getTask`；`memory/audit.ts` 的 `record`。
- Produces（`connectors/builtin.ts`）:
  ```ts
  /** evidence 会合进这次调用的账（如 slack 发送的 ts / permalink） */
  export interface OpResult { text: string; value?: unknown; undo?: Undo; evidence?: Record<string, unknown> }
  export interface BuiltinOp {
    name: string; description: string; input: z.ZodRawShape; level: ToolLevel;
    /** 记账用的 action 名；不给就是 `${tool}_${op}` */
    audit?: string;
    run(args: Record<string, unknown>): Promise<OpResult>;
  }
  export interface BuiltinTool { name: string; scenario: string; roles: string[]; binaries: string[]; ops: BuiltinOp[]; health?(): Promise<void> }
  export function defineBuiltin(t: BuiltinTool): void
  export function builtin(name: string): BuiltinTool | undefined
  export function builtins(): BuiltinTool[]
  /** 启动时调：每个 builtin upsert 成登记（levelBy "builtin"、draft false），保留已有的 enabled / projects */
  export function seedBuiltins(): void
  ```
- Produces（`connectors/invoke.ts`）:
  ```ts
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
  export async function invokeTool(caller: Caller, tool: string, op: string, args: Record<string, unknown>): Promise<InvokeResult>
  ```
- Produces（`connectors/cli.ts`）: `fillTemplate(template: string[], args: Record<string, unknown>): string[]`、`runCli(binary: string, argv: string[], timeoutMs?: number): Promise<string>`（`execFile`，不经 shell；输出能 `JSON.parse` 就给 `value`）。

**规则（invokeTool 按序判）：**
1. 工具不存在 / `enabled: false` / `draft: true` → `refused`「工具 X 没登记或没启用」。
2. 操作不在登记里 → `refused`「X 里没有操作 Y」；`level === null` → `refused`「Y 还没定级，先让用户定」。
3. `caller.kind === "model"` 且有 `taskId`、工具 `projects` 非空、任务的 `project` 不在其中 → `refused`。
4. 按等级：
   - `friday`：`irreversible` 且没有 `approvedPendingId` → **throw** `Error("不可逆操作 X.Y 必须带已批准的待审动作")`。
   - `user`、`schedule`：各级直接执行。
   - `model`：`irreversible` 有 `taskId` → `addPending(taskId, { type: "tool_call", label: \`执行 ${tool}.${op}\`, detail: 参数 JSON 截 500 字, payload: { tool, op, args, conversationId, jobId } })` 返回 `held`；无 `taskId` → 返回 `needs_consent`，`summary` 写「要执行 X.Y（参数…），撤不回」。
5. 执行：`builtin` 调 `run`；`mcp_http` 调 `callTool(connection, op, args)`；`cli` 调 `runCli(connection, fillTemplate(op.template, args))`；`mcp_stdio` 调 Task 3 的 `callStdio`（本任务先抛「stdio 还没接」，Task 3 补）。
6. `reversible` 的外部操作：有 `undo.before` 先按同样规则以 `read` 执行快照；执行后用 `$args / $result / $before` 解析出撤销参数，记 `undo: { kind: "tool_undo", tool, op: undo.op, args }`。builtin 的撤销用 `run` 返回的 `undo`。
7. 记账：`reversible` / `irreversible` 一律 `record`（`action` 用 `op.audit` 或 `${tool}_${op}`，`risk` = 等级，`evidence: { tool, op, args, caller: caller.kind, quote, ...result.evidence }`，`taskId` 取 caller 的）；`model` 调 `read` 也记一条 `risk: "read"`；`friday` 调 `read` 不记。

- [ ] **Step 1: 写失败测试** `invoke.test.ts`（用 `defineBuiltin` 注册一个假工具 `fake`：`get`(read)、`flip`(reversible，`run` 返回 `undo: { kind: "none" }` 以外的值)、`send`(irreversible)，再 `seedBuiltins()`）：
  - `未登记的工具 refused`：`invokeTool(model, "nope", "get", {})` → `kind: "refused"`。
  - `未定级的操作 refused`：`saveTool` 改 `get` 的 level 为 `null` 后调用 → `refused` 且 `why` 含「还没定级」。
  - `工具里已经没有的操作 refused`（Review Focus 1）：调 `fake.gone` → `refused` 且 `why` 含「没有操作 gone」，不抛。
  - `friday 调不可逆没带批准就抛`：`await expect(invokeTool({ kind: "friday", why: "x" }, "fake", "send", {})).rejects.toThrow("必须带已批准的待审动作")`。
  - `friday 带批准能执行`：`approvedPendingId: "p1"` → `kind: "ok"`，`listAudit()` 最新一条 `risk === "irreversible"`。
  - `model 有任务挂待审`：建一条任务，调 `send` → `held`，`getTask(id).pending` 有一条 `type === "tool_call"` 且 `payload.op === "send"`；`fake.send` 的 `run` 没被调用（用计数器断言为 0）。
  - `model 无任务要两步同意`：→ `needs_consent`。
  - `model 读也记账、friday 读不记账`：两次调用后 `listAudit()` 只多一条，`evidence.caller === "model"`。
  - `外部 reversible 撤销参数从 before 和 result 取`：登记一个 `cli` 工具，`set` 操作 `undo: { op: "set", before: { op: "get", args: { id: "$args.id" } }, args: { id: "$args.id", value: "$before.value" } }`，用 `vi.mock("./cli.js")` 让 `runCli` 先返回 `{"value":"old"}` 再返回 `{}`；调用后 `undoPlan(最新账 id)` 等于 `{ kind: "tool_undo", tool, op: "set", args: { id: "1", value: "old" } }`。
- [ ] **Step 2: 写失败测试** `cli.test.ts`：`fillTemplate(["workitem","get","--id","{id}"], { id: 7 })` → `["workitem","get","--id","7"]`；模板里引用了没给的参数 → 抛「缺参数 id」。
- [ ] **Step 3: 跑测试确认失败。**
- [ ] **Step 4: 实现** `builtin.ts`、`cli.ts`、`invoke.ts`；`audit.ts` 加 `tool_undo`；`pipeline.ts` 的 `executePending` 加分支：`action.type === "tool_call"` → `invokeTool({ kind: "friday", why: "你审核通过", taskId, approvedPendingId: action.id }, p.tool, p.op, p.args)`，结果不是 `ok` 就抛；`api/tasks.ts` 撤销分支 `plan.kind === "tool_undo"` → `invokeTool({ kind: "user", why: "你点了撤销" }, plan.tool, plan.op, plan.args)`，不是 `ok` 回 409 带原因。
- [ ] **Step 5: 跑测试确认通过**；`pnpm -r typecheck`。
- [ ] **Step 6: 提交** `注册处：统一入口 invokeTool、待审 tool_call 与通用撤销`

### Task 3: MCP 客户端补齐（列操作 + stdio）

**Files:**
- Modify: `apps/core/src/connectors/mcp.ts`
- Create: `apps/core/src/connectors/mcpStdio.ts`
- Create: `apps/core/src/connectors/__fixtures__/echoServer.mjs`（测试用 stdio MCP server）
- Modify: `apps/core/src/connectors/invoke.ts`（`mcp_stdio` 分支接上）
- Test: `apps/core/src/connectors/mcp.test.ts`（已有，补用例）、`apps/core/src/connectors/mcpStdio.test.ts`

**Interfaces:**
- Produces:
  - `mcp.ts`：`listTools(server: string, opts?: { file?: string; timeoutMs?: number }): Promise<Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>>`（http，同 `callTool` 的握手）；`mcpServers()` 返回值改为 `Array<{ name: string; http: boolean; command?: string; args?: string[] }>`。
  - `mcpStdio.ts`：`listStdioTools(server: string, file?: string)`（同上返回形状）、`callStdio(server: string, tool: string, args: Record<string, unknown>, file?: string): Promise<{ text: string; isError: boolean }>`。用 `@modelcontextprotocol/sdk` 的 `Client` + `StdioClientTransport`，**每次调用起一个进程、用完关掉**（第一步不做复用）；命令和参数从 `~/.claude.json` 的 `mcpServers[server].command / args / env` 读；15 秒超时。

- [ ] **Step 1: 写失败测试** `mcp.test.ts`：沿用现有的假 http 端点写法，`listTools("okr")` 返回 `tools/list` 结果的 name / description / inputSchema。`mcpStdio.test.ts`：临时 `FRIDAY_CLAUDE_JSON` 指向一个 `{ mcpServers: { echo: { command: process.execPath, args: [fixture] } } }`，`listStdioTools("echo")` 含 `echo`，`callStdio("echo", "echo", { text: "hi" })` 的 `text === "hi"`。
- [ ] **Step 2: 跑测试确认失败。**
- [ ] **Step 3: 实现**；fixture 用 SDK 的 `McpServer` + `StdioServerTransport` 注册一个 `echo` 工具。`invoke.ts` 的 `mcp_stdio` 分支调 `callStdio(reg.connection, op, args)`。
- [ ] **Step 4: 跑测试确认通过。**
- [ ] **Step 5: 提交** `注册处：MCP 列操作与 stdio 客户端`

### Task 4: 角色接口、读网页与 Lark 改成 builtin

**Files:**
- Create: `apps/core/src/connectors/roles.ts`
- Create: `apps/core/src/connectors/web/index.ts`（内容搬自 `agent/web.ts` + `agent/chromeCookies.ts`，原文件删）
- Create: `apps/core/src/connectors/lark/index.ts`（内容搬自 `connectors/lark.ts` + `agent/docTitle.ts` 里调 `lark-cli` 的 `docTitle` 分支与 `larkTitle`，原 `connectors/lark.ts` 删）
- Modify: `apps/core/src/settings.ts`（`roles` 默认值）、`apps/core/src/index.ts`（启动时 `seedBuiltins()`，import 各 builtin 模块让 `defineBuiltin` 生效）
- Modify 调用方：`agent/tools.ts`（`web_read`）、`agent/bridge.ts`（`friday_web_read`）、`agent/summon/index.ts`（`fetchLarkDoc` / `docExcerpt`）、`agent/docTitle.ts`（只保留 URL 归一化、资料合并、网页标题；Lark 标题改经角色）
- Move tests: `agent/web.test.ts`、`agent/chromeCookies.test.ts`、`connectors/lark.test.ts` 跟着搬到新目录，import 路径更新
- Test: `apps/core/src/connectors/roles.test.ts`

**Interfaces:**
- Produces（`connectors/roles.ts`）:
  ```ts
  export type RoleName = "workItems" | "chat" | "docs" | "web";
  export interface DocsRole { owns(url: string): boolean; read(url: string, opts?: { timeoutMs?: number }): Promise<LarkDoc | undefined>; excerpt(doc: LarkDoc, selection?: string, max?: number): string; title(url: string): Promise<string | undefined> }
  export interface WebRole { readChunk(url: string, offset?: number): Promise<Chunk> }
  export function implementRole<R extends RoleName>(name: R, tool: string, impl: RoleImpl[R]): void
  export function role<R extends RoleName>(name: R): RoleImpl[R]   // 按 userSettings().roles[name] 取；没实现或工具没启用就抛「角色 X 没有可用的工具」
  ```
  `RoleImpl` 是 `{ workItems: WorkItemsRole; chat: ChatRole; docs: DocsRole; web: WebRole }`；`WorkItemsRole` / `ChatRole` 由 Task 5 / Task 6 加进同一文件。`LarkDoc`、`Chunk` 类型随模块搬家，名字不变。
- Produces（`settings.ts`）：`UserSettings.roles: Record<RoleName, string>`，默认 `{ workItems: "meegle", chat: "slack", docs: "lark", web: "web" }`。
- builtin `web`：`binaries: ["agent-browser"]`，`roles: ["web"]`，ops：`read`（`{ url, offset? }`，`read` 级，返回和现在 `web_read` 一样的分段文本，含 `untrusted()` 围栏与「接着读」提示）。场景描述：「读用户发来的网页、PRD 之外的网页资料；登录态取自用户 Chrome」。
- builtin `lark`：`binaries: ["lark-cli"]`，`roles: ["docs"]`，ops：`read`（`{ url }`，`read` 级，返回正文节选，过 `untrusted()`）。场景描述：「读飞书 / Lark 云文档正文（PRD、技术方案）」。
- `web_read` 和 `friday_web_read` **保留名字**，handler 改为 `invokeTool({ kind: "model", … }, "web", "read", { url, offset })` 的薄封装（提示词与已有会话不用改）。

- [ ] **Step 1: 写失败测试** `roles.test.ts`：
  - `role 按设置取实现`：`implementRole("docs", "lark", fake)` 后 `role("docs") === fake`。
  - `工具停用后 role 抛错`：`saveTool({ ...lark, enabled: false })` 后 `expect(() => role("docs")).toThrow("没有可用的工具")`。
  - `seedBuiltins 保留用户改过的 enabled`：先 seed，再把 `web` 存成 `enabled: false`，再 seed → 仍是 `false`。
- [ ] **Step 2: 跑测试确认失败。**
- [ ] **Step 3: 搬代码并实现**；搬过来的测试保持原断言不变，只改 import。
- [ ] **Step 4: 跑全量测试** `pnpm -r test`，`pnpm -r typecheck` 通过。
- [ ] **Step 5: 提交** `注册处：角色接口，读网页与 Lark 文档改成内置工具`

### Task 5: Meegle 改成 builtin（规则收进工具）

**Files:**
- Create: `apps/core/src/connectors/meegle/index.ts`（`defineBuiltin` + `implementRole("workItems", …)`）
- Move: `connectors/meegle.ts` → `connectors/meegle/client.ts`（`MeegleConnector` 类、`toWorkItem` 等原样）；`connectors/meegle.test.ts` / `meegle-fetch.test.ts` 跟着搬
- Create: `apps/core/src/connectors/meegle/rules.ts`：从 `agent/meegle.ts` 搬 `DONE_KEYS` / `DONE_NAMES` / `TESTING_NAMES` / `parseMeegleRef`；从 `agent/summon/match.ts` 搬 `meegleIdFromUrl`；从 `memory/infer.ts` 搬 `meegleIdsIn`；从 `connectors/meegle.ts` 的 `SELF_HOSTS`
- Modify: `apps/core/src/connectors/roles.ts`（加 `WorkItemsRole`）
- Modify 调用方：`agent/meegle.ts`、`agent/bridge.ts`、`agent/tools.ts`、`api/tasks.ts`、`api/summon.ts`、`agent/summon/match.ts`、`memory/infer.ts`、`memory/projectHints.ts`、`connectors/urlSource.ts`、`scheduler/index.ts`
- Test: `apps/core/src/agent/meegle.test.ts`（已有，改注入方式）、`apps/core/src/connectors/meegle/rules.test.ts`

**Interfaces:**
- Produces（`connectors/roles.ts`）:
  ```ts
  export interface WorkItemRef { space: string; id: string }
  export type WorkItemState = "open" | "in_progress" | "testing" | "done" | "reopened";
  export type WorkItemKind = "story" | "defect" | "other";
  /** 同步链路的一条工单：原 MeegleWorkItem 的全部字段 + 归一化的 kind / state */
  export type WorkItem = MeegleWorkItem & { kind: WorkItemKind; state: WorkItemState };
  export interface WorkItemsRole {
    listMine(): Promise<WorkItem[]>;
    fetchOne(ref: WorkItemRef): Promise<WorkItem>;
    get(ref: WorkItemRef): Promise<{ name: string; typeKey?: string; stateKey: string; stateLabel: string; state: WorkItemState } | undefined>;
    released(ref: WorkItemRef): Promise<boolean>;
    transitions(ref: WorkItemRef): Promise<StateTransition[]>;
    /** 按意图找流转：in_progress = 「开始处理」那条；没有就 undefined */
    transitionFor(ref: WorkItemRef, intent: "in_progress"): Promise<StateTransition | undefined>;
    transition(ref: WorkItemRef, to: StateTransition, caller: Caller): Promise<void>;
    nodeReadiness(ref: WorkItemRef, nodeKey: string): Promise<{ missing: string[] }>;
    confirmNode(ref: WorkItemRef, nodeKey: string, caller: Caller): Promise<void>;
    rollbackNode(ref: WorkItemRef, nodeKey: string, caller: Caller): Promise<void>;
    undoTransition(ref: WorkItemRef, backTo: string, caller: Caller): Promise<boolean>;
    parseRef(input: string): WorkItemRef | undefined;
    idFromUrl(url: string): string | undefined;
    idsIn(text: string): string[];
    stateOf(stateKey: string, stateLabel?: string): WorkItemState;
    kindOf(typeKey?: string): WorkItemKind;
    ownsHost(host: string): boolean;
  }
  ```
- builtin `meegle`：`binaries: ["meegle"]`、`roles: ["workItems"]`；ops（模型可用）：`get`（`{ space, id }`，read，返回标题 / 状态 / 类型 / 关联需求 / 描述节选，过 `untrusted()`）、`transition`（`{ space, id, transitionId }`，`reversible`，`audit: "meegle_transition"`，`run` 先读当前状态、执行后返回 `undo: { kind: "meegle_state", projectKey, workItemId, backTo }`）、`confirm_node`（`reversible`，`audit: "meegle_node_confirm"`，`undo: { kind: "meegle_node", … }`）。角色上的 `transition` / `confirmNode` / `rollbackNode` / `undoTransition` 一律经 `invokeTool(caller, "meegle", …)`，账只记这一条（删掉 `agent/meegle.ts` 里重复的 `record`，`why` 由 caller 带进来，原文案不变）。
- 规则对应：`state` = `done`（原 `isDoneStatus`）/ `testing`（原 `TESTING_NAMES`）/ `reopened`（状态名含 reopen）/ `in_progress`（key 为 `IN PROGRESS`）/ 其余 `open`；`kindOf`：`story` → story，`issue` / `defect` / `bug` → defect，其余 other。`transitionFor(ref, "in_progress")` = 找 `stateKey === "IN PROGRESS"` 的那条。

**`agent/meegle.ts` 的改法（行为不变）：**
- 所有 `connector = new MeegleConnector()` 默认参数改成 `items: WorkItemsRole = role("workItems")`，内部调用对应换名。
- `isDoneStatus(now.statusKey, now.status)` → `now.state === "done"`；`t.source.meegleType === "issue" && TESTING_NAMES.test(...)` → `items.kindOf(t.source.meegleType) === "defect" && now.state === "testing"`；`isDefect(x)` → `items.kindOf(x) === "defect"`；`ensureStoryContainers` 建容器时 `meegleType` 写 `story.typeKey ?? "story"`（值由工具给）。
- `applyTransition` 里 `to.stateKey === DONE_STATE` → `items.stateOf(to.stateKey, to.label) === "done"`（**行为差异**：转到 CLOSED / DONE 也立即收工，原来只认 RESOLVED；下一轮同步本来就会收，属提前一步，接受）。
- `transitionToInProgress` 用 `transitionFor`；caller 是 `{ kind: "friday", why: "Friday 在需求分支上修完并发到测试环境", taskId }`（流转是 `reversible`，Friday 代码调它不需要批准 id）。
- `api/tasks.ts` 的 `POST /tasks/:id/transition`、`/node/confirm` 用 `{ kind: "user", why: \`你在 Friday 里点了「${label}」\`, taskId }`；撤销分支 `meegle_state` / `meegle_node` 用 `{ kind: "user", why: "你点了撤销" }`。

- [ ] **Step 1: 写失败测试** `rules.test.ts`：`stateOf("TPivPPL9-", "WON'T FIX") === "done"`；`stateOf("systemEnded") === "done"`；`stateOf("x", "In Testing") === "testing"`；`stateOf("REOPENED", "Reopened") === "reopened"`；`kindOf("issue") === "defect"`；`parseRef("https://project.larksuite.com/projectlb/story/detail/24487610")` 等于 `{ space: "projectlb", id: "24487610" }`；`ownsHost("project.feishu.cn") === true`。
- [ ] **Step 2: 改 `agent/meegle.test.ts`**：原来传 `MeegleConnector` 假对象的地方改传 `WorkItemsRole` 假对象（字段加 `kind` / `state`），断言**一条不改**——这正是「同步行为不退化」的守门测试。另加一条：`applyTransition 转到 CLOSED 也收工`。
- [ ] **Step 3: 跑测试确认失败。**
- [ ] **Step 4: 实现并改全部调用方。**
- [ ] **Step 5: 跑全量测试和类型检查通过。**
- [ ] **Step 6: grep 自查** `cd apps/core/src && grep -rnE "isDoneStatus|TESTING_NAMES|DONE_STATE|\"IN PROGRESS\"|_field_linked_story|SELF_HOSTS|new MeegleConnector|meegleIdFromUrl|meegleIdsIn" --include='*.ts' . | grep -v '^./connectors/meegle/' | grep -v '\.test\.ts'` → 无输出。
- [ ] **Step 7: 提交** `注册处：Meegle 改成内置工具，状态与类型规则收进工具`

### Task 6: Slack 改成 builtin

**Files:**
- Create: `apps/core/src/connectors/slack/index.ts`（`defineBuiltin` + `implementRole("chat", …)`）
- Move: `connectors/slack.ts` → `connectors/slack/client.ts`；`connectors/noise.ts` → `connectors/slack/noise.ts`；`connectors/keychain.ts` → `connectors/slack/keychain.ts`；`memory/roster.ts` → `connectors/slack/roster.ts`；`agent/summon/match.ts` 的 `parseSlackTitle`（连同 `CHANNEL_TAG` / `SLACK_SUFFIX` / `VIEWS`）→ `connectors/slack/title.ts`；`agent/summon/slack.ts` 里拉实时原文的 `liveConversation`、`renderMentions`、`mentionsMe`、`bareName`、`prettyName` → `connectors/slack/live.ts`。对应测试跟着搬。
- Modify: `apps/core/src/connectors/roles.ts`（加 `ChatRole`）
- Modify 调用方：`scheduler/index.ts`（`syncSlackOnce`）、`agent/pipeline.ts`（`slackPost`）、`api/tasks.ts`（撤回、`slackConfigured`、`priorText`）、`agent/summon/slack.ts`（只留和收件箱 / 任务挂靠相关的部分）、`agent/summon/index.ts`（`SLACK_BUNDLE`）、`index.ts`（`warmSlack`）
- Test: `apps/core/src/connectors/slack/role.test.ts`

**Interfaces:**
- Produces（`connectors/roles.ts`）:
  ```ts
  export interface ChatLine { ts: string; threadTs?: string; userId?: string; userName: string; text: string }
  export interface ChatRole {
    configured(): Promise<boolean>;
    /** auth.test；拿不到凭证返回 undefined */
    self(): Promise<{ id: string; teamId?: string; url?: string } | undefined>;
    pull(me: string, cursors: Record<string, string | undefined>, now: number, teamUrl?: string): Promise<{ items: InboxItem[]; cursors: Record<string, string> }>;
    context(item: InboxItem): Promise<ChatLine[]>;
    /** 每轮同步取一次已读游标，返回判定函数：已读或我已回 */
    settledChecker(me: string): Promise<(item: InboxItem) => Promise<boolean>>;
    post(args: { channel: string; text: string; threadTs?: string }, caller: Caller): Promise<{ ts: string; permalink?: string }>;
    remove(args: { channel: string; ts: string }, caller: Caller): Promise<void>;
    live(channel?: string, person?: string): Promise<{ channelId?: string; lines: ChatLine[]; me?: string }>;
    parseTitle(title: string): { channel?: string; person?: string };
    ownsApp(bundleId: string): boolean;
    renderPrior(lines: PriorLine[], scene: { kind: InboxKind; peer?: string; peerId?: string }): string[];
    displayNames(): Map<string, string>;
    warm(): Promise<void>;
    /** 凭证失效（invalid_auth 等）时丢掉缓存，下一轮重读钥匙串 */
    resetAuth(): void;
  }
  ```
- builtin `slack`：`binaries: []`、`roles: ["chat"]`；ops：`context`（`{ conversation }`，read，返回这段对话的前文，过 `untrusted()`）、`post`（`irreversible`，`audit: "slack_reply_sent"`，`run` 返回 `undo: { kind: "delete_slack_message", channel, ts }`）、`delete`（`irreversible`）。
- `executePending` 的 `slack_reply` 分支改成 `role("chat").post(p, { kind: "friday", why: "你审核通过", taskId, approvedPendingId: action.id })`；`deps.slackPost` 参数删掉（调用方一并改）；原分支里的 `record` 删掉（由 `invokeTool` 记，`action` 名仍是 `slack_reply_sent`；`post` 的 `run` 返回 `evidence: { channel, text, ts, permalink }`，账里字段和原来一致）。
- `api/tasks.ts` 撤销分支 `delete_slack_message` → `role("chat").remove(plan, { kind: "user", why: "你点了撤销" })`。

- [ ] **Step 1: 写失败测试** `role.test.ts`：
  - `parseTitle` 四种形态（CLAUDE.md「HUD 认当前会话」一节的原样例）：`"一起养牛（频道） - Longbridge - 1 个新项目 - Slack"` → `{ channel: "一起养牛" }`；`"活动 - Longbridge - Slack"` → `{}`；带英文后缀的人名照旧解析（沿用搬过来的 `match.test.ts` 用例）。
  - `post 没批准就抛`：`await expect(role("chat").post({ channel: "C1", text: "x" }, { kind: "friday", why: "x" })).rejects.toThrow("必须带已批准的待审动作")`。
  - `ownsApp("com.tinyspeck.slackmacgap") === true`。
- [ ] **Step 2: 跑测试确认失败。**
- [ ] **Step 3: 搬代码、实现角色、改调用方。** `syncSlackOnce` 的流程与日志文案不变，只把 `call(...)` / `fetchSlack` 等换成角色方法；`creds = undefined` 换成 `chat.resetAuth()`。
- [ ] **Step 4: 全量测试与类型检查通过**（`scheduler`、`agent/slack/*`、`api/tasks` 相关测试断言不改）。
- [ ] **Step 5: grep 自查** `grep -rnE "slack\.com/api|chat\.postMessage|conversations\.(replies|history)|search\.messages|auth\.test|keychainGet|friday-slack|com\.tinyspeck|blocksText|classifyNoise|parseSlackTitle" --include='*.ts' apps/core/src | grep -v 'connectors/slack/' | grep -v '\.test\.ts'` → 无输出（`pipeline.ts` 里原来的 `how: "chat.postMessage"` 随那条 `record` 一起删掉，改由 slack 工具的 `post` 记账）。
- [ ] **Step 6: 提交** `注册处：Slack 改成内置工具，收件、发送与窗口标题解析收进工具`

### Task 7: OKR 登记为 MCP 工具，定时任务的 call 走注册处

**Files:**
- Delete: `apps/core/src/connectors/okr.ts`（解析逻辑挪进 `agent/weekly/okr.ts`，它不是连接器而是周报流程对 okr 工具的用法）
- Create: `apps/core/src/agent/weekly/okr.ts`：`me()`、`myKRs()`、`quarterReports()`、`submit(r, caller)`、`remove(id, caller)` 同名同返回值，内部 `invokeTool(caller, "okr", <原 MCP 工具名>, args)`；读操作用 `{ kind: "friday", why: "起草周报" }`
- Modify: `apps/core/src/index.ts`（启动时若 `~/.claude.json` 有 `okr` server 且注册处没有 `okr`，自动登记：`transport: "mcp_http"`、`connection: "okr"`、ops 只登记周报用到的几个，读的 `read`，`create_progress_report` / `delete_progress_report` 为 `irreversible`，`levelBy: "builtin"`，场景「OKR 周报起草与提交」）
- Modify: `agent/weekly/index.ts`、`draft.ts`、`submit.ts`、`api/tasks.ts`（撤销 `delete_okr_reports` 用 `{ kind: "user" }`）、`agent/pipeline.ts`（`okr_submit` 分支把 `action.id` 传进 `submitRows` → `submit(r, { kind: "friday", why: "你审核通过", taskId, approvedPendingId })`）
- Modify: `apps/core/src/agent/schedule.ts`（`fireCall` 非 `friday` 分支改 `invokeTool({ kind: "schedule", why: \`定时任务「${s.title}」\`, scheduleId: s.id }, s.server, s.tool, args)`；`validateSchedule` 的 call 校验改为「工具已登记、已启用、操作存在且已定级」）
- Create: `pauseUnregisteredCalls(): number`（`memory/schedules.ts`，启动时调：`executor === "call"`、`server !== "friday"`、注册处没有该工具的，`enabled = false`，往主对话追加一条 notice「定时任务「X」调的 Y 还没登记成工具，先暂停了；说「接一下 Y」登记后再打开」）
- Test: `apps/core/src/agent/weekly/*.test.ts`（已有，改 mock 目标）、`apps/core/src/agent/schedule.test.ts`（补用例）

**Interfaces:**
- Consumes: Task 2 `invokeTool`、`Caller`；Task 3 `listTools`（自动登记时取 inputSchema）。
- Produces: `submitRows(taskId, draft, approvedPendingId: string)`（多一个参数）；`pauseUnregisteredCalls()`。

- [ ] **Step 1: 写失败测试** `schedule.test.ts`：
  - `call 指向未登记工具被暂停`：建一条 `executor: "call", server: "coral"` 的定时任务，`pauseUnregisteredCalls()` 返回 1 且该任务 `enabled === false`；`server: "friday"` 的不动。
  - `validateSchedule 拒未定级操作`：登记 `coral` 但 `deployApi` 的 `level: null` → 校验返回错误含「还没定级」。
  - `fireCall 走 invokeTool`：`vi.mock` `invokeTool`，`fireSchedule` 后断言调用参数 `caller.kind === "schedule"`。
- [ ] **Step 2: 改周报测试的 mock**：原来 mock `connectors/okr.js` 的改为 mock `agent/weekly/okr.js` 或 `connectors/invoke.js`，断言不改。
- [ ] **Step 3: 跑测试确认失败 → 实现 → 通过**；类型检查。
- [ ] **Step 4: 提交** `注册处：OKR 登记为 MCP 工具，定时任务直接调工具改走注册处`

### Task 8: 模型会话按需加载：目录、`tool_describe` / `tool_call`、预选、两步同意

**Files:**
- Create: `apps/core/src/agent/toolCatalog.ts`
- Modify: `apps/core/src/agent/tools.ts`（加 `tool_describe` / `tool_call` 两个会话工具）、`apps/core/src/agent/bridge.ts`（`bridgeToolsFor` / `callBridge` 加同名两个工具）、`apps/core/src/agent/prompt.ts`（`friday()` 加【外部工具】块、`terminalBridgePrompt` 加目录）、`apps/core/src/agent/runner.ts`（`autonomousPrompt` 加预选块）、`apps/core/src/agent/briefJob.ts`（`briefPrompt` 第 1 条改写 + 预选块）
- Test: `apps/core/src/agent/toolCatalog.test.ts`、`apps/core/src/agent/bridge.test.ts`（补用例）

**Interfaces:**
- Produces（`toolCatalog.ts`）:
  - `catalogLines(project?: string): string[]`：每个启用、非 draft、至少一个已定级操作的工具一行 `名字 · 场景描述`；给了 `project` 时只列 `projects` 为空或含它的；没有工具返回空数组（调用方据此不出整块）。
  - `describeTool(name: string, project?: string): string`：已定级操作逐个列 `操作名（等级）：说明` + 参数 JSON schema；工具不可用返回「X 不可用：原因」。
  - `preselect(project: string): string`：`projects` 显式含该项目的工具，拼它们的 `describeTool`，总长截 3000 字；没有返回空串。
- 会话工具 `tool_describe({ tool })`、`tool_call({ tool, op, args })`（`args` 是 `z.record(z.string(), z.unknown())`）：
  - 主对话：`caller = { kind: "model", why: "主对话里调用", conversationId, taskId: 用户本轮原话句首 #N 解析出的任务 id（同 task_approve 的解析），quote: saidLast(conversationId) }`。
  - 结果映射：`ok` → 文本；`held` → 「已挂待审 #N：执行 X.Y，等用户点头」；`refused` → 原因；`needs_consent` → 走两步同意（下条）；`invokeTool` 抛出的错误（连不上、外部报错）→ 「没调成：<错误信息>」，不往上抛。
  - **两步同意**（主对话、无任务、`irreversible`）：照 `selfTools.ts` 的 `worktree_remove` 写法，内存 `Map<conversationId, { tool, op, argsJson, after: 用户消息 id }>`；第一次返回 `summary` + 「确认请用户单独回一句「执行」」；再调时同时满足：同一 `tool` / `op` / 参数 JSON 完全相同、最后一条用户消息 id 不等于记下的那条、`consents(said, ["执行", "执行吧", "确认执行"])`，才以 `{ kind: "user", why: "你在对话里同意执行", quote: said }` 调 `invokeTool`。定时会话一律回「定时任务里不能执行不可逆操作，等用户回来。」
  - bridge：`caller = { kind: "model", why: "终端里的 Claude 调用", jobId, taskId: job 的 owner 任务 id }`，无 owner 时与主对话无任务同理但**没有对话可同意**，直接回 `refused`「终端里没有任务可挂待审，不执行」。
- 提示词：
  - `friday()` 末尾（有目录时）：`【外部工具】` + `catalogLines()` + 一句「要用时先 tool_describe 看操作和参数，再 tool_call；不可逆的会挂待审或要用户说「执行」」。
  - `terminalBridgePrompt(project, fridayDriven)`：同样一块，`catalogLines(project)`。
  - `autonomousPrompt` 与 `briefPrompt`：`preselect(project)` 非空时追加「【这个项目常用的外部工具】」+ 内容。
  - `briefPrompt` 第 1 条改为：「1. 读需求：PRD 是飞书文档用 tool_call lark read，其他网页用 friday_web_read（长文按返回的 offset 接着读）。读不到的写进 plan 里「要你拍板」那段，不要猜。」

- [ ] **Step 1: 写失败测试** `toolCatalog.test.ts`：
  - `catalogLines 按项目过滤`：工具 A `projects: ["p1"]`、B `projects: []` → `catalogLines("p2")` 只含 B；`catalogLines()` 含两者。
  - `draft 与全未定级的工具不进目录`。
  - `preselect 只取显式登记该项目的`：B 不在 `preselect("p1")` 里，A 在。
- [ ] **Step 2: 写失败测试**（`tools` 层，直接调 handler）：
  - `两步同意：同一轮连调两次不执行`（Review Focus 4）：不新增用户消息、调两次 `tool_call` 不可逆操作，假工具 `run` 计数为 0，两次都返回确认说明。
  - `两步同意：参数变了要重问`：第一次 `args {a:1}`，用户新消息「执行」，第二次 `args {a:2}` → 不执行，返回新的确认说明。
  - `两步同意：新的一句「执行」后执行`：计数为 1，最新账 `evidence.caller === "user"`、`evidence.quote === "执行"`。
  - bridge：`tool_call` 不可逆、job 有 owner → 任务 `pending` 多一条 `tool_call`。
- [ ] **Step 3: 跑测试确认失败 → 实现 → 通过**；`pnpm -r test`、类型检查。
- [ ] **Step 4: 提交** `注册处：模型会话按需加载工具，目录、预选与两步同意`

### Task 9: 对话里接入工具（发现、登记、定稿、改、删）

**Files:**
- Create: `apps/core/src/agent/toolAdmin.ts`（导出 `toolAdminList(conversationId?: string)`，**不许 import `agent/tools.ts`**）
- Modify: `apps/core/src/agent/tools.ts`（`fridayTools` 里 `...toolAdminList(conversationId)`）、`apps/core/src/api/tasks.ts`（撤销分支 `restore_tool`）、`apps/core/src/memory/audit.ts`（`Undo` 加 `{ kind: "restore_tool"; name: string; before: ToolRegistration | null }`）、`apps/core/src/agent/prompt.ts`（系统提示一句：用户说「接一下 X」就按 tool_discover → tool_register → 转告清单 → 等确认 → tool_update confirm 的顺序做）
- Create: `apps/core/src/agent/toolAdmin.import.test.ts`（首行 import `toolAdmin`，守循环导入）
- Test: `apps/core/src/agent/toolAdmin.test.ts`

**Interfaces:**
- 会话工具（都在 `toolAdminList` 里；写类在定时会话一律回「定时任务里不能改 Friday 的配置，等用户回来。」）：
  - `tool_discover({ name })` 只读：依次查 `mcpServers()` 名字等于或包含 `name` 的（http 用 `listTools`，stdio 用 `listStdioTools` 带回操作清单）、`which <name>` 与 `which <name>-cli`（带回 `--help` 前 4000 字）、`~/.claude/skills/<name>*` 与插件 skill 目录（只报告存在）；只有 skill 没有 MCP / CLI 的写「Friday 调不了，只能交给终端里的 Claude」。
  - `tool_register({ name, transport, connection, scenario, skill?, projects?, binaries?, ops })` 写**草稿**（`draft: true, enabled: false`）。`ops[].level` 由模型提议，服务端再兜底：名字匹配 `^(get|list|index|describe|search|query|read|export|preview|has)` 的允许 `read`，其余提议了 `read` 的改为 `irreversible`；没给 `undo` 的 `reversible` 改 `irreversible`。`name` 和任何 builtin 同名、或已有非草稿登记 → 拒绝（Review Focus 3）。返回清单文本（每个操作一行：名字 · 等级 · 说明）让 Friday 转告。
  - `tool_update({ name, confirm?, refresh?, scenario?, projects?, enabled?, levels?: Record<op, ToolLevel> })`：改草稿或已登记；`refresh: true` 对 MCP 工具重新 `listTools` / `listStdioTools`：服务端已没有的操作从登记里删掉，新出现的以 `level: null` 加进来，已有的等级不动；`confirm: true` 用两步同意（同 Task 8 写法，同意词 `["确认", "登记吧", "就这样"]`）把 `draft` 置 false、`enabled` 置 true，被用户改过等级的 op `levelBy: "user"`。builtin 只允许改 `enabled` / `projects` / `scenario`。
  - `tool_remove({ name })`：builtin 不许删（回「内置工具只能停用」）；其余两步同意（同意词 `["删掉", "删掉吧"]`）。
  - `tools_list({})`：每个工具一行 `名字 · 连接方式 · 启用/草稿 · 各等级操作数 · 健康`。
  - 写类记账 `tool_registered` / `tool_updated` / `tool_removed`，`undo: { kind: "restore_tool", name, before }`（`before` 为 `null` 表示撤销 = 删除），`why` 用 `selfTools.ts` 的 `byYou` 同款写法，`evidence.quote = saidLast(conversationId)`。

- [ ] **Step 1: 写失败测试** `toolAdmin.test.ts`：
  - `register 写草稿且草稿不可调用`：之后 `invokeTool(model, name, op)` → `refused`。
  - `提议 read 但名字是写操作的改成 irreversible`：`deployApi` 提议 `read` → 存成 `irreversible`。
  - `与 builtin 重名拒绝`（Review Focus 3）：`tool_register({ name: "slack", … })` 返回含「已有」，`getTool("slack").transport === "builtin"` 不变。
  - `confirm 两步同意后启用`：同 Task 8 的三条断言模式，最终 `enabled === true && draft === false`。
  - `撤销 register 删掉登记`：执行 `restore_tool` 撤销后 `getTool(name) === undefined`。
  - `刷新后新操作默认不可用、消失的操作被移除`（Review Focus 1）：登记一个 mcp_http 工具（`listTools` mock 先返回 `a`、`b`），定稿；把 mock 改成返回 `b`、`c` 后调 `tool_update({ name, refresh: true })` → 登记里 `a` 没了、`b` 等级不变、`c` 的 `level === null`；随后 `invokeTool(model, name, "a", {})` → `refused` 含「没有操作 a」，`usableOps` 不含 `c`。
- [ ] **Step 2: 跑测试确认失败 → 实现 → 通过**；`toolAdmin.import.test.ts` 通过；类型检查。
- [ ] **Step 3: 提交** `注册处：对话里发现、登记、定稿与移除外部工具`

### Task 10: 堵漏洞：`--strict-mcp-config` 与守卫拦已登记的命令行

**Files:**
- Modify: `apps/core/src/agent/runner.ts`（`claudeArgs`：`fridayDriven` 时在 `--mcp-config` 后加 `--strict-mcp-config`；`buildGuardScript` 的 `rules` 拼上 `binaryRules(guardedBinaries())`）
- Modify: `apps/core/src/agent/guard.ts`（加 `binaryRules`，`forbidden()` 增加可选参数 `binaries: string[] = []`）
- Test: `apps/core/src/agent/guard.test.ts`、`apps/core/src/agent/runner.test.ts`（已有，补用例）

**Interfaces:**
- Produces: `binaryRules(binaries: string[]): Array<[pattern: string, why: string]>`，why =「X 已登记为 Friday 的外部工具，经 tool_call 调用，不要在 Bash 里直接跑」；`forbidden(command, patterns?, binaries?)`。
- 匹配规则：二进制出现在**命令位置**才拦——行首、`;` `&&` `||` `|` `(` `` ` `` `$(` 之后，可带路径前缀（`/opt/homebrew/bin/meegle`），或作为 `npx` / `pnpm dlx` / `bunx` 的第一个参数。作为普通参数或文件名出现不拦。

- [ ] **Step 1: 写失败测试** `guard.test.ts`（Review Focus 5）：`const b = ["meegle", "lark-cli"]`；
  - 拦：`forbidden("meegle mywork todo", [], b)`、`forbidden("/opt/homebrew/bin/meegle workitem get", [], b)`、`forbidden("cd x && meegle auth status", [], b)`、`forbidden("npx lark-cli docs +fetch --doc u", [], b)`、`forbidden("echo $(lark-cli docs +fetch)", [], b)` 均返回含「已登记为 Friday 的外部工具」。
  - 不拦：`forbidden("cat meegle.md", [], b)`、`forbidden("grep -rn lark-cli docs/", [], b)`、`forbidden("git commit -m 'fix meegle sync'", [], b)` 均为 `undefined`。
- [ ] **Step 2: 写失败测试** `runner.test.ts`：`claudeArgs(files, { kind: "autonomous" })` 含 `--strict-mcp-config`；`{ kind: "query", print: true }` 含；`{ kind: "interactive" }` 不含。
- [ ] **Step 3: 跑测试确认失败 → 实现 → 通过。**
- [ ] **Step 4: 提交** `注册处：Friday 驾驶的会话只加载 Friday 的 MCP，守卫拦已登记工具的命令行`

### Task 11: `/tools` 接口、健康检查、设置页「外部工具」

**Files:**
- Create: `apps/core/src/api/tools.ts`（`GET /tools`、`PATCH /tools/:name`），在 `api/index.ts` 汇总
- Create: `apps/core/src/connectors/health.ts`：`checkHealth(name: string): Promise<ToolHealth>`、`checkAllHealth(): Promise<void>`
- Modify: `apps/core/src/api/health.ts`（带 `tools: Array<{ name: string; ok: boolean; at: string; error?: string }>`）、`packages/shared` 的 `HealthResponse`
- Modify: `apps/core/src/index.ts`（启动后 `checkAllHealth()` 一次，不 await）
- Modify: `apps/desktop/src/lib/core.ts`（`listTools()`、`setToolEnabled(name, enabled)`）、`apps/desktop/src/views/Settings.tsx`（新 `<section><h2>外部工具</h2>`，放在「核心」之前）
- Test: `apps/core/src/api/tools.test.ts`、`apps/core/src/connectors/health.test.ts`

**Interfaces:**
- `GET /tools` → `{ tools: Array<ToolRegistration & { counts: Record<ToolLevel | "unset", number> }> }`；距上次健康检查超过 10 分钟的先重查再返回（并发查，单个 5 秒超时）。
- `PATCH /tools/:name { enabled: boolean }` → 记账 `tool_updated`（`undo: restore_tool`），返回新登记；不存在 404。
- 健康：builtin 有 `health()` 就调，没有算 ok；`mcp_http` 做一次 `initialize`；`mcp_stdio` 做一次 `listStdioTools`；`cli` 做 `which`。
- 设置页一节：每个工具一行「名字 · 连接方式 · 健康点（ok 绿 / 失败红，title 写错误）· `读 N / 可逆 N / 不可逆 N / 未定级 N` · 开关」，底部一行说明「增删和改等级在主对话里说，比如「接一下 coral 网关」」。样式沿用该文件现有 `<Row>` / 开关组件，不新增 CSS 变量。

- [ ] **Step 1: 写失败测试** `health.test.ts`（Review Focus 2）：临时 `FRIDAY_CLAUDE_JSON` 指向一个没有 `okr` 的文件，登记 `okr`（mcp_http）后 `checkHealth("okr")` → `ok: false`、`error` 含「没有 mcpServers.okr」；同时 `role("workItems")` 仍可取到（builtin 不受影响）；调主对话的 `tool_call` handler（`{ tool: "okr", op: "list_okr_objects", args: {} }`）返回文本含「没调成」和「没有 mcpServers.okr」，不抛出。
- [ ] **Step 2: 写失败测试** `tools.test.ts`：`PATCH /tools/web {enabled:false}` 后 `GET /tools` 里 `web.enabled === false`，`listAudit()` 最新一条 `action === "tool_updated"`。
- [ ] **Step 3: 跑测试确认失败 → 实现 → 通过**；类型检查。
- [ ] **Step 4: 浏览器验证**：按 CLAUDE.md「验收方式」起 core（`FRIDAY_PORT=7791 FRIDAY_DATA_DIR=<临时> FRIDAY_NO_SCHEDULER=1`）和 vite（`VITE_FRIDAY_PORT=7791`），agent-browser 带 `--profile <临时目录>` 打开设置页，截图「外部工具」一节：四个 builtin（meegle / slack / lark / web）都在、开关能切、切完刷新仍保持。截图存 scratchpad，交付时附上。
- [ ] **Step 5: 提交** `注册处：工具列表接口、健康检查与设置页「外部工具」`

### Task 12: 删死代码

**Files:**
- Delete: `apps/core/src/api/desk.ts`、`apps/core/src/agent/desk.ts`（及其测试）、`apps/core/src/connectors/index.ts`、`apps/core/src/connectors/types.ts`、`apps/core/src/memory/todos.ts`（及其测试）
- Modify: `apps/core/src/api/index.ts`（去掉 `desk` 路由与 `/todos` 所在路由的那两个 handler——先 `grep -rn '"/todos' apps/core/src/api` 找到文件）、`apps/core/src/agent/meegle.ts`（删 `syncSourceTodos` 调用与 `toTodoLike`）、`apps/core/src/memory/context.ts`（若仍读 `todos` 表则删）、`apps/desktop/src/lib/core.ts`（删 `syncTodos` / `openTodos`）、`packages/shared`（删只被这些用到的类型：`Desk`、`TodosSyncResponse`、`Connector` 相关，删前逐个 grep 确认无其他引用）
- 不动：`schema.ts` 里的 `todos` 表定义（老库里的数据留着）

- [ ] **Step 1:** `grep -rnE "buildDesk|/desk|syncTodos|openTodos|syncSourceTodos|fetchTodos|connectors/index|memory/todos" apps packages --include='*.ts' --include='*.tsx'` 记下所有命中，逐个删除或改掉。
- [ ] **Step 2:** `pnpm -r typecheck`、`pnpm -r test` 通过；再跑 Step 1 的 grep → 无输出。
- [ ] **Step 3: 提交** `清掉死代码：首屏 /desk 与 todos 那一套`

### Task 13: 验收、CLAUDE.md、真机验证

**Files:**
- Modify: `CLAUDE.md`（「架构（已定，不要更改）」：「核心」一条里的连接器描述改成「外部系统一律是注册进来的工具（`connectors/registry.ts`），Friday 业务代码按角色或 `invokeTool` 调用」；「目录约定」里 `connectors/` 改为「外部工具：注册处、统一入口、builtin 工具各一个子目录」；新增一节「外部工具注册处（2026-10-23）」概括：登记内容、四类调用方与等级规则、两步同意、目录与预选、strict-mcp 与守卫拦命令行、已知旁路；Slack / Meegle / 读网页 / OKR 各节里提到的旧文件路径改成新路径）
- Test: 无新增

- [ ] **Step 1: 规则 grep**（设计稿第六节）：
  ```bash
  cd apps/core/src && grep -rnE "isDoneStatus|TESTING_NAMES|_field_linked_story|SELF_HOSTS|slack\.com/api|chat\.postMessage|search\.messages|execFile\(\"(lark-cli|meegle|agent-browser)\"|\"lark-cli\"|\"agent-browser\"|com\.tinyspeck|friday-slack" --include='*.ts' . | grep -v '^./connectors/' | grep -v '\.test\.ts'
  ```
  期望无输出。`TaskSource` 的 `meegle*` 字段名与 `packages/shared` 的 `taskCategory` 不在此列（第二步处理）。
- [ ] **Step 2:** `pnpm -r typecheck && pnpm -r test` 全过。
- [ ] **Step 3: 真机验证**（按 CLAUDE.md「真机验收（2026-10-16）」的隔离方式：`FRIDAY_NO_SCHEDULER=1`、临时 `FRIDAY_DATA_DIR`、`FRIDAY_TMUX_SOCKET=friday-verify`、`FRIDAY_CLAUDE_BIN=<文件名叫 claude 的假脚本>`、`PATH` 前置记调用的假 `meegle`；记下 core 的 `$!`，前后看 ptmx）：
  1. 一次性 `tsx` 脚本调 `syncMeegleOnce()`，假 `meegle` 返回固定工单 → 任务板结果与在 `main` 上跑同一脚本的结果一致（新建 / 更新条数、标题、阶段、`meegleType`、`statusKey`）。
  2. 主对话接入 coral：本步要真调模型（Sonnet，约几毛钱）——**执行前先问用户是否同意花这次钱**；同意后在主对话说「接一下 coral 网关」，确认 Friday 依次调了 `tool_discover` → `tool_register`、转告了清单；回「确认」后 `tools_list` 里 coral 已启用。用户不同意就用一次性脚本直接 `saveTool` 一条 coral 登记代替。
  3. 起一个自主任务会话（假 `claude` 脚本把收到的参数写进文件）：参数里有 `--strict-mcp-config`；守卫脚本对 `meegle mywork todo`、`npx lark-cli docs +fetch` 输出 deny。
  4. bridge：对该 job `POST /mcp/:jobId` 发 `tools/call tool_call { tool: "coral", op: <一个 read 操作>, args }` → 有结果；发一个 `irreversible` 操作 → 返回「已挂待审」，任务 `pending` 多一条 `tool_call`，coral 侧没有被调用（看 `audit` 没有对应 `irreversible` 的执行记录）。
  5. 项目页终端（`kind: interactive`）的参数里**没有** `--strict-mcp-config`。
- [ ] **Step 4: 提交** `文档：外部工具注册处（第一步）`

---

## 自查记录

- 设计稿覆盖：4.1 → T1；4.2 → T2（四类调用方：friday / user / model / schedule 分别在 T2、T5/T6、T8、T7 落地）；4.3 → T9、T11；4.4 → T4–T6；4.5 → T8；4.6 → T10；4.7 → T4–T7、T12；五、约束 → Global Constraints、T13；六、验收第一步 → T5/T6 的 grep、T13；七、留给实现者 → T3（stdio 每次起进程）、T4（`web_read` 保留为薄封装）、T11（健康 10 分钟懒查）。4.8 第二步不在本计划。
- 已知更正两处见 Global Constraints 末尾。
