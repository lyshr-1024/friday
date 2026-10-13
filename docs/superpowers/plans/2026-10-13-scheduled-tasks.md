# 定时任务 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户在会话里一句话登记「什么时候 + 谁执行（项目里的 Claude / Friday 自己 / 固定调用）+ 提示词」，Friday 到点自己跑。

**Architecture:** `schedules` 表 + 调度器里一个 60 秒 tick 判到点；`agent/schedule.ts` 的 `fireSchedule` 按执行方分派到现成入口（`startAutonomousJob` / `startInteractiveJob` / `startRun` / 工具 handler / http MCP）。界面是「···」里一个弹窗，和周报、学习同一种 `Modal`。

**Tech Stack:** Node + TS（core，vitest，`node:sqlite`），`croner`（cron 解析），hono，React（desktop）。

**Spec:** `docs/superpowers/specs/2026-10-13-scheduled-tasks-design.md`

## Global Constraints

- 时区一律 `Asia/Shanghai`。
- 错过补一次；最近一次到点距今 > 12 小时不补，记 `schedule_skipped`。
- 上一轮没完跳过，同样写 `last_run_at`、记 `schedule_skipped`。
- 项目执行方的任务卡：`kind: "code"`，标题前缀 `[定时] `，`source.scheduleId`。
- 项目 continue 的「上几轮做了什么」最多 5 条。
- call：http MCP only，stdio 登记时拒；结果截 2000 字；15 秒超时。
- 定时会话里 `close_terminals` 硬拒。
- 账本 action：`schedule_added` / `schedule_updated` / `schedule_removed` / `schedule_fired` / `schedule_skipped`，不做撤销。
- 代码默认不写注释，只在 WHY 不明显时写一行；提交信息中文，结尾带 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`，不覆盖 git author。
- 验证时禁止 `pkill` / `killall`，只 kill 自己 `$!` 记下的 PID；tmux 用 `FRIDAY_TMUX_SOCKET=friday-verify` 隔离。

## Review Focus

1. **cron 写错 / 不合法**（比如「每天 25 点」）：`schedule_add` 要拒并说原因，不能登记一条永远不跑或每分钟都跑的。→ Task 2 `validateCron` 测试。
2. **长期卡被你手动标完成后再到点**：要 `reopenTask` 拉回来，而不是新建第二张卡、也不是往已关的会话里送话。→ Task 4 测试。
3. **项目被从注册表删了 / 改名**：到点时 `resolveProject` 失败要写 `last_ok=0` 并通知，不能抛出去把整个 tick 打断、拖累其他定时任务。→ Task 4 + Task 5 测试。
4. **同一分钟 tick 被两次进入**（上一轮 tick 还没跑完）：不能同一条触发两次。→ Task 5 `ticking` 守卫测试。
5. **call 指向 `friday` 的 `schedule_add` 自己**：会递归登记，登记时就拒。→ Task 4 `validateSchedule` 测试。

---

## File Structure

- Create `apps/core/src/memory/schedules.ts`：表的读写（CRUD、`setLastRun`、`pushHistory`、`scheduleByConversation`）。
- Modify `apps/core/src/memory/schema.ts`：`CREATE TABLE schedules`。
- Create `apps/core/src/scheduler/cron.ts`：`validateCron`、`lastDue`、`nextDue`、`describeCron`（纯函数）。
- Create `apps/core/src/connectors/mcp.ts`：从 `okr.ts` 抽出的 http MCP JSON-RPC 客户端 `callTool`、`mcpEndpoint`。
- Modify `apps/core/src/connectors/okr.ts`：改调 `connectors/mcp.ts`。
- Create `apps/core/src/agent/schedule.ts`：`validateSchedule`、`busyReason`、`fireSchedule`（三种执行方）、`scheduleTick`。
- Modify `apps/core/src/scheduler/index.ts`：挂 60 秒 tick。
- Create `apps/core/src/api/schedules.ts`，modify `api/index.ts`：四个接口。
- Modify `apps/core/src/agent/tools.ts`：`schedule_add` / `schedule_update` / `schedule_remove` / `schedules_list`；`close_terminals` 定时会话硬拒。
- Modify `apps/core/src/agent/prompt.ts`：系统提示加登记规则。
- Modify `packages/shared/src/index.ts`：`Schedule`、`ScheduleView`、`ScheduleExecutor` 类型；`TaskSource.scheduleId`；`RunTrigger` 加 `"schedule"`。
- Modify `apps/desktop/src/lib/core.ts`、`views/Routines.tsx`、`views/Chat.tsx`：弹窗 + 菜单项。
- Modify `CLAUDE.md`：加一节。

---

### Task 0: worktree 依赖

- [ ] **Step 1:** 在 `/Users/jinghaoran/hr-lys/friday-feat-scheduled-tasks` 跑 `pnpm install`，再 `pnpm --filter @friday/core add croner`。
- [ ] **Step 2:** `pnpm --filter @friday/core test` 全绿（基线）。
- [ ] **Step 3:** 提交 `package.json` / `pnpm-lock.yaml`：`git commit -m "core 加 croner：定时任务解析 cron"`。

---

### Task 1: 共享类型 + `schedules` 表

**Files:**
- Modify: `packages/shared/src/index.ts`（`TaskSource` 加字段；`RunTrigger`；新类型）
- Modify: `apps/core/src/memory/schema.ts`（`SCHEMA` 末尾加表）
- Create: `apps/core/src/memory/schedules.ts`
- Test: `apps/core/src/memory/schedules.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ScheduleExecutor = "project" | "friday" | "call";
  export interface Schedule {
    id: string; title: string; cron: string; enabled: boolean; executor: ScheduleExecutor;
    project?: string; prompt?: string; mode: "continue" | "fresh"; attended: boolean;
    server?: string; tool?: string; args?: Record<string, unknown>;
    anchorTaskId?: string; conversationId?: string;
    createdAt: string; lastRunAt?: string; lastResult?: string; lastOk?: boolean; lastRef?: string;
    history: Array<{ at: string; summary: string }>;
  }
  export interface ScheduleView extends Schedule { when: string; nextRunAt?: string; executorLabel: string }
  export type ScheduleInput = Pick<Schedule, "title" | "cron" | "executor"> & Partial<Pick<Schedule, "project" | "prompt" | "mode" | "attended" | "server" | "tool" | "args" | "enabled">>;
  // memory/schedules.ts
  createSchedule(input: ScheduleInput): Schedule
  getSchedule(id: string): Schedule | undefined
  listSchedules(): Schedule[]
  updateSchedule(id: string, patch: Partial<Omit<Schedule, "id" | "createdAt">>): Schedule | undefined
  deleteSchedule(id: string): boolean
  setLastRun(id: string, r: { ok: boolean; result: string; ref?: string; at?: string }): void
  pushHistory(id: string, item: { at: string; summary: string }): void   // 按 at 去重，留最近 5 条
  scheduleByConversation(conversationId: string): Schedule | undefined
  ```

- [ ] **Step 1: 改共享类型**

`packages/shared/src/index.ts`：
- `TaskSource` 里加 `/** 由哪条定时任务触发 */ scheduleId?: string;`
- `RunTrigger` 改成 `"retry" | "autostart" | "approve" | "slack" | "user" | "schedule"`
- 文件末尾加上面 Interfaces 里的 `ScheduleExecutor` / `Schedule` / `ScheduleView` / `ScheduleInput`。

- [ ] **Step 2: 写失败测试** `apps/core/src/memory/schedules.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { createSchedule, deleteSchedule, getSchedule, listSchedules, pushHistory, scheduleByConversation, setLastRun, updateSchedule } from "./schedules.js";

describe("schedules 表", () => {
  it("建、读、改、删", () => {
    const s = createSchedule({ title: "修验收", cron: "0 10 * * *", executor: "project", project: "whale-console", prompt: "去修" });
    expect(s.id).toMatch(/^s-[0-9a-f]{8}$/);
    expect(s).toMatchObject({ enabled: true, mode: "continue", attended: false, history: [] });
    expect(getSchedule(s.id)?.prompt).toBe("去修");
    updateSchedule(s.id, { enabled: false, anchorTaskId: "t1" });
    expect(getSchedule(s.id)).toMatchObject({ enabled: false, anchorTaskId: "t1" });
    expect(listSchedules().some((x) => x.id === s.id)).toBe(true);
    expect(deleteSchedule(s.id)).toBe(true);
    expect(getSchedule(s.id)).toBeUndefined();
  });

  it("call 的 args 存 JSON 读回原样", () => {
    const s = createSchedule({ title: "同步", cron: "0 9 * * *", executor: "call", server: "friday", tool: "meegle_sync", args: { a: 1 } });
    expect(getSchedule(s.id)?.args).toEqual({ a: 1 });
  });

  it("记上次结果", () => {
    const s = createSchedule({ title: "x", cron: "* * * * *", executor: "friday", prompt: "p" });
    setLastRun(s.id, { ok: false, result: "炸了", ref: "c1", at: "2026-10-13T02:00:00.000Z" });
    expect(getSchedule(s.id)).toMatchObject({ lastOk: false, lastResult: "炸了", lastRef: "c1", lastRunAt: "2026-10-13T02:00:00.000Z" });
  });

  it("history 按 at 去重、只留最近 5 条", () => {
    const s = createSchedule({ title: "h", cron: "* * * * *", executor: "project", project: "p", prompt: "p" });
    for (let i = 1; i <= 6; i++) pushHistory(s.id, { at: `2026-10-0${i}`, summary: `第${i}轮` });
    pushHistory(s.id, { at: "2026-10-06", summary: "第6轮" });
    expect(getSchedule(s.id)!.history.map((h) => h.summary)).toEqual(["第2轮", "第3轮", "第4轮", "第5轮", "第6轮"]);
  });

  it("按会话找定时任务", () => {
    const s = createSchedule({ title: "f", cron: "* * * * *", executor: "friday", prompt: "p" });
    updateSchedule(s.id, { conversationId: "conv-x" });
    expect(scheduleByConversation("conv-x")?.id).toBe(s.id);
    expect(scheduleByConversation("nope")).toBeUndefined();
  });
});
```

- [ ] **Step 3:** `pnpm --filter @friday/core exec vitest run src/memory/schedules.test.ts` → FAIL（模块不存在）。

- [ ] **Step 4: 表结构**——`schema.ts` 的 `SCHEMA` 模板串末尾（最后一个 `CREATE TABLE` 之后）加：

```sql
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  cron TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  executor TEXT NOT NULL,
  project TEXT,
  prompt TEXT,
  mode TEXT NOT NULL DEFAULT 'continue',
  attended INTEGER NOT NULL DEFAULT 0,
  server TEXT,
  tool TEXT,
  args TEXT,
  anchor_task_id TEXT,
  conversation_id TEXT,
  created_at TEXT NOT NULL,
  last_run_at TEXT,
  last_result TEXT,
  last_ok INTEGER,
  last_ref TEXT,
  history TEXT NOT NULL DEFAULT '[]'
);
```

- [ ] **Step 5: 实现** `apps/core/src/memory/schedules.ts`

```ts
import { randomBytes } from "node:crypto";
import type { Schedule, ScheduleInput } from "@friday/shared";
import { db } from "./db.js";

interface Row {
  id: string; title: string; cron: string; enabled: number; executor: Schedule["executor"];
  project: string | null; prompt: string | null; mode: Schedule["mode"]; attended: number;
  server: string | null; tool: string | null; args: string | null;
  anchor_task_id: string | null; conversation_id: string | null; created_at: string;
  last_run_at: string | null; last_result: string | null; last_ok: number | null; last_ref: string | null; history: string;
}

const toSchedule = (r: Row): Schedule => ({
  id: r.id, title: r.title, cron: r.cron, enabled: r.enabled === 1, executor: r.executor,
  ...(r.project ? { project: r.project } : {}),
  ...(r.prompt ? { prompt: r.prompt } : {}),
  mode: r.mode, attended: r.attended === 1,
  ...(r.server ? { server: r.server } : {}),
  ...(r.tool ? { tool: r.tool } : {}),
  ...(r.args ? { args: JSON.parse(r.args) as Record<string, unknown> } : {}),
  ...(r.anchor_task_id ? { anchorTaskId: r.anchor_task_id } : {}),
  ...(r.conversation_id ? { conversationId: r.conversation_id } : {}),
  createdAt: r.created_at,
  ...(r.last_run_at ? { lastRunAt: r.last_run_at } : {}),
  ...(r.last_result !== null ? { lastResult: r.last_result } : {}),
  ...(r.last_ok !== null ? { lastOk: r.last_ok === 1 } : {}),
  ...(r.last_ref ? { lastRef: r.last_ref } : {}),
  history: JSON.parse(r.history) as Schedule["history"],
});

export function getSchedule(id: string): Schedule | undefined {
  const r = db().prepare("SELECT * FROM schedules WHERE id = ?").get(id) as unknown as Row | undefined;
  return r ? toSchedule(r) : undefined;
}

export function listSchedules(): Schedule[] {
  return (db().prepare("SELECT * FROM schedules ORDER BY created_at").all() as unknown as Row[]).map(toSchedule);
}

export function createSchedule(input: ScheduleInput): Schedule {
  const id = `s-${randomBytes(4).toString("hex")}`;
  db()
    .prepare("INSERT INTO schedules (id, title, cron, enabled, executor, project, prompt, mode, attended, server, tool, args, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, input.title, input.cron, input.enabled === false ? 0 : 1, input.executor, input.project ?? null, input.prompt ?? null, input.mode ?? "continue", input.attended ? 1 : 0, input.server ?? null, input.tool ?? null, input.args ? JSON.stringify(input.args) : null, new Date().toISOString());
  return getSchedule(id)!;
}

const COLS: Record<string, string> = {
  title: "title", cron: "cron", enabled: "enabled", executor: "executor", project: "project", prompt: "prompt",
  mode: "mode", attended: "attended", server: "server", tool: "tool", args: "args",
  anchorTaskId: "anchor_task_id", conversationId: "conversation_id",
};

export function updateSchedule(id: string, patch: Partial<Omit<Schedule, "id" | "createdAt">>): Schedule | undefined {
  const sets: string[] = [];
  const vals: Array<string | number | null> = [];
  for (const [k, v] of Object.entries(patch)) {
    const col = COLS[k];
    if (!col) continue;
    sets.push(`${col} = ?`);
    vals.push(v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : k === "args" ? JSON.stringify(v) : (v as string));
  }
  if (sets.length) db().prepare(`UPDATE schedules SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
  return getSchedule(id);
}

export function deleteSchedule(id: string): boolean {
  return Number(db().prepare("DELETE FROM schedules WHERE id = ?").run(id).changes) > 0;
}

export function setLastRun(id: string, r: { ok: boolean; result: string; ref?: string; at?: string }): void {
  db()
    .prepare("UPDATE schedules SET last_run_at = ?, last_ok = ?, last_result = ?, last_ref = COALESCE(?, last_ref) WHERE id = ?")
    .run(r.at ?? new Date().toISOString(), r.ok ? 1 : 0, r.result.slice(0, 2000), r.ref ?? null, id);
}

export function pushHistory(id: string, item: { at: string; summary: string }): void {
  const s = getSchedule(id);
  if (!s || s.history.some((h) => h.at === item.at)) return;
  const next = [...s.history, item].slice(-5);
  db().prepare("UPDATE schedules SET history = ? WHERE id = ?").run(JSON.stringify(next), id);
}

export function scheduleByConversation(conversationId: string): Schedule | undefined {
  const r = db().prepare("SELECT * FROM schedules WHERE conversation_id = ?").get(conversationId) as unknown as Row | undefined;
  return r ? toSchedule(r) : undefined;
}
```

- [ ] **Step 6:** 跑 Step 3 的命令 → PASS；`pnpm typecheck` 通过。
- [ ] **Step 7: 提交**：`git commit -m "定时任务：schedules 表与读写"`

---

### Task 2: cron 工具函数

**Files:**
- Create: `apps/core/src/scheduler/cron.ts`
- Test: `apps/core/src/scheduler/cron.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const TZ = "Asia/Shanghai";
  validateCron(cron: string): string | undefined          // 错误原因；合法返回 undefined
  lastDue(cron: string, after: Date, now: Date): Date | undefined   // (after, now] 里最后一个到点时刻
  nextDue(cron: string, from?: Date): Date | undefined
  describeCron(cron: string): string
  ```

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { describeCron, lastDue, nextDue, validateCron } from "./cron.js";

// 上海 10:00 = UTC 02:00
const sh = (iso: string) => new Date(`${iso}+08:00`);

describe("cron", () => {
  it("不合法的拒掉，五段才算", () => {
    expect(validateCron("0 25 * * *")).toBeTruthy();
    expect(validateCron("每天十点")).toBeTruthy();
    expect(validateCron("0 0 10 * * *")).toBeTruthy();
    expect(validateCron("0 10 * * *")).toBeUndefined();
  });

  it("lastDue 取区间里最后一个到点", () => {
    expect(lastDue("0 10 * * *", sh("2026-10-13T09:00:00"), sh("2026-10-13T10:00:30"))?.toISOString()).toBe(sh("2026-10-13T10:00:00").toISOString());
    expect(lastDue("0 10 * * *", sh("2026-10-13T10:00:00"), sh("2026-10-13T11:00:00"))).toBeUndefined();
    expect(lastDue("*/5 * * * *", sh("2026-10-13T09:00:00"), sh("2026-10-13T09:17:00"))?.toISOString()).toBe(sh("2026-10-13T09:15:00").toISOString());
  });

  it("nextDue 按上海时区", () => {
    expect(nextDue("0 10 * * *", sh("2026-10-13T11:00:00"))?.toISOString()).toBe(sh("2026-10-14T10:00:00").toISOString());
  });

  it("常见形态翻成中文，其余原样", () => {
    expect(describeCron("0 10 * * *")).toBe("每天 10:00");
    expect(describeCron("30 9 * * 1-5")).toBe("工作日 09:30");
    expect(describeCron("0 16 * * 5")).toBe("每周五 16:00");
    expect(describeCron("0 9 * * 1,3")).toBe("每周一、三 09:00");
    expect(describeCron("15 * * * *")).toBe("每小时第 15 分");
    expect(describeCron("*/10 * * * *")).toBe("每 10 分钟");
    expect(describeCron("* * * * *")).toBe("每分钟");
    expect(describeCron("0 10 1 * *")).toBe("每月 1 日 10:00");
    expect(describeCron("0 10 1 6 *")).toBe("0 10 1 6 *");
  });
});
```

- [ ] **Step 2:** `pnpm --filter @friday/core exec vitest run src/scheduler/cron.test.ts` → FAIL。

- [ ] **Step 3: 实现**

```ts
import { Cron } from "croner";

export const TZ = "Asia/Shanghai";
const LOOKBACK_MS = 8 * 24 * 3600_000;

const make = (cron: string) => new Cron(cron, { timezone: TZ, paused: true });

export function validateCron(cron: string): string | undefined {
  if (cron.trim().split(/\s+/).length !== 5) return "cron 要五段：分 时 日 月 周";
  try {
    make(cron);
    return undefined;
  } catch (e) {
    return `cron 写错了：${e instanceof Error ? e.message : String(e)}`;
  }
}

export function lastDue(cron: string, after: Date, now: Date): Date | undefined {
  const c = make(cron);
  let cur = c.nextRun(new Date(Math.max(after.getTime(), now.getTime() - LOOKBACK_MS)));
  let due: Date | undefined;
  while (cur && cur <= now) {
    due = cur;
    cur = c.nextRun(cur);
  }
  return due;
}

export function nextDue(cron: string, from = new Date()): Date | undefined {
  return make(cron).nextRun(from) ?? undefined;
}

const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
const pad = (n: string) => n.padStart(2, "0");

export function describeCron(cron: string): string {
  const [m, h, dom, mon, dow] = cron.trim().split(/\s+/);
  if (!m || !h || !dom || !mon || !dow) return cron;
  if (mon !== "*") return cron;
  if (m === "*" && h === "*" && dom === "*" && dow === "*") return "每分钟";
  const every = /^\*\/(\d+)$/.exec(m);
  if (every && h === "*" && dom === "*" && dow === "*") return `每 ${every[1]} 分钟`;
  if (/^\d+$/.test(m) && h === "*" && dom === "*" && dow === "*") return `每小时第 ${m} 分`;
  if (!/^\d+$/.test(m) || !/^\d+$/.test(h)) return cron;
  const at = `${pad(h)}:${pad(m)}`;
  if (dom === "*" && dow === "*") return `每天 ${at}`;
  if (dom === "*" && dow === "1-5") return `工作日 ${at}`;
  if (dom === "*" && /^[0-6](,[0-6])*$/.test(dow)) return `每周${dow.split(",").map((d) => WEEK[Number(d)]).join("、")} ${at}`;
  if (/^\d+$/.test(dom) && dow === "*") return `每月 ${dom} 日 ${at}`;
  return cron;
}
```

- [ ] **Step 4:** 跑 Step 2 → PASS。若 croner 对 `0 25 * * *` 不抛错（版本差异），在 `validateCron` 里补一道按段范围的检查（分 0-59、时 0-23），让测试过。
- [ ] **Step 5: 提交**：`git commit -m "定时任务：cron 校验、到点计算与中文描述"`

---

### Task 3: http MCP 客户端从 okr.ts 抽出

**Files:**
- Create: `apps/core/src/connectors/mcp.ts`
- Modify: `apps/core/src/connectors/okr.ts`
- Test: `apps/core/src/connectors/mcp.test.ts`；跑现有 `okr` 相关测试确保不回归（`grep -l okr src/**/*.test.ts`）

**Interfaces:**
- Produces:
  ```ts
  export class McpError extends Error {}
  export type McpEndpoint = { url: string; headers: Record<string, string> };
  mcpEndpoint(server: string, file?: string): McpEndpoint      // 不存在 / 非 http 抛 McpError
  mcpServers(file?: string): Array<{ name: string; http: boolean }>
  parseRpcBody(body: string): { result?: any; error?: { message: string } }
  callTool(server: string, tool: string, args: Record<string, unknown>, opts?: { file?: string; label?: string }): Promise<{ text: string; isError: boolean }>
  ```
  `label` 用在报错文案里（okr 传 "OKR 平台"，默认用 server 名），保持 okr 现有报错原样。

- [ ] **Step 1: 写失败测试**——起一个本地 http 服务冒充 MCP：

```ts
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callTool, mcpEndpoint, mcpServers } from "./mcp.js";

let server: Server;
let file = "";
let mode: "json" | "sse" | "error" | "slow" = "json";

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body) as { id?: number; method: string };
      if (msg.method === "notifications/initialized") return void res.writeHead(202).end();
      if (msg.method === "initialize") return void res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s1" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
      if (mode === "slow") return;
      const result = mode === "error" ? { isError: true, content: [{ type: "text", text: "不行" }] } : { content: [{ type: "text", text: "ok:" + req.headers["mcp-session-id"] }] };
      const payload = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result });
      if (mode === "sse") res.writeHead(200, { "content-type": "text/event-stream" }).end(`event: message\ndata: ${payload}\n\n`);
      else res.writeHead(200, { "content-type": "application/json" }).end(payload);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  file = join(mkdtempSync(join(tmpdir(), "mcp-")), "claude.json");
  writeFileSync(file, JSON.stringify({ mcpServers: { fake: { type: "http", url: `http://127.0.0.1:${port}/mcp`, headers: { authorization: "x" } }, local: { command: "node" } } }));
});
afterAll(() => server.close());

describe("http MCP 客户端", () => {
  it("列出 server，标出是不是 http", () => {
    expect(mcpServers(file)).toEqual([{ name: "fake", http: true }, { name: "local", http: false }]);
  });
  it("stdio 和不存在的拒掉", () => {
    expect(() => mcpEndpoint("local", file)).toThrow(/http/);
    expect(() => mcpEndpoint("nope", file)).toThrow(/没有/);
  });
  it("JSON 响应，带上 session id", async () => {
    mode = "json";
    expect(await callTool("fake", "t", {}, { file })).toEqual({ text: "ok:s1", isError: false });
  });
  it("SSE 响应", async () => {
    mode = "sse";
    expect((await callTool("fake", "t", {}, { file })).text).toBe("ok:s1");
  });
  it("isError 透传", async () => {
    mode = "error";
    expect(await callTool("fake", "t", {}, { file })).toEqual({ text: "不行", isError: true });
  });
  it("超时报错", async () => {
    mode = "slow";
    await expect(callTool("fake", "t", {}, { file, timeoutMs: 300 })).rejects.toThrow(/没响应/);
  }, 5000);
});
```

（`opts` 里多一个仅测试用的 `timeoutMs?: number`，默认 15000。）

- [ ] **Step 2:** 跑 → FAIL。

- [ ] **Step 3: 实现 `connectors/mcp.ts`**：把 `okr.ts` 的 `okrEndpoint` / `parseRpcBody` / `netError` / `post` / `call` 搬过来泛化：

```ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export class McpError extends Error {}
export type McpEndpoint = { url: string; headers: Record<string, string> };
type Conf = { type?: string; url?: string; command?: string; headers?: Record<string, string> };

const claudeJson = (file?: string) => file ?? process.env.FRIDAY_CLAUDE_JSON ?? join(homedir(), ".claude.json");

function servers(file?: string): Record<string, Conf> {
  const f = claudeJson(file);
  try {
    return (JSON.parse(readFileSync(f, "utf8")) as { mcpServers?: Record<string, Conf> }).mcpServers ?? {};
  } catch {
    throw new McpError(`读不到 ${f}`);
  }
}

export function mcpServers(file?: string): Array<{ name: string; http: boolean }> {
  return Object.entries(servers(file)).map(([name, c]) => ({ name, http: Boolean(c.url) }));
}

// 凭证是 Claude Code 的 MCP 配置，Friday 不另存一份：用户在那边换了 token 这边自动跟上
export function mcpEndpoint(server: string, file?: string): McpEndpoint {
  const s = servers(file)[server];
  if (!s) throw new McpError(`${claudeJson(file)} 里没有 mcpServers.${server}`);
  if (!s.url) throw new McpError(`${server} 不是 http 类型的 MCP，Friday 只能直连 http 的`);
  return { url: s.url, headers: s.headers ?? {} };
}

export function parseRpcBody(body: string, label = "MCP"): { result?: any; error?: { message: string } } {
  const t = body.trim();
  if (!t) throw new McpError(`${label}返回了空响应`);
  const data = t.startsWith("{") ? t : t.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean).at(-1);
  try {
    return JSON.parse(data ?? "");
  } catch {
    throw new McpError(`${label}返回的内容解析不了：${t.slice(0, 120)}`);
  }
}

let seq = 0;

async function post(ep: McpEndpoint, msg: Record<string, unknown>, label: string, timeoutMs: number, session?: string): Promise<{ res: Response; body: string }> {
  let res: Response;
  let body: string;
  try {
    res = await fetch(ep.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(session ? { "mcp-session-id": session } : {}), ...ep.headers },
      body: JSON.stringify({ jsonrpc: "2.0", ...msg }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    body = await res.text();
  } catch (e) {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) throw new McpError(`${label} ${Math.round(timeoutMs / 1000)} 秒没响应`);
    throw new McpError(`连不上${label}：${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status === 401 || res.status === 403) throw new McpError(`${label}拒绝了 token，去 Claude Code 里重新配一下这个 MCP`);
  if (!res.ok && res.status !== 202) throw new McpError(`${label}返回 ${res.status}`);
  return { res, body };
}

export async function callTool(
  server: string,
  tool: string,
  args: Record<string, unknown>,
  opts: { file?: string; label?: string; timeoutMs?: number } = {},
): Promise<{ text: string; isError: boolean }> {
  const label = opts.label ?? server;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const ep = mcpEndpoint(server, opts.file);
  const init = await post(ep, { id: ++seq, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "friday", version: "1" } } }, label, timeoutMs);
  const session = init.res.headers.get("mcp-session-id") ?? undefined;
  parseRpcBody(init.body, label);
  await post(ep, { method: "notifications/initialized" }, label, timeoutMs, session);
  const msg = parseRpcBody((await post(ep, { id: ++seq, method: "tools/call", params: { name: tool, arguments: args } }, label, timeoutMs, session)).body, label);
  if (msg.error) throw new McpError(`${tool} 失败：${msg.error.message}`);
  const text = (msg.result?.content as Array<{ type: string; text?: string }> | undefined)?.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n") ?? "";
  return { text, isError: Boolean(msg.result?.isError) };
}
```

- [ ] **Step 4: 改 `okr.ts`**：删掉本地的 `Endpoint` / `post` / `netError` / `seq`；`okrEndpoint` 保留为 `export const okrEndpoint = (file?: string) => mcpEndpoint("okr", file)`（若有测试在用它）；`parseRpcBody` 改为 re-export 前先看有没有外部引用（`grep -rn parseRpcBody src`），只有测试用就把测试改到 `mcp.test.ts` 的覆盖下并删掉 okr 里的；`call` 改为：

```ts
async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  let r: { text: string; isError: boolean };
  try {
    r = await callTool("okr", name, args, { label: "OKR 平台" });
  } catch (e) {
    throw new OkrError(e instanceof Error ? e.message : String(e));
  }
  if (r.isError) throw new OkrError(`${name} 失败：${r.text.slice(0, 200)}`);
  try {
    return JSON.parse(r.text) as T;
  } catch {
    throw new OkrError(`${name} 返回的不是 JSON：${r.text.slice(0, 120)}`);
  }
}
```

`OkrError` 留着（weekly 用它判断是否 blocked）。

- [ ] **Step 5:** 跑 `mcp.test.ts` 和全部现有测试 `pnpm --filter @friday/core test` → 全绿；`pnpm typecheck`。
- [ ] **Step 6: 提交**：`git commit -m "把 okr 的 MCP 直连客户端抽成通用的 connectors/mcp.ts"`

---

### Task 4: 分派——`fireSchedule` 与三种执行方

**Files:**
- Create: `apps/core/src/agent/schedule.ts`
- Test: `apps/core/src/agent/schedule.test.ts`

**Interfaces:**
- Consumes: Task 1 `memory/schedules.ts`；Task 2 `validateCron`；Task 3 `callTool` / `mcpEndpoint`；现有 `startAutonomousJob(task, project, dir, detail, trigger)`、`startInteractiveJob(task, project, dir, detail)`、`reopenTask(id)`（`agent/pipeline.ts`）、`startRun` / `subscribe` / `isRunning`（`agent/runs.ts`）、`createTask` / `getTask`（`memory/tasks.ts`）、`resolveProject`、`record`、`state.notices`。
- Produces:
  ```ts
  validateSchedule(input: ScheduleInput): string | undefined
  busyReason(s: Schedule): string | undefined
  fireSchedule(s: Schedule, why: "due" | "manual"): Promise<{ ok: boolean; result: string; ref?: string }>
  SCHEDULE_NOTE(title: string): string
  ```

- [ ] **Step 1: 写失败测试**（`vi.mock` 掉重的入口）

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./pipeline.js", () => ({
  startAutonomousJob: vi.fn(async (t) => t),
  startInteractiveJob: vi.fn(async (t) => t),
  reopenTask: vi.fn(async (id) => ({ task: { id }, terminal: false })),
}));
vi.mock("./runs.js", () => ({ startRun: vi.fn(), subscribe: vi.fn(() => () => {}), isRunning: vi.fn(() => false) }));
vi.mock("../memory/projects.js", () => ({
  resolveProject: (q: string) => (q === "whale-console" ? { kind: "match", project: { name: "whale-console", dir: "/tmp/wc" } } : { kind: "none" }),
}));

import { startAutonomousJob, startInteractiveJob, reopenTask } from "./pipeline.js";
import { startRun, isRunning } from "./runs.js";
import { busyReason, fireSchedule, validateSchedule } from "./schedule.js";
import { createSchedule, getSchedule, updateSchedule } from "../memory/schedules.js";
import { getTask, updateTask } from "../memory/tasks.js";

beforeEach(() => vi.clearAllMocks());

describe("validateSchedule", () => {
  it("拒：cron 错、项目找不到、缺 prompt、call 指自己", () => {
    expect(validateSchedule({ title: "x", cron: "0 25 * * *", executor: "friday", prompt: "p" })).toMatch(/cron/);
    expect(validateSchedule({ title: "x", cron: "0 10 * * *", executor: "project", project: "nope", prompt: "p" })).toMatch(/项目/);
    expect(validateSchedule({ title: "x", cron: "0 10 * * *", executor: "friday" })).toMatch(/提示词/);
    expect(validateSchedule({ title: "x", cron: "0 10 * * *", executor: "call", server: "friday", tool: "schedule_add" })).toMatch(/定时/);
    expect(validateSchedule({ title: "x", cron: "0 10 * * *", executor: "project", project: "whale-console", prompt: "p" })).toBeUndefined();
  });
});

describe("project 执行方", () => {
  it("continue：第一次建长期卡，第二次复用、带上一轮概要", async () => {
    const s = createSchedule({ title: "修验收", cron: "0 10 * * *", executor: "project", project: "whale-console", prompt: "去修" });
    const r1 = await fireSchedule(s, "due");
    expect(r1.ok).toBe(true);
    const anchor = getSchedule(s.id)!.anchorTaskId!;
    expect(getTask(anchor)).toMatchObject({ kind: "code", title: "[定时] 修验收", project: "whale-console", source: { scheduleId: s.id } });
    expect(vi.mocked(startAutonomousJob).mock.calls[0]![4]).toBe("schedule");

    updateTask(anchor, { report: { summary: "修了资产总览配色", changes: [], testProcess: "", testResult: "通过", screenshots: [], verify: [], at: "2026-10-13T02:30:00.000Z" } as never });
    await fireSchedule(getSchedule(s.id)!, "due");
    const call2 = vi.mocked(startAutonomousJob).mock.calls[1]!;
    expect(call2[0].id).toBe(anchor);
    expect(call2[3]).toContain("修了资产总览配色");
    expect(getSchedule(s.id)!.history).toHaveLength(1);
  });

  it("continue：长期卡被标完成了先重开", async () => {
    const s = createSchedule({ title: "a", cron: "0 10 * * *", executor: "project", project: "whale-console", prompt: "p" });
    await fireSchedule(s, "due");
    const anchor = getSchedule(s.id)!.anchorTaskId!;
    updateTask(anchor, { status: "done" });
    await fireSchedule(getSchedule(s.id)!, "due");
    expect(reopenTask).toHaveBeenCalledWith(anchor);
  });

  it("fresh + 有人值守：每次新卡、走交互式", async () => {
    const s = createSchedule({ title: "b", cron: "0 10 * * *", executor: "project", project: "whale-console", prompt: "p", mode: "fresh", attended: true });
    const a = await fireSchedule(s, "due");
    const b = await fireSchedule(getSchedule(s.id)!, "due");
    expect(a.ref).not.toBe(b.ref);
    expect(startInteractiveJob).toHaveBeenCalledTimes(2);
  });

  it("项目没了：不抛，返回失败", async () => {
    const s = createSchedule({ title: "c", cron: "0 10 * * *", executor: "project", project: "gone", prompt: "p" });
    const r = await fireSchedule(s, "due");
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/项目/);
  });
});

describe("friday 执行方", () => {
  it("系统提示带定时说明，continue 复用同一段会话", async () => {
    const s = createSchedule({ title: "早报", cron: "0 9 * * *", executor: "friday", prompt: "看看今天" });
    const r1 = await fireSchedule(s, "due");
    const r2 = await fireSchedule(getSchedule(s.id)!, "due");
    expect(r1.ref).toBe(r2.ref);
    const opts = vi.mocked(startRun).mock.calls[0]![2];
    expect(opts.systemPrompt).toContain("定时任务「早报」");
    expect(opts.label).toBe("schedule");
  });

  it("上一轮还在生成就算忙", () => {
    const s = createSchedule({ title: "d", cron: "0 9 * * *", executor: "friday", prompt: "p" });
    updateSchedule(s.id, { conversationId: "c-busy" });
    vi.mocked(isRunning).mockReturnValueOnce(true);
    expect(busyReason(getSchedule(s.id)!)).toMatch(/还在/);
  });
});

describe("call 执行方", () => {
  it("friday 工具直调 handler，参数过 schema", async () => {
    const s = createSchedule({ title: "e", cron: "0 9 * * *", executor: "call", server: "friday", tool: "memory_read", args: { file: "projects" } });
    const r = await fireSchedule(s, "due");
    expect(r.ok).toBe(true);
  });
  it("参数不合 schema 返回失败", async () => {
    const s = createSchedule({ title: "f", cron: "0 9 * * *", executor: "call", server: "friday", tool: "memory_read", args: {} });
    expect((await fireSchedule(s, "due")).ok).toBe(false);
  });
});
```

（`report` 的字段以 `packages/shared` 里 `DeliveryReport` 的实际定义为准，写测试时对一下，缺的字段补齐，去掉 `as never`。）

- [ ] **Step 2:** 跑 → FAIL。

- [ ] **Step 3: 实现** `agent/schedule.ts`

```ts
import { z } from "zod";
import type { Schedule, ScheduleInput, Task } from "@friday/shared";
import { config } from "../config.js";
import { userSettings } from "../settings.js";
import { record } from "../memory/audit.js";
import { getJob } from "../memory/jobs.js";
import { resolveProject } from "../memory/projects.js";
import { createTask, getTask } from "../memory/tasks.js";
import { claudeSessionId, createConversation } from "../memory/conversations.js";
import { loadMemoryContext } from "../memory/context.js";
import { getSchedule, pushHistory, updateSchedule } from "../memory/schedules.js";
import { validateCron } from "../scheduler/cron.js";
import { state } from "../scheduler/index.js";
import { callTool, mcpEndpoint } from "../connectors/mcp.js";
import { reopenTask, startAutonomousJob, startInteractiveJob } from "./pipeline.js";
import { friday } from "./prompt.js";
import { isRunning, startRun, subscribe } from "./runs.js";
import { transcriptPath } from "./runner.js";
import { existsSync } from "node:fs";

type Fired = { ok: boolean; result: string; ref?: string };

export const SCHEDULE_NOTE = (title: string) =>
  `这一轮是定时任务「${title}」自动触发的，用户不在看。不可逆的动作只能挂成待审，不要直接执行；回答第一行写一句结论。`;

export function validateSchedule(i: ScheduleInput): string | undefined {
  const bad = validateCron(i.cron);
  if (bad) return bad;
  if (i.executor === "project") {
    if (!i.project || resolveProject(i.project).kind !== "match") return `找不到项目「${i.project ?? ""}」`;
    if (!i.prompt?.trim()) return "项目定时任务要写提示词";
  }
  if (i.executor === "friday" && !i.prompt?.trim()) return "Friday 定时任务要写提示词";
  if (i.executor === "call") {
    if (!i.server || !i.tool) return "固定调用要写 server 和 tool";
    if (i.server === "friday") {
      if (i.tool.startsWith("schedule")) return "定时任务不能去登记 / 改定时任务";
    } else {
      try {
        mcpEndpoint(i.server);
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    }
  }
  return undefined;
}

const runningJob = (t: Task | undefined) => Boolean(t?.source.jobId && getJob(t.source.jobId)?.status === "running");
const hasPending = (t: Task | undefined) => Boolean(t && t.status !== "done" && t.status !== "ignored" && (t.pending ?? []).length);

export function busyReason(s: Schedule): string | undefined {
  if (s.executor === "friday") return s.conversationId && isRunning(s.conversationId) ? "上一轮还在生成" : undefined;
  if (s.executor !== "project") return undefined;
  const last = getTask((s.mode === "continue" ? s.anchorTaskId : s.lastRef) ?? "");
  if (hasPending(last)) return "上一轮的交付还等你处理";
  if (!s.attended && runningJob(last)) return "上一轮还在跑";
  return undefined;
}

async function fireProject(s: Schedule): Promise<Fired> {
  const r = resolveProject(s.project ?? "");
  if (r.kind !== "match") return { ok: false, result: `找不到项目「${s.project ?? ""}」，去项目注册表看看是不是改名了` };
  let task: Task | undefined;
  let detail = s.prompt ?? "";
  if (s.mode === "continue") {
    task = s.anchorTaskId ? getTask(s.anchorTaskId) : undefined;
    if (task?.report?.at) pushHistory(s.id, { at: task.report.at, summary: task.report.summary });
    if (task && (task.status === "done" || task.status === "ignored")) task = (await reopenTask(task.id))?.task;
    const history = getSchedule(s.id)?.history ?? [];
    if (history.length) detail += `\n\n上几轮做过的（别重复做）：\n${history.map((h) => `- ${h.at.slice(0, 10)}：${h.summary}`).join("\n")}`;
  }
  if (!task) {
    task = createTask({ title: `[定时] ${s.title}`, kind: "code", project: r.project.name, status: "understood", understanding: s.prompt, source: { scheduleId: s.id } });
    if (s.mode === "continue") updateSchedule(s.id, { anchorTaskId: task.id });
  }
  const t = s.attended
    ? await startInteractiveJob(task, r.project.name, r.project.dir, detail)
    : await startAutonomousJob(task, r.project.name, r.project.dir, detail, "schedule");
  if (s.attended) state.notices.push({ title: `到点了 · ${r.project.name}`, body: `已开好终端：${s.title}`, taskId: t.id });
  return { ok: true, result: s.attended ? "终端已开好，等你接手" : "已开工，干完交审", ref: t.id };
}

function fireFriday(s: Schedule): Fired {
  let conv = s.mode === "continue" ? s.conversationId : undefined;
  if (!conv) {
    conv = createConversation().id;
    updateSchedule(s.id, { conversationId: conv });
  }
  const prefs = userSettings();
  const session = claudeSessionId(conv);
  const resume = session && existsSync(transcriptPath(config.dataDir, session)) ? session : undefined;
  startRun(conv, s.prompt ?? "", {
    systemPrompt: `${friday(loadMemoryContext(), prefs.skills)}\n\n${SCHEDULE_NOTE(s.title)}`,
    cwd: config.dataDir,
    skills: prefs.skills,
    skillList: prefs.skillList,
    web: true,
    label: "schedule",
    ...(resume ? { resume } : {}),
    ...(prefs.model ? { model: prefs.model } : {}),
  });
  let answer = "";
  const off = subscribe(conv, (ev) => {
    if (ev.type === "delta") answer += ev.text;
    if (ev.type === "reset") answer = "";
    if (ev.type !== "done") return;
    off?.();
    const first = answer.trim().split("\n").find((l) => l.trim())?.slice(0, 80) ?? "（没有回答）";
    state.notices.push({ title: s.title, body: first });
  });
  return { ok: true, result: "Friday 在跑，结果写进这段会话", ref: conv };
}

async function fireCall(s: Schedule): Promise<Fired> {
  const args = s.args ?? {};
  if (s.server === "friday") {
    const { fridayToolList } = await import("./tools.js");
    const def = fridayToolList().find((t) => t.name === s.tool);
    if (!def) return { ok: false, result: `Friday 没有 ${s.tool} 这个工具` };
    const parsed = z.object(def.inputSchema).safeParse(args);
    if (!parsed.success) return { ok: false, result: `参数不对：${parsed.error.message.slice(0, 300)}` };
    const r = await def.handler(parsed.data, {});
    const text = r.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
    return { ok: !r.isError, result: text };
  }
  const r = await callTool(s.server ?? "", s.tool ?? "", args);
  return { ok: !r.isError, result: r.text };
}

export async function fireSchedule(s: Schedule, why: "due" | "manual"): Promise<Fired> {
  let out: Fired;
  try {
    out = s.executor === "project" ? await fireProject(s) : s.executor === "friday" ? fireFriday(s) : await fireCall(s);
  } catch (e) {
    out = { ok: false, result: e instanceof Error ? e.message : String(e) };
  }
  record({
    ...(s.executor === "project" && out.ref ? { taskId: out.ref } : {}),
    action: "schedule_fired",
    why: why === "due" ? `定时任务「${s.title}」到点了` : `你点了「现在跑一次」：${s.title}`,
    how: out.result.slice(0, 200),
    evidence: { scheduleId: s.id, executor: s.executor, ref: out.ref ?? null },
    risk: "reversible",
    status: out.ok ? "done" : "failed",
  });
  if (!out.ok) state.notices.push({ title: `定时任务没跑成 · ${s.title}`, body: out.result.slice(0, 200) });
  return out;
}
```

注意：`state` 从 `scheduler/index.ts` 导入会形成循环（Task 5 里 index 要导入 schedule.ts 的 tick）。若 vitest/tsx 报循环未初始化，把 `state.notices.push` 改成从 `scheduler/index.ts` 动态取，或把 `notices` 改由一个小模块导出——优先看 `autostart.ts` 是怎么拿 `state` 的并照抄。

- [ ] **Step 4:** 跑 → PASS；`pnpm typecheck`。
- [ ] **Step 5: 提交**：`git commit -m "定时任务：三种执行方的分派（项目 / Friday / 固定调用）"`

---

### Task 5: tick + 接口

**Files:**
- Modify: `apps/core/src/agent/schedule.ts`（加 `scheduleTick`）
- Modify: `apps/core/src/scheduler/index.ts`（`startScheduler` 里挂上）
- Create: `apps/core/src/api/schedules.ts`；Modify: `apps/core/src/api/index.ts`
- Test: `apps/core/src/agent/schedule.tick.test.ts`、`apps/core/src/api/schedules.test.ts`

**Interfaces:**
- Produces:
  ```ts
  scheduleTick(now?: Date, fire?: typeof fireSchedule): Promise<number>   // 返回本轮触发条数
  toView(s: Schedule): ScheduleView
  // HTTP
  GET    /schedules            → { items: ScheduleView[] }
  PATCH  /schedules/:id        { enabled: boolean } → ScheduleView
  POST   /schedules/:id/run    → { ok, result, ref? }   忙时 409 { error }
  DELETE /schedules/:id        → { ok: true }
  ```

- [ ] **Step 1: 写失败测试** `schedule.tick.test.ts`

```ts
import { describe, expect, it, vi } from "vitest";
vi.mock("./runs.js", () => ({ isRunning: vi.fn(() => false), startRun: vi.fn(), subscribe: vi.fn(() => () => {}) }));
import { isRunning } from "./runs.js";
import { scheduleTick } from "./schedule.js";
import { createSchedule, getSchedule, listSchedules, deleteSchedule, updateSchedule } from "../memory/schedules.js";
import { db } from "../memory/db.js";

const sh = (iso: string) => new Date(`${iso}+08:00`);
const clean = () => listSchedules().forEach((s) => deleteSchedule(s.id));
const backdate = (id: string, iso: string) => db().prepare("UPDATE schedules SET created_at = ? WHERE id = ?").run(iso, id);

describe("scheduleTick", () => {
  it("到点跑一次，同一分钟再 tick 不重复", async () => {
    clean();
    const s = createSchedule({ title: "a", cron: "0 10 * * *", executor: "friday", prompt: "p" });
    backdate(s.id, sh("2026-10-12T00:00:00").toISOString());
    const fire = vi.fn(async () => ({ ok: true, result: "ok" }));
    expect(await scheduleTick(sh("2026-10-13T10:00:20"), fire)).toBe(1);
    expect(await scheduleTick(sh("2026-10-13T10:00:50"), fire)).toBe(0);
    expect(getSchedule(s.id)!.lastRunAt).toBeTruthy();
  });

  it("错过补一次：下午醒来只跑一次", async () => {
    clean();
    const s = createSchedule({ title: "b", cron: "*/30 * * * *", executor: "friday", prompt: "p" });
    backdate(s.id, sh("2026-10-13T08:00:00").toISOString());
    const fire = vi.fn(async () => ({ ok: true, result: "ok" }));
    expect(await scheduleTick(sh("2026-10-13T15:10:00"), fire)).toBe(1);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("超过 12 小时不补，写一句原因", async () => {
    clean();
    const s = createSchedule({ title: "c", cron: "0 10 * * 1", executor: "friday", prompt: "p" });
    backdate(s.id, sh("2026-10-01T00:00:00").toISOString());
    const fire = vi.fn(async () => ({ ok: true, result: "ok" }));
    expect(await scheduleTick(sh("2026-10-13T23:00:00"), fire)).toBe(0);
    expect(fire).not.toHaveBeenCalled();
    expect(getSchedule(s.id)!.lastResult).toMatch(/超过 12 小时/);
  });

  it("创建之前的到点不算", async () => {
    clean();
    const s = createSchedule({ title: "d", cron: "0 10 * * *", executor: "friday", prompt: "p" });
    backdate(s.id, sh("2026-10-13T10:30:00").toISOString());
    const fire = vi.fn(async () => ({ ok: true, result: "ok" }));
    expect(await scheduleTick(sh("2026-10-13T11:00:00"), fire)).toBe(0);
  });

  it("关掉的不跑；上一轮没完跳过并写原因", async () => {
    clean();
    const s = createSchedule({ title: "e", cron: "0 10 * * *", executor: "friday", prompt: "p", enabled: false });
    backdate(s.id, sh("2026-10-12T00:00:00").toISOString());
    const fire = vi.fn(async () => ({ ok: true, result: "ok" }));
    expect(await scheduleTick(sh("2026-10-13T10:00:20"), fire)).toBe(0);
    updateSchedule(s.id, { enabled: true, conversationId: "c-busy2" });
    vi.mocked(isRunning).mockReturnValueOnce(true);
    expect(await scheduleTick(sh("2026-10-13T10:00:20"), fire)).toBe(0);
    expect(getSchedule(s.id)!.lastResult).toMatch(/还在/);
  });

  it("一条抛错不影响下一条", async () => {
    clean();
    for (const t of ["x", "y"]) backdate(createSchedule({ title: t, cron: "0 10 * * *", executor: "friday", prompt: "p" }).id, sh("2026-10-12T00:00:00").toISOString());
    const fire = vi.fn().mockRejectedValueOnce(new Error("炸")).mockResolvedValueOnce({ ok: true, result: "ok" });
    expect(await scheduleTick(sh("2026-10-13T10:00:20"), fire)).toBe(1);
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it("tick 重入：上一轮 tick 没完时直接返回 0", async () => {
    clean();
    backdate(createSchedule({ title: "z", cron: "0 10 * * *", executor: "friday", prompt: "p" }).id, sh("2026-10-12T00:00:00").toISOString());
    let release!: () => void;
    const fire = vi.fn(() => new Promise<{ ok: boolean; result: string }>((r) => { release = () => r({ ok: true, result: "ok" }); }));
    const first = scheduleTick(sh("2026-10-13T10:00:20"), fire);
    expect(await scheduleTick(sh("2026-10-13T10:00:30"), fire)).toBe(0);
    release();
    expect(await first).toBe(1);
  });
});
```

- [ ] **Step 2:** 跑 → FAIL。

- [ ] **Step 3: 实现**（加到 `agent/schedule.ts`）

```ts
import { describeCron, lastDue, nextDue } from "../scheduler/cron.js";
import { listSchedules, setLastRun } from "../memory/schedules.js";
import type { ScheduleView } from "@friday/shared";

const LATE_MS = 12 * 3600_000;
let ticking = false;

export async function scheduleTick(now = new Date(), fire = fireSchedule): Promise<number> {
  if (ticking) return 0;
  ticking = true;
  let n = 0;
  try {
    for (const s of listSchedules()) {
      if (!s.enabled) continue;
      const after = new Date(Math.max(Date.parse(s.createdAt), s.lastRunAt ? Date.parse(s.lastRunAt) : 0));
      const due = lastDue(s.cron, after, now);
      if (!due) continue;
      const at = now.toISOString();
      if (now.getTime() - due.getTime() > LATE_MS) {
        const hm = due.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
        setLastRun(s.id, { ok: false, result: `错过了 ${hm} 那次，超过 12 小时不补`, at });
        record({ action: "schedule_skipped", why: `定时任务「${s.title}」错过太久`, how: `错过了 ${hm}`, evidence: { scheduleId: s.id }, risk: "read" });
        continue;
      }
      const busy = busyReason(s);
      if (busy) {
        setLastRun(s.id, { ok: false, result: `${busy}，这一轮跳过`, at });
        record({ action: "schedule_skipped", why: `定时任务「${s.title}」${busy}`, how: "这一轮跳过", evidence: { scheduleId: s.id }, risk: "read" });
        continue;
      }
      // 先占住 last_run_at：fire 里可能跑很久，期间不能被当成还没跑
      setLastRun(s.id, { ok: true, result: "在跑", at });
      try {
        const r = await fire(s, "due");
        setLastRun(s.id, { ok: r.ok, result: r.result, ...(r.ref ? { ref: r.ref } : {}), at });
        n++;
      } catch (e) {
        setLastRun(s.id, { ok: false, result: e instanceof Error ? e.message : String(e), at });
      }
    }
  } finally {
    ticking = false;
  }
  return n;
}

const EXEC_LABEL = (s: Schedule) =>
  s.executor === "project"
    ? `${s.project} · ${s.attended ? "有人值守" : "无人值守"} · ${s.mode === "continue" ? "接着上次" : "每次新开"}`
    : s.executor === "friday"
      ? `Friday · ${s.mode === "continue" ? "接着上次" : "每次新开"}`
      : `调用 ${s.server}.${s.tool}`;

export function toView(s: Schedule): ScheduleView {
  const next = s.enabled ? nextDue(s.cron) : undefined;
  return { ...s, when: describeCron(s.cron), executorLabel: EXEC_LABEL(s), ...(next ? { nextRunAt: next.toISOString() } : {}) };
}
```

注意「一条抛错不影响下一条」用例里 fire 抛错时不计入 `n`，所以期望 1。

- [ ] **Step 4: 挂到调度器**——`scheduler/index.ts` 的 `startScheduler` 末尾：

```ts
  const scheduleLoop = async () => {
    const { scheduleTick } = await import("../agent/schedule.js");
    await scheduleTick().catch((e) => console.error(`[schedule] ${e instanceof Error ? e.message : e}`));
    setTimeout(scheduleLoop, 60_000).unref();
  };
  setTimeout(scheduleLoop, 15_000).unref();
```

（动态 import 避开 `schedule.ts → scheduler/index.ts(state)` 的循环。）

- [ ] **Step 5: 接口测试** `api/schedules.test.ts`

```ts
import { describe, expect, it, vi } from "vitest";
vi.mock("../agent/schedule.js", async (orig) => ({ ...(await orig<typeof import("../agent/schedule.js")>()), fireSchedule: vi.fn(async () => ({ ok: true, result: "跑了", ref: "r1" })) }));
import { schedules } from "./schedules.js";
import { createSchedule, getSchedule } from "../memory/schedules.js";

describe("/schedules", () => {
  it("列、关、跑、删", async () => {
    const s = createSchedule({ title: "a", cron: "0 10 * * *", executor: "friday", prompt: "p" });
    const list = await (await schedules.request("/schedules")).json() as { items: Array<{ id: string; when: string }> };
    expect(list.items.find((x) => x.id === s.id)?.when).toBe("每天 10:00");
    expect((await schedules.request(`/schedules/${s.id}`, { method: "PATCH", body: JSON.stringify({ enabled: false }), headers: { "content-type": "application/json" } })).status).toBe(200);
    expect(getSchedule(s.id)!.enabled).toBe(false);
    const run = await (await schedules.request(`/schedules/${s.id}/run`, { method: "POST" })).json() as { result: string };
    expect(run.result).toBe("跑了");
    expect(getSchedule(s.id)!.lastResult).toBe("跑了");
    expect((await schedules.request(`/schedules/${s.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await schedules.request(`/schedules/${s.id}`, { method: "DELETE" })).status).toBe(404);
  });
});
```

- [ ] **Step 6: 实现** `api/schedules.ts`，并在 `api/index.ts` 加 `import { schedules } from "./schedules.js";` 与 `.route("/", schedules)`：

```ts
import { Hono } from "hono";
import { z } from "zod";
import { busyReason, fireSchedule, toView } from "../agent/schedule.js";
import { record } from "../memory/audit.js";
import { deleteSchedule, getSchedule, listSchedules, setLastRun, updateSchedule } from "../memory/schedules.js";

export const schedules = new Hono()
  .get("/schedules", (c) => c.json({ items: listSchedules().map(toView) }))
  .patch("/schedules/:id", async (c) => {
    const p = z.object({ enabled: z.boolean() }).safeParse(await c.req.json().catch(() => null));
    if (!p.success) return c.json({ error: "要带 enabled" }, 400);
    const s = updateSchedule(c.req.param("id"), { enabled: p.data.enabled });
    if (!s) return c.json({ error: "没有这条定时任务" }, 404);
    record({ action: "schedule_updated", why: p.data.enabled ? "你打开了定时任务" : "你关掉了定时任务", how: s.title, evidence: { scheduleId: s.id }, risk: "reversible" });
    return c.json(toView(s));
  })
  .post("/schedules/:id/run", async (c) => {
    const s = getSchedule(c.req.param("id"));
    if (!s) return c.json({ error: "没有这条定时任务" }, 404);
    const busy = busyReason(s);
    if (busy) return c.json({ error: busy }, 409);
    const r = await fireSchedule(s, "manual");
    setLastRun(s.id, { ok: r.ok, result: r.result, ...(r.ref ? { ref: r.ref } : {}) });
    return c.json(r);
  })
  .delete("/schedules/:id", (c) => {
    const s = getSchedule(c.req.param("id"));
    if (!s || !deleteSchedule(s.id)) return c.json({ error: "没有这条定时任务" }, 404);
    record({ action: "schedule_removed", why: "你在定时任务列表里删了它", how: s.title, evidence: { schedule: s }, risk: "reversible" });
    return c.json({ ok: true });
  });
```

- [ ] **Step 7:** 跑两份测试 + 全量 `pnpm --filter @friday/core test` → 全绿；`pnpm typecheck`。
- [ ] **Step 8: 提交**：`git commit -m "定时任务：每分钟对一次到点、错过补一次、上一轮没完跳过；/schedules 接口"`

---

### Task 6: 会话工具 + 系统提示

**Files:**
- Modify: `apps/core/src/agent/tools.ts`
- Modify: `apps/core/src/agent/prompt.ts`
- Test: `apps/core/src/agent/scheduleTools.test.ts`

**Interfaces:**
- Consumes: `validateSchedule`、`toView`（Task 4/5），`createSchedule` / `updateSchedule` / `deleteSchedule` / `listSchedules` / `scheduleByConversation`（Task 1）。
- Produces: 工具 `schedule_add`、`schedule_update`、`schedule_remove`、`schedules_list`。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { fridayToolList } from "./tools.js";
import { createSchedule, getSchedule, listSchedules, updateSchedule } from "../memory/schedules.js";

const call = async (name: string, args: Record<string, unknown>, conv?: string) => {
  const t = fridayToolList(conv).find((x) => x.name === name)!;
  const r = await t.handler(args as never, {});
  return (r.content[0] as { text: string }).text;
};

describe("定时任务工具", () => {
  it("schedule_add 校验不过就不登记", async () => {
    const before = listSchedules().length;
    expect(await call("schedule_add", { title: "x", cron: "0 25 * * *", executor: "friday", prompt: "p" })).toMatch(/没登记/);
    expect(listSchedules().length).toBe(before);
  });
  it("schedule_add 成功返回 id 和下次时间", async () => {
    const out = await call("schedule_add", { title: "早报", cron: "0 9 * * *", executor: "friday", prompt: "看看今天" });
    expect(out).toMatch(/s-[0-9a-f]{8}/);
    expect(out).toMatch(/每天 09:00/);
  });
  it("schedule_update 改完再校验", async () => {
    const s = createSchedule({ title: "u", cron: "0 9 * * *", executor: "friday", prompt: "p" });
    expect(await call("schedule_update", { id: s.id, cron: "bad" })).toMatch(/没改/);
    await call("schedule_update", { id: s.id, cron: "0 10 * * *" });
    expect(getSchedule(s.id)!.cron).toBe("0 10 * * *");
  });
  it("定时会话里 close_terminals 被拒", async () => {
    const s = createSchedule({ title: "c", cron: "0 9 * * *", executor: "friday", prompt: "p" });
    updateSchedule(s.id, { conversationId: "conv-sched" });
    expect(await call("close_terminals", { scope: "all" }, "conv-sched")).toMatch(/定时任务里不能关终端/);
  });
});
```

- [ ] **Step 2:** 跑 → FAIL。

- [ ] **Step 3: 实现**——`tools.ts` 顶部加 import：

```ts
import { createSchedule, deleteSchedule, getSchedule, listSchedules, scheduleByConversation, updateSchedule } from "../memory/schedules.js";
```

`close_terminals` 的 handler 第一行加：

```ts
        if (conversationId && scheduleByConversation(conversationId)) return text("定时任务里不能关终端，等用户回来。");
```

`fridayToolList` 数组末尾（`task_reject` 之后）加：

```ts
    tool(
      "schedule_add",
      "登记一条定时任务。调之前必须先把「什么时候 · 谁跑 · 跑什么 · 接着上次还是每次新开 · 有没有人值守」复述给用户、他说好了再调；executor=call 时把 server、tool、args 原样列给他看（不经过模型、无人值守，写操作会直接执行）。cron 五段（分 时 日 月 周），按上海时区。executor：project=在项目里起 Claude Code（要 project + prompt），friday=你自己带 skill/MCP 跑一轮（要 prompt），call=固定调一个工具（server 为 friday 或用户 Claude Code 里配的 http MCP 名，tool，args）。mode：continue 接着上次（同一张卡 / 同一段会话，能看到之前做过什么），fresh 每次新开；attended：true 开交互式终端等用户接手，false 无人值守干完交审。用户没说 mode / attended 就按描述判断，并在复述里写明。",
      {
        title: z.string().min(1).max(80),
        cron: z.string().min(1).max(60),
        executor: z.enum(["project", "friday", "call"]),
        project: z.string().max(120).optional(),
        prompt: z.string().max(4000).optional(),
        mode: z.enum(["continue", "fresh"]).optional(),
        attended: z.boolean().optional(),
        server: z.string().max(60).optional(),
        tool: z.string().max(80).optional(),
        args: z.record(z.string(), z.unknown()).optional(),
      },
      async (input) => {
        const { validateSchedule, toView } = await import("./schedule.js");
        const bad = validateSchedule(input);
        if (bad) return text(`没登记：${bad}`);
        const s = createSchedule(input);
        record({ action: "schedule_added", why: "你让 Friday 登记一条定时任务", how: `${s.title}（${s.cron}）`, evidence: { schedule: s }, risk: "reversible" });
        const v = toView(s);
        return text(`已登记 ${s.id}：${v.when} · ${v.executorLabel}${v.nextRunAt ? `，下次 ${new Date(v.nextRunAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}` : ""}。在「···」→ 定时任务里能看到。`);
      },
    ),
    tool(
      "schedule_update",
      "改一条定时任务（只传要改的字段）。改之前同样先复述改成什么、用户说好再调。enabled=false 是暂停。",
      {
        id: z.string().min(1).max(20),
        title: z.string().min(1).max(80).optional(),
        cron: z.string().min(1).max(60).optional(),
        enabled: z.boolean().optional(),
        project: z.string().max(120).optional(),
        prompt: z.string().max(4000).optional(),
        mode: z.enum(["continue", "fresh"]).optional(),
        attended: z.boolean().optional(),
        server: z.string().max(60).optional(),
        tool: z.string().max(80).optional(),
        args: z.record(z.string(), z.unknown()).optional(),
      },
      async ({ id, ...patch }) => {
        const s = getSchedule(id);
        if (!s) return text(`没有定时任务 ${id}，先用 schedules_list 看看。`);
        const { validateSchedule, toView } = await import("./schedule.js");
        const next = { ...s, ...patch };
        const bad = validateSchedule(next);
        if (bad) return text(`没改：${bad}`);
        const u = updateSchedule(id, patch)!;
        record({ action: "schedule_updated", why: "你让 Friday 改一条定时任务", how: Object.keys(patch).join("、"), evidence: { before: s, after: u }, risk: "reversible" });
        const v = toView(u);
        return text(`改好了：${u.title} · ${v.when} · ${v.executorLabel}${u.enabled ? "" : "（已暂停）"}`);
      },
    ),
    tool(
      "schedule_remove",
      "删掉一条定时任务。用户明确说删才调；只是想暂停用 schedule_update 的 enabled=false。",
      { id: z.string().min(1).max(20) },
      async ({ id }) => {
        const s = getSchedule(id);
        if (!s || !deleteSchedule(id)) return text(`没有定时任务 ${id}。`);
        record({ action: "schedule_removed", why: "你让 Friday 删掉一条定时任务", how: s.title, evidence: { schedule: s }, risk: "reversible" });
        return text(`删了：${s.title}`);
      },
    ),
    tool(
      "schedules_list",
      "列出所有定时任务：id、时间、谁跑、开没开、上次结果。用户问「有哪些定时任务」或要改 / 删之前先查。",
      {},
      async () => {
        const { toView } = await import("./schedule.js");
        const all = listSchedules().map(toView);
        if (!all.length) return text("还没有定时任务。");
        return text(all.map((v) => `${v.id} ${v.enabled ? "" : "[暂停] "}${v.title}｜${v.when}｜${v.executorLabel}｜上次：${v.lastRunAt ? `${v.lastOk ? "✓" : "✗"} ${v.lastResult ?? ""}`.slice(0, 80) : "还没跑过"}`).join("\n"));
      },
    ),
```

- [ ] **Step 4: 系统提示**——`prompt.ts` 的 `friday()` 里 `sections` 找到讲工具 / 说「已 X 之前必须真调过」那段，在其后加一条：

```ts
    "用户说「每天 / 每周 / 几点 …… 去做 X」就是要登记定时任务（schedule_add）：先复述「什么时候 · 谁跑（哪个项目里的 Claude / 你自己 / 固定调用某个工具）· 跑什么 · 接着上次还是每次新开 · 有没有人值守」，他说好再调。具体去哪拉数据、怎么筛，原样写进 prompt 交给执行方，不要说你做不到。",
```

- [ ] **Step 5:** 跑测试 + 全量 + typecheck → 全绿。
- [ ] **Step 6: 提交**：`git commit -m "定时任务：会话里登记 / 改 / 删 / 列，定时会话里不许关终端"`

---

### Task 7: 前端弹窗

**Files:**
- Modify: `apps/desktop/src/lib/core.ts`（四个请求函数）
- Modify: `apps/desktop/src/views/Routines.tsx`（`ScheduleDialog`，`Routine` 加 `"schedule"`）
- Modify: `apps/desktop/src/views/Chat.tsx`（菜单项 + 挂载 + 跳任务 / 会话）
- Modify: `apps/desktop/src/styles.css`（仅当现有 `.rtn__*` 不够用时补少量样式）

**Interfaces:**
- Consumes: HTTP 接口（Task 5），`ScheduleView`（Task 1）。
- Produces: `ScheduleDialog({ onClose, onOpenWeekly, onOpenLearn, onOpenTask, onOpenConversation })`。

- [ ] **Step 1: 请求函数**（`lib/core.ts`，照 `routines()` 的写法）

```ts
export async function listSchedules(): Promise<ScheduleView[]> {
  const res = await fetch(`${await coreBaseUrl()}/schedules`);
  if (!res.ok) throw new Error(`schedules ${res.status}`);
  return ((await res.json()) as { items: ScheduleView[] }).items;
}

export async function setScheduleEnabled(id: string, enabled: boolean): Promise<ScheduleView> {
  const res = await fetch(`${await coreBaseUrl()}/schedules/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `core 返回 ${res.status}`);
  return res.json();
}

export async function runSchedule(id: string): Promise<{ ok: boolean; result: string; ref?: string }> {
  const res = await fetch(`${await coreBaseUrl()}/schedules/${encodeURIComponent(id)}/run`, { method: "POST" });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `core 返回 ${res.status}`);
  return res.json();
}

export async function removeSchedule(id: string): Promise<void> {
  const res = await fetch(`${await coreBaseUrl()}/schedules/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `core 返回 ${res.status}`);
}
```

- [ ] **Step 2: `ScheduleDialog`**（加在 `Routines.tsx`，复用该文件里的 `Switch`、`usePrefs`、`Modal`、`.rtn__*` 类名）

```tsx
export type Routine = "weekly" | "learn" | "schedule";

const ago = (iso?: string) => {
  if (!iso) return "还没跑过";
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 1 ? "刚刚" : m < 60 ? `${m} 分钟前` : m < 1440 ? `${Math.round(m / 60)} 小时前` : `${Math.round(m / 1440)} 天前`;
};
const at = (iso?: string) => (iso ? new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");

export function ScheduleDialog({ onClose, onOpenWeekly, onOpenLearn, onOpenTask, onOpenConversation }: {
  onClose: () => void;
  onOpenWeekly: () => void;
  onOpenLearn: () => void;
  onOpenTask: (id: string) => void;
  onOpenConversation: (id: string) => void;
}) {
  const { prefs, toggle } = usePrefs();
  const [items, setItems] = useState<ScheduleView[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [arm, setArm] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const pull = () => listSchedules().then(setItems).catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  useEffect(() => { void pull(); }, []);

  async function act(id: string, fn: () => Promise<unknown>) {
    setBusy(id);
    setErr("");
    try {
      await fn();
      await pull();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const goLast = (s: ScheduleView) => {
    if (!s.lastRef) return;
    if (s.executor === "friday") onOpenConversation(s.lastRef);
    else if (s.executor === "project") onOpenTask(s.lastRef);
  };

  return (
    <Modal label="定时任务" title="定时任务" sub="到点 Friday 会自己做的事" onClose={onClose} className="rtn">
      <section className="rtn__sec">
        <div className="tdlg__k">内置</div>
        <div className="rtn__list">
          <div className="rtn__item rtn__item--btn" role="button" tabIndex={0} onClick={onOpenWeekly} onKeyDown={(e) => e.key === "Enter" && onOpenWeekly()}>
            <span className="rtn__name">OKR 周报</span>
            <span className="rtn__note">周五 16:00 起自动起草</span>
            <span onClick={(e) => e.stopPropagation()}><Switch on={!!prefs?.okrWeekly} disabled={!prefs} onClick={() => toggle("okrWeekly")} /></span>
          </div>
          <div className="rtn__item rtn__item--btn" role="button" tabIndex={0} onClick={onOpenLearn} onKeyDown={(e) => e.key === "Enter" && onOpenLearn()}>
            <span className="rtn__name">从历史学手册</span>
            <span className="rtn__note">每周一轮</span>
            <span onClick={(e) => e.stopPropagation()}><Switch on={!!prefs?.learnHistory} disabled={!prefs} onClick={() => toggle("learnHistory")} /></span>
          </div>
        </div>
      </section>

      <section className="rtn__sec">
        <div className="tdlg__k">你登记的</div>
        {err && <div className="okr__err">{err}</div>}
        {items && !items.length && <div className="rtn__empty">还没有定时任务。在会话里说「每天 10 点在 whale-console 里……」就能登记。</div>}
        <div className="rtn__list">
          {items?.map((s) => (
            <div key={s.id} className="rtn__sched">
              <div className="rtn__item rtn__item--btn" role="button" tabIndex={0} aria-expanded={open === s.id} onClick={() => setOpen(open === s.id ? null : s.id)} onKeyDown={(e) => e.key === "Enter" && setOpen(open === s.id ? null : s.id)}>
                <span className="rtn__name">{s.title}</span>
                <span className="rtn__note mono">{s.when}</span>
                <span className="rtn__note">{s.executorLabel}</span>
                <span className="rtn__note">下次 {s.enabled ? at(s.nextRunAt) : "已暂停"}</span>
                <button className="link" disabled={!s.lastRef} title={s.lastResult ?? ""} onClick={(e) => { e.stopPropagation(); goLast(s); }}>
                  {s.lastRunAt ? `${s.lastOk ? "✓" : "✗"} ${ago(s.lastRunAt)}` : "还没跑过"}
                </button>
                <span onClick={(e) => e.stopPropagation()}><Switch on={s.enabled} disabled={busy === s.id} onClick={() => void act(s.id, () => setScheduleEnabled(s.id, !s.enabled))} /></span>
                <button className="b b--ghost" disabled={busy === s.id} onClick={(e) => { e.stopPropagation(); void act(s.id, () => runSchedule(s.id)); }}>{busy === s.id ? "在跑" : "现在跑一次"}</button>
                <button
                  className="b b--ghost"
                  disabled={busy === s.id}
                  onClick={(e) => { e.stopPropagation(); if (arm !== s.id) return setArm(s.id); setArm(null); void act(s.id, () => removeSchedule(s.id)); }}
                  onBlur={() => setArm(null)}
                >
                  {arm === s.id ? "再点一次删除" : "删除"}
                </button>
              </div>
              {open === s.id && (
                <div className="rtn__detail">
                  {s.lastResult && <div className="rtn__note">上次：{s.lastResult}</div>}
                  <pre className="rtn__prompt">{s.executor === "call" ? `${s.server}.${s.tool}\n${JSON.stringify(s.args ?? {}, null, 2)}` : s.prompt}</pre>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>
    </Modal>
  );
}
```

import 补 `ScheduleView` 与四个请求函数。

- [ ] **Step 3: 挂到 Chat.tsx**——菜单在「学习」后加：

```ts
    { label: "定时任务", run: () => setRoutine("schedule") },
```

挂载处（`routine === "learn"` 那行之后）：

```tsx
      {routine === "schedule" && (
        <ScheduleDialog
          onClose={() => setRoutine(null)}
          onOpenWeekly={() => setRoutine("weekly")}
          onOpenLearn={() => setRoutine("learn")}
          onOpenTask={(id) => { setRoutine(null); void openTask(id); }}
          onOpenConversation={(id) => { setRoutine(null); openConversation(id); }}
        />
      )}
```

`openTask` / `openConversation` 用 Chat.tsx 里现有「点通知定位任务」与「会话历史点一段打开」的那两个函数——先 `grep -n "openTask\|会话历史" views/Chat.tsx` 找到实际函数名，名字不同就用实际的。

- [ ] **Step 4: 样式**——只在缺的时候补到 `styles.css`，用现有 token（`--s-*`、`--t-*`、`--fg-*`、`--line-*`）：`.rtn__item--btn { cursor: default }`（桌面约定不用手形）、`.rtn__detail { padding: var(--s-2) var(--s-3); }`、`.rtn__prompt { white-space: pre-wrap; font: var(--t-sm)/1.5 var(--mono); color: var(--fg-2); margin: 0; }`、`.rtn__empty { color: var(--fg-3); font-size: var(--t-sm); }`。行内多列若挤，给 `.rtn__sched .rtn__item` 设 `flex-wrap: wrap`。

- [ ] **Step 5:** `pnpm typecheck`（根目录，含 desktop）通过。
- [ ] **Step 6: 提交**：`git commit -m "「···」加定时任务弹窗：内置周报 / 学习 + 你登记的，开关、现在跑一次、删除"`

---

### Task 8: 真机验收 + 文档

- [ ] **Step 1: 隔离起服务**（worktree 根目录）：

```bash
export FRIDAY_PORT=7793 FRIDAY_DATA_DIR=$(mktemp -d) FRIDAY_TMUX_SOCKET=friday-verify FRIDAY_CLAUDE_BIN=<scratchpad 里的假 claude 脚本>
lsof -nP 2>/dev/null | grep -c /dev/ptmx   # 记下基线
pnpm --filter @friday/core dev & CORE=$!
VITE_FRIDAY_PORT=7793 pnpm --filter @friday/desktop exec vite --port 1423 & VITE=$!
```

假 claude 脚本：打印收到的参数到 `$FRIDAY_DATA_DIR/fake-claude.log`，`sleep 2` 后退出 0。项目注册表在临时 dataDir 的 `projects.md` 里登记一个临时 git 仓库（`git init` + 一个提交）。

- [ ] **Step 2: project continue**：`curl` 直接调 `POST /ask` 不现实（要真模型），改用测试路由：在 node REPL / 一次性脚本里 `createSchedule({cron:"* * * * *", executor:"project", project:"<临时仓库>", prompt:"打印一行", mode:"continue"})`，等两分钟：确认①只有一张 `[定时]` 卡②第二轮的 `fake-claude.log` 里提示词带「上几轮做过的」（需先给长期卡手写一个 `report`）③账本有两条 `schedule_fired`。
- [ ] **Step 3: friday + call**：登记 `executor: "call", server: "friday", tool: "memory_read", args: {file:"projects"}` 每分钟一次，看 `last_result` 是 projects.md 内容；friday 执行方要真模型，用「现在跑一次」跑一次真实的（成本约 $0.1），确认会话里有回答、通知队列有一条。
- [ ] **Step 4: 浏览器**：agent-browser 打开 `http://localhost:1423`，「···」→ 定时任务：截图空态、列表、展开一行、暂停开关、「现在跑一次」、删除二次确认、点「上次结果」跳任务卡；内置两行点开对应弹窗。截图存 scratchpad。
- [ ] **Step 5: 收尾**：`kill $CORE $VITE`；`tmux -L friday-verify kill-server`；再看一次 `/dev/ptmx` 计数回到基线。
- [ ] **Step 6: CLAUDE.md**：在「OKR 周报」一节前加「## 定时任务（2026-10-13）」：定位（时间 + 执行方 + 提示词，不写专用连接器）、表与 tick 规则（错过补一次、12 小时、上一轮没完跳过）、三种执行方各走哪个入口、continue 的 `history` 为什么不靠对话上下文、`connectors/mcp.ts` 抽出、`close_terminals` 硬拒、弹窗位置、真机验收方式。
- [ ] **Step 7: 提交**：`git commit -m "CLAUDE.md：定时任务一节"`
