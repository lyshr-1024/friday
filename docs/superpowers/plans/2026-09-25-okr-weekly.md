# OKR 周报 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Friday 每周用 git 提交和任务起草 OKR 周报（每个 KR 一份），挂成审核卡，用户改完点提交后由 Friday 写到 OKR 平台。

**Architecture:** core 里新增零模型的 OKR 客户端（直接对 okr MCP 的 HTTP 端点发 JSON-RPC，凭证每次从 `~/.claude.json` 读）、零模型的素材收集、一次 Sonnet 起草 + 解析钳制，结果落成 `kind: okr_weekly` 任务上的 `okr_submit` 待审动作；提交与撤销都是确定性代码。前端在任务卡里给这类任务渲染一块可编辑的周报表。

**Tech Stack:** Node + TypeScript（hono、vitest、`node:sqlite`）、React、`@anthropic-ai/claude-agent-sdk`（仅起草那一次）。

**Spec:** `docs/superpowers/specs/2026-09-25-okr-weekly-design.md`

## Global Constraints

- 周标识格式 `2026W0921-0927`（年 = 周一所在年，周一到周日，本地时区）。
- 进度：沿用上周为基线，模型建议 < 上周 → 改回上周；> 100 → 100；**永不自动下调**。
- 平台上该周该 KR 已有报告 → `state: "existing"`，**绝不覆盖、不重交**。
- 外部文本（git subject、任务标题 / 交付概要、上周正文）进 prompt 前一律 `untrusted()`。
- 凭证不另存：每次调用读 `~/.claude.json` 的 `mcpServers.okr`；测试用 `FRIDAY_CLAUDE_JSON` 指向临时文件。
- 不改 `strictMcpConfig`；不写 O 级报告；不读 Claude Code 历史。
- 提交信息用中文；git author 用仓库配置，不要 `-c user.*` 覆盖；结尾加 `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`。
- 代码默认不写注释，只在 WHY 不明显时写一行；不加内部兜底。
- 工作目录：worktree `/Users/jinghaoran/hr-lys/friday-feat-okr-weekly`，分支 `feat/okr-weekly`。core 测试在 `apps/core` 下 `npx vitest run <file>`；全量 `pnpm typecheck && pnpm test`（仓库根）。

## Review Focus

1. **OKR 端点回 SSE 帧而不是纯 JSON**（streamable HTTP 常见）→ 客户端两种都能解析。Task 1 `parseRpcBody` 测试覆盖。
2. **用户改了草稿马上点提交**，改动还在防抖里没存 → 交出去的是旧草稿。前端提交前必须先 flush 保存（Task 8 `flushOkrDraft`），后端 PUT 合并逐字段覆盖（Task 6 测试）。
3. **焦点在卡片空白处按回车** → 不能直接把周报交到平台上。Task 8 让 `okr_submit` 不响应全局回车，浏览器里验证。
4. **重跑起草时已经提交了一部分** → 已 `submitted` 的行保留，不被新草稿覆盖、不重交。Task 5 测试覆盖。
5. **周日 23:59 / 周五 15:59 / 跨年周** → 目标周算对。Task 2 测试覆盖。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `packages/shared/src/index.ts`（改） | `TaskKind` 加 `okr_weekly`；`PendingActionType` 加 `okr_submit`；`TaskSource.okrWeek`；`OkrWeeklyDraft` / `OkrRow` 类型；`UserSettings.okrWeekly` / `SettingsUpdate.okrWeekly` |
| `apps/core/src/connectors/okr.ts`（新） | OKR 客户端：读配置、JSON-RPC、`me / myKRs / quarterReports / submit / remove` |
| `apps/core/src/agent/weekly/week.ts`（新） | `Week`、`weekOf`、`targetWeek`、`parseWeek` |
| `apps/core/src/agent/weekly/collect.ts`（新） | `collectGit`、`collectTasks`、`collectMaterials` |
| `apps/core/src/agent/weekly/draft.ts`（新） | `draftPrompt`、`parseDraft`（钳制）、`draftWithModel` |
| `apps/core/src/agent/weekly/index.ts`（新） | `draftWeeklyOnce`：拼行、建 / 更新任务、通知、记账；`autoDraftTick` |
| `apps/core/src/agent/weekly/submit.ts`（新） | `submitRows`：逐条提交、记账带撤销 |
| `apps/core/src/agent/pipeline.ts`（改） | `executePending` 加 `okr_submit` 分支 |
| `apps/core/src/memory/audit.ts`（改） | `Undo` 加 `delete_okr_reports` |
| `apps/core/src/api/tasks.ts`（改） | `POST /tasks/okr-weekly`、`PUT /tasks/:id/okr-draft`、撤销分支 |
| `apps/core/src/settings.ts`、`api/settings.ts`（改） | `okrWeekly` 开关 |
| `apps/core/src/scheduler/index.ts`（改） | 每 30 分钟 `autoDraftTick` |
| `apps/core/src/agent/tools.ts`、`agent/prompt.ts`（改） | 会话工具 `okr_weekly` + 系统提示一句 |
| `apps/desktop/src/views/OkrWeekly.tsx`（新） | 审核卡里的周报表 + `flushOkrDraft` |
| `apps/desktop/src/views/Board.tsx`（改） | 挂 `OkrWeekly`、后果预览、回车排除 |
| `apps/desktop/src/lib/core.ts`（改） | `saveOkrDraft`、`okrWeeklyNow` |
| `apps/desktop/src/views/Settings.tsx`（改） | 「OKR 周报」分组 |
| `apps/desktop/src/styles.css`（改） | `.okr*` 样式 |
| `CLAUDE.md`（改） | 功能说明一节 |

---

### Task 1: 共享类型 + OKR 客户端

**Files:**
- Modify: `packages/shared/src/index.ts`
- Create: `apps/core/src/connectors/okr.ts`
- Test: `apps/core/src/connectors/okr.test.ts`

**Interfaces:**
- Produces（shared）:
  ```ts
  export type TaskKind = ... | "okr_weekly";
  export type PendingActionType = ... | "okr_submit";
  // TaskSource 增加：okrWeek?: string;
  export type OkrRowState = "draft" | "empty" | "existing" | "submitted" | "failed";
  export interface OkrRow {
    objectId: number; kr: string; objective: string;
    content: string; pct: number; prevPct: number | null; why: string;
    used: Array<{ id: string; text: string }>;
    checked: boolean; state: OkrRowState; reportId?: number; error?: string;
  }
  export interface OkrWeeklyDraft { week: string; quarter: string; rows: OkrRow[]; unmatched: Array<{ id: string; text: string }> }
  // UserSettings 增加 okrWeekly: boolean；SettingsUpdate 增加 okrWeekly?: boolean
  ```
- Produces（okr.ts）:
  ```ts
  export class OkrError extends Error {}
  export function okrEndpoint(file?: string): { url: string; headers: Record<string, string> };
  export function parseRpcBody(body: string): { result?: any; error?: { message: string } };
  export interface OkrKR { id: number; name: string; objective: string; quarter: string }
  export interface OkrReport { id: number; objectId: number; week: string; content: string; pct: number }
  export async function me(): Promise<{ id: number; name: string }>;
  export async function myKRs(): Promise<OkrKR[]>;
  export async function quarterReports(ownerId: number, quarter: string): Promise<OkrReport[]>;
  export async function submit(r: { objectId: number; week: string; quarter: string; content: string; pct: number }): Promise<number>;
  export async function remove(reportId: number): Promise<void>;
  ```

- [ ] **Step 1: 改 shared 类型**

在 `packages/shared/src/index.ts`：`TaskKind` 联合末尾加 `| "okr_weekly"`；`PendingActionType` 加 `| "okr_submit"`；`interface TaskSource` 里加：

```ts
  /** OKR 周报任务对应的周，如 2026W0921-0927 */
  okrWeek?: string;
```

`UserSettings` 在 `learnHistory: boolean;` 后加 `okrWeekly: boolean;`，`SettingsUpdate` 在 `learnHistory?: boolean;` 后加 `okrWeekly?: boolean;`。文件末尾（`PendingAction` 定义之后）加 Interfaces 里的 `OkrRowState` / `OkrRow` / `OkrWeeklyDraft`。

- [ ] **Step 2: 写失败测试**

`apps/core/src/connectors/okr.test.ts`：

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OkrError, myKRs, okrEndpoint, parseRpcBody, submit } from "./okr.js";

const dir = mkdtempSync(join(tmpdir(), "okr-"));
const cfg = (v: unknown) => {
  const f = join(dir, `${Math.random()}.json`);
  writeFileSync(f, JSON.stringify(v));
  process.env.FRIDAY_CLAUDE_JSON = f;
  return f;
};
const good = () => cfg({ mcpServers: { okr: { type: "http", url: "https://okr.test/mcp", headers: { "x-authorization": "tok" } } } });

function rpcFetch(tool: (name: string, args: Record<string, unknown>) => unknown) {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const msg = JSON.parse(String(init.body)) as { id?: number; method: string; params: { name: string; arguments: Record<string, unknown> } };
    if (msg.id === undefined) return new Response(null, { status: 202 });
    if (msg.method === "initialize") return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }), { headers: { "mcp-session-id": "s1" } });
    const out = tool(msg.params.name, msg.params.arguments);
    return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(out) }] } })}\n\n`);
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("OKR 客户端", () => {
  it("配置缺失时说清楚缺什么", () => {
    const f = cfg({ mcpServers: {} });
    expect(() => okrEndpoint()).toThrow(OkrError);
    expect(() => okrEndpoint()).toThrow(`${f} 里没有 mcpServers.okr`);
  });

  it("JSON 和 SSE 两种响应体都能解析", () => {
    expect(parseRpcBody('{"jsonrpc":"2.0","id":1,"result":{"a":1}}').result).toEqual({ a: 1 });
    expect(parseRpcBody('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"a":2}}\n\n').result).toEqual({ a: 2 });
    expect(() => parseRpcBody("")).toThrow(OkrError);
  });

  it("myKRs 只要 KR，带上父 O 的名字；请求带配置里的 header 和 session", async () => {
    good();
    const f = rpcFetch(() => ({ root: { objects: [
      { id: 1, name: "O 一", label: "O", parent_id: 0, quarter: "2026Q3" },
      { id: 2, name: "KR 甲", label: "KR", parent_id: 1, quarter: "2026Q3" },
    ] } }));
    vi.stubGlobal("fetch", f);
    expect(await myKRs()).toEqual([{ id: 2, name: "KR 甲", objective: "O 一", quarter: "2026Q3" }]);
    const last = f.mock.calls.at(-1)![1] as RequestInit;
    expect((last.headers as Record<string, string>)["x-authorization"]).toBe("tok");
    expect((last.headers as Record<string, string>)["mcp-session-id"]).toBe("s1");
  });

  it("401 翻成人话", async () => {
    good();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 401 })));
    await expect(myKRs()).rejects.toThrow("OKR 平台拒绝了 token");
  });

  it("工具报错（isError）要抛出来，不当成成功", async () => {
    good();
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      const msg = JSON.parse(String(init.body)) as { id?: number; method: string };
      if (msg.id === undefined) return new Response(null, { status: 202 });
      const result = msg.method === "initialize" ? {} : { isError: true, content: [{ type: "text", text: "INVALID_ARGUMENT: week" }] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    }));
    await expect(submit({ objectId: 2, week: "2026W0921-0927", quarter: "2026Q3", content: "x", pct: 50 })).rejects.toThrow("INVALID_ARGUMENT");
  });

  it("submit 返回 report id；响应里没有 id 就回查这周", async () => {
    good();
    vi.stubGlobal("fetch", rpcFetch((name) => (name === "create_progress_report" ? { ok: true } : name === "get_current_user" ? { id: 9, name: "me" } : { reports: [{ id: 77, object_id: 2, week: "2026W0921-0927", content: "x", progress_percentage: 50 }] })));
    expect(await submit({ objectId: 2, week: "2026W0921-0927", quarter: "2026Q3", content: "x", pct: 50 })).toBe(77);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run（`apps/core` 下）: `npx vitest run src/connectors/okr.test.ts`
Expected: FAIL，`Cannot find module './okr.js'`

- [ ] **Step 4: 实现 `apps/core/src/connectors/okr.ts`**

```ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export class OkrError extends Error {}

type Endpoint = { url: string; headers: Record<string, string> };

// 凭证是 Claude Code 的 okr MCP 配置，Friday 不另存一份：用户在那边换了 token 这边自动跟上
export function okrEndpoint(file = process.env.FRIDAY_CLAUDE_JSON || join(homedir(), ".claude.json")): Endpoint {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new OkrError(`读不到 ${file}`);
  }
  const s = (raw as { mcpServers?: Record<string, { url?: string; headers?: Record<string, string> }> }).mcpServers?.okr;
  if (!s?.url) throw new OkrError(`${file} 里没有 mcpServers.okr`);
  return { url: s.url, headers: s.headers ?? {} };
}

export function parseRpcBody(body: string): { result?: any; error?: { message: string } } {
  const t = body.trim();
  if (t.startsWith("{")) return JSON.parse(t);
  const data = t.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean).at(-1);
  if (!data) throw new OkrError("OKR 平台返回了空响应");
  return JSON.parse(data);
}

let seq = 0;

async function post(ep: Endpoint, msg: Record<string, unknown>, session?: string): Promise<Response> {
  const res = await fetch(ep.url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(session ? { "mcp-session-id": session } : {}), ...ep.headers },
    body: JSON.stringify({ jsonrpc: "2.0", ...msg }),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401 || res.status === 403) throw new OkrError("OKR 平台拒绝了 token，去 Claude Code 里重新配一下 okr MCP");
  if (!res.ok && res.status !== 202) throw new OkrError(`OKR 平台返回 ${res.status}`);
  return res;
}

async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const ep = okrEndpoint();
  const init = await post(ep, { id: ++seq, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "friday", version: "1" } } });
  const session = init.headers.get("mcp-session-id") ?? undefined;
  parseRpcBody(await init.text());
  await post(ep, { method: "notifications/initialized" }, session);
  const res = await post(ep, { id: ++seq, method: "tools/call", params: { name, arguments: args } }, session);
  const msg = parseRpcBody(await res.text());
  if (msg.error) throw new OkrError(`${name} 失败：${msg.error.message}`);
  const text = (msg.result?.content as Array<{ type: string; text?: string }> | undefined)?.find((c) => c.type === "text")?.text ?? "";
  if (msg.result?.isError) throw new OkrError(`${name} 失败：${text.slice(0, 200)}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new OkrError(`${name} 返回的不是 JSON：${text.slice(0, 120)}`);
  }
}

export interface OkrKR { id: number; name: string; objective: string; quarter: string }
export interface OkrReport { id: number; objectId: number; week: string; content: string; pct: number }

export async function me(): Promise<{ id: number; name: string }> {
  const u = await call<{ id: number; name: string }>("get_current_user", {});
  return { id: u.id, name: u.name };
}

export async function myKRs(): Promise<OkrKR[]> {
  const h = await call<{ root: { objects: Array<{ id: number; name: string; label: string; parent_id: number; quarter: string }> } }>("list_user_okr_hierarchy", { root_user_id: 0, depth: 0 });
  const objs = h.root.objects;
  const os = new Map(objs.filter((o) => o.label === "O").map((o) => [o.id, o.name]));
  return objs.filter((o) => o.label === "KR").map((o) => ({ id: o.id, name: o.name, objective: os.get(o.parent_id) ?? "", quarter: o.quarter }));
}

export async function quarterReports(ownerId: number, quarter: string, week = ""): Promise<OkrReport[]> {
  const r = await call<{ reports?: Array<{ id: number; object_id: number; week: string; content: string; progress_percentage: number }> }>("list_progress_reports", { owner_id: ownerId, quarter, week });
  return (r.reports ?? []).map((x) => ({ id: x.id, objectId: x.object_id, week: x.week, content: x.content, pct: x.progress_percentage }));
}

export async function submit(r: { objectId: number; week: string; quarter: string; content: string; pct: number }): Promise<number> {
  const res = await call<{ id?: number; report?: { id?: number } }>("create_progress_report", { report_type: "own", object_id: r.objectId, week: r.week, quarter_name: r.quarter, content: r.content, progress_percentage: r.pct });
  const id = res.id ?? res.report?.id;
  if (id) return id;
  // 接口没说成功时回什么，拿不到 id 就回查一次，撤销要靠它
  const mine = await me();
  const hit = (await quarterReports(mine.id, r.quarter, r.week)).find((x) => x.objectId === r.objectId);
  if (!hit) throw new OkrError("提交后在平台上没查到这条");
  return hit.id;
}

export async function remove(reportId: number): Promise<void> {
  await call("delete_progress_report", { report_id: reportId });
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/connectors/okr.test.ts`
Expected: PASS（6 条）

- [ ] **Step 6: 真机只读冒烟**（验证协议，不写数据）

```bash
cd apps/core && npx tsx -e 'import("./src/connectors/okr.ts").then(async (m) => { console.log(await m.me()); console.log((await m.myKRs()).length, "KRs"); })'
```

Expected: 打出你的 id `423` 和 `13 KRs`。若失败，把报错原文记下来修 `post` / `parseRpcBody`，**不要**调 `submit`。

- [ ] **Step 7: typecheck + 提交**

```bash
pnpm typecheck
git add packages/shared/src/index.ts apps/core/src/connectors/okr.ts apps/core/src/connectors/okr.test.ts
git commit -m "OKR 平台客户端：直接调 okr MCP 端点，凭证运行时读 ~/.claude.json"
```

---

### Task 2: 周的口径

**Files:**
- Create: `apps/core/src/agent/weekly/week.ts`
- Test: `apps/core/src/agent/weekly/week.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Week { id: string; start: Date; end: Date } // end = 下周一 00:00，不含
  export function weekOf(anyDay: Date): Week;
  export function targetWeek(now: Date): Week;
  export function parseWeek(id: string): Week | undefined;
  ```

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { parseWeek, targetWeek, weekOf } from "./week.js";

const d = (s: string) => new Date(s); // 本地时区

describe("周的口径", () => {
  it("周一到周日，标识跟平台一致", () => {
    expect(weekOf(d("2026-09-24T10:00")).id).toBe("2026W0921-0927");
    expect(weekOf(d("2026-09-27T23:59")).id).toBe("2026W0921-0927");
    expect(weekOf(d("2026-09-28T00:00")).id).toBe("2026W0928-1004");
  });

  it("跨年周按周一所在年", () => {
    expect(weekOf(d("2027-01-02T12:00")).id).toBe("2026W1228-0103");
  });

  it("周五 16:00 起算本周，之前算上周", () => {
    expect(targetWeek(d("2026-09-25T15:59")).id).toBe("2026W0914-0920");
    expect(targetWeek(d("2026-09-25T16:00")).id).toBe("2026W0921-0927");
    expect(targetWeek(d("2026-09-27T23:59")).id).toBe("2026W0921-0927");
    expect(targetWeek(d("2026-09-28T09:00")).id).toBe("2026W0921-0927");
  });

  it("parseWeek 认回来，格式不对或不是周一就不认", () => {
    const w = parseWeek("2026W0921-0927")!;
    expect(w.start.getDay()).toBe(1);
    expect(w.id).toBe("2026W0921-0927");
    expect(parseWeek("2026W0922-0928")).toBeUndefined();
    expect(parseWeek("本周")).toBeUndefined();
  });
});
```

注意第四条：周一 09:00 → 目标是**上周**（`0921-0927`），因为周一到周五 16:00 前都算补上周。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/agent/weekly/week.test.ts` → FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
export interface Week { id: string; start: Date; end: Date }

const mmdd = (x: Date) => `${String(x.getMonth() + 1).padStart(2, "0")}${String(x.getDate()).padStart(2, "0")}`;
const addDays = (x: Date, n: number) => new Date(x.getFullYear(), x.getMonth(), x.getDate() + n);

export function weekOf(anyDay: Date): Week {
  const start = addDays(anyDay, -((anyDay.getDay() + 6) % 7));
  return { id: `${start.getFullYear()}W${mmdd(start)}-${mmdd(addDays(start, 6))}`, start, end: addDays(start, 7) };
}

export function targetWeek(now: Date): Week {
  const day = now.getDay();
  const thisWeek = (day === 5 && now.getHours() >= 16) || day === 6 || day === 0;
  return weekOf(thisWeek ? now : addDays(now, -7));
}

export function parseWeek(id: string): Week | undefined {
  const m = /^(\d{4})W(\d{2})(\d{2})-\d{4}$/.exec(id);
  if (!m) return undefined;
  const start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (start.getDay() !== 1) return undefined;
  const w = weekOf(start);
  return w.id === id ? w : undefined;
}
```

- [ ] **Step 4: 跑测试确认通过** → PASS（4 条）

- [ ] **Step 5: 提交**

```bash
git add apps/core/src/agent/weekly/week.ts apps/core/src/agent/weekly/week.test.ts
git commit -m "OKR 周报：周标识与目标周"
```

---

### Task 3: 收素材

**Files:**
- Create: `apps/core/src/agent/weekly/collect.ts`
- Test: `apps/core/src/agent/weekly/collect.test.ts`

**Interfaces:**
- Consumes: `Week`（Task 2）；`listTasks`（`memory/tasks.ts`）
- Produces:
  ```ts
  export interface Material { id: string; text: string } // g1…/t1…
  export function collectGit(roots: string[], week: Week): Material[];
  export function collectTasks(week: Week): Material[];
  export function collectMaterials(week: Week, roots?: string[]): Material[];
  ```

- [ ] **Step 1: 写失败测试**

```ts
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTask, updateTask } from "../../memory/tasks.js";
import { collectGit, collectTasks } from "./collect.js";
import { weekOf } from "./week.js";

const week = weekOf(new Date());

function repo(root: string, name: string, commits: Array<{ email: string; msg: string; date?: string }>) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
  git("init", "-q");
  for (const [i, c] of commits.entries()) {
    writeFileSync(join(dir, `f${i}`), c.msg);
    git("add", ".");
    const env = { ...process.env, GIT_AUTHOR_DATE: c.date ?? new Date().toISOString(), GIT_COMMITTER_DATE: c.date ?? new Date().toISOString() };
    execFileSync("git", ["-C", dir, "-c", `user.email=${c.email}`, "-c", "user.name=x", "commit", "-q", "-m", c.msg], { env, stdio: "pipe" });
  }
  return dir;
}

describe("收素材", () => {
  it("git：只要自己两个邮箱域、本周的；两层目录都扫", () => {
    const root = mkdtempSync(join(tmpdir(), "ws-"));
    repo(root, "a", [
      { email: "haoran.jing@longbridge.sg", msg: "feat: 出金规则" },
      { email: "someone@else.com", msg: "别人的" },
      { email: "haoran.jing@longbridge-inc.com", msg: "fix: 上个月的", date: "2020-01-01T00:00:00Z" },
    ]);
    repo(join(root, "group"), "b", [{ email: "haoran.jing@longbridge-inc.com", msg: "fix: 表格截断" }]);
    const got = collectGit([root], week).map((m) => m.text);
    expect(got).toHaveLength(2);
    expect(got.some((t) => t.includes("a") && t.includes("feat: 出金规则"))).toBe(true);
    expect(got.some((t) => t.includes("b") && t.includes("fix: 表格截断"))).toBe(true);
  });

  it("任务：本周动过的，排除 ignored 和周报 / 手册任务本身", () => {
    const keep = createTask({ title: "SaaS 计费明细", kind: "meegle", source: { meegleId: "24514104" }, status: "processing" });
    const ign = createTask({ title: "不管了", kind: "verbal", source: {}, status: "understood" });
    updateTask(ign.id, { status: "ignored" });
    createTask({ title: "OKR 周报 · x", kind: "okr_weekly", source: {}, status: "review" });
    const texts = collectTasks(week).map((m) => m.text);
    expect(texts.some((t) => t.includes("SaaS 计费明细") && t.includes("m-24514104"))).toBe(true);
    expect(texts.some((t) => t.includes("不管了") || t.includes("OKR 周报"))).toBe(false);
    expect(keep).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认失败** → FAIL

- [ ] **Step 3: 实现**

```ts
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { listTasks } from "../../memory/tasks.js";
import type { Week } from "./week.js";

export interface Material { id: string; text: string }

const AUTHOR = "haoran\\.jing@longbridge\\(\\.sg\\|-inc\\.com\\)";
const MAX_GIT = 300;

function repos(root: string): string[] {
  const out: string[] = [];
  const dirs = (p: string) => (existsSync(p) ? readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => join(p, e.name)) : []);
  for (const a of dirs(root)) {
    if (existsSync(join(a, ".git"))) out.push(a);
    else for (const b of dirs(a)) if (existsSync(join(b, ".git"))) out.push(b);
  }
  return out;
}

export function collectGit(roots: string[], week: Week): Material[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const dir of roots.flatMap(repos)) {
    let log = "";
    try {
      log = execFileSync("git", ["-C", dir, "log", "--all", `--since=${week.start.toISOString()}`, `--until=${week.end.toISOString()}`, `--author=${AUTHOR}`, "--pretty=format:%H|%ad|%s", "--date=short"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      continue;
    }
    const name = dir.split("/").pop()!;
    for (const l of log.split("\n").filter(Boolean)) {
      const [hash, date, ...subject] = l.split("|");
      if (seen.has(hash!)) continue;
      seen.add(hash!);
      lines.push(`[${name}] ${date} ${subject.join("|")}`);
    }
  }
  return lines.slice(0, MAX_GIT).map((text, i) => ({ id: `g${i + 1}`, text }));
}

export function collectTasks(week: Week): Material[] {
  const from = week.start.toISOString();
  const to = week.end.toISOString();
  return listTasks(["collected", "understood", "processing", "review", "blocked", "done"], 1000)
    .filter((t) => t.updatedAt >= from && t.updatedAt < to && t.kind !== "okr_weekly" && t.kind !== "handbook")
    .map((t, i) => ({
      id: `t${i + 1}`,
      text: [t.title, t.source.meegleId ? `m-${t.source.meegleId}` : "", t.project ? `项目 ${t.project}` : "", t.stage ? `阶段 ${t.stage}` : "", `状态 ${t.status}`, t.report?.summary ? `交付：${t.report.summary.slice(0, 200)}` : ""].filter(Boolean).join(" · "),
    }));
}

export function collectMaterials(week: Week, roots = [join(homedir(), "workspace")]): Material[] {
  return [...collectGit(roots, week), ...collectTasks(week)];
}
```

（`updatedAt` 是 ISO 字符串，可直接比较；若 `Task` 上字段名不同，按 `packages/shared` 里 `Task` 的实际字段改。）

- [ ] **Step 4: 跑测试确认通过** → PASS

- [ ] **Step 5: 提交**

```bash
git add apps/core/src/agent/weekly/collect.ts apps/core/src/agent/weekly/collect.test.ts
git commit -m "OKR 周报：收本周 git 提交和任务"
```

---

### Task 4: 起草与钳制

**Files:**
- Create: `apps/core/src/agent/weekly/draft.ts`
- Test: `apps/core/src/agent/weekly/draft.test.ts`

**Interfaces:**
- Consumes: `Material`（Task 3）、`OkrKR`（Task 1）、`askStream` / `SONNET_MODEL`（`agent/claude.ts`）、`untrusted` / `UNTRUSTED_NOTE`（`agent/fence.ts`）
- Produces:
  ```ts
  export interface KrContext { kr: OkrKR; prevContent: string | null; prevPct: number | null }
  export interface DraftItem { objectId: number; content: string; pct: number; why: string; used: string[] }
  export interface Drafted { items: DraftItem[]; unmatched: string[] }
  export function draftPrompt(krs: KrContext[], materials: Material[]): { system: string; prompt: string };
  export function parseDraft(text: string, krs: KrContext[], materials: Material[]): Drafted | undefined;
  export async function draftWithModel(krs: KrContext[], materials: Material[]): Promise<Drafted>;
  ```

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { draftPrompt, parseDraft, type KrContext } from "./draft.js";

const krs: KrContext[] = [
  { kr: { id: 10, name: "出入金迁移", objective: "O1", quarter: "2026Q3" }, prevContent: "上周做了 A", prevPct: 90 },
  { kr: { id: 11, name: "组件修复", objective: "O2", quarter: "2026Q3" }, prevContent: null, prevPct: null },
];
const mats = [{ id: "g1", text: "[whale-console] fix: 出金" }, { id: "t1", text: "SaaS 计费 · m-24514104" }];

describe("起草钳制", () => {
  it("越权 KR 丢掉、进度不降不超、不存在的素材编号剔除", () => {
    const out = parseDraft(
      "好的：" + JSON.stringify({
        items: [
          { objectId: 10, content: "修了出金", pct: 60, why: "x", used: ["g1", "g99"] },
          { objectId: 11, content: "修组件", pct: 130, why: "y", used: ["t1"] },
          { objectId: 999, content: "别人的", pct: 50, why: "z", used: ["g1"] },
        ],
        unmatched: ["t1", "nope"],
      }),
      krs,
      mats,
    )!;
    expect(out.items).toEqual([
      { objectId: 10, content: "修了出金", pct: 90, why: "x", used: ["g1"] },
      { objectId: 11, content: "修组件", pct: 100, why: "y", used: ["t1"] },
    ]);
    expect(out.unmatched).toEqual(["t1"]);
  });

  it("素材编号剔完为空的条目不算草稿", () => {
    const out = parseDraft(JSON.stringify({ items: [{ objectId: 10, content: "编的", pct: 95, why: "", used: ["g42"] }], unmatched: [] }), krs, mats)!;
    expect(out.items).toEqual([]);
  });

  it("不是 JSON 返回 undefined", () => {
    expect(parseDraft("抱歉我不能", krs, mats)).toBeUndefined();
  });

  it("提示词里素材和上周正文都在围栏里", () => {
    const { system, prompt } = draftPrompt(krs, mats);
    expect(system).toContain("<untrusted>");
    expect(prompt).toContain('<untrusted source="materials">');
    expect(prompt).toContain('<untrusted source="last-week">');
  });
});
```

- [ ] **Step 2: 跑测试确认失败** → FAIL

- [ ] **Step 3: 实现**

```ts
import type { OkrKR } from "../../connectors/okr.js";
import { askStream, SONNET_MODEL } from "../claude.js";
import { UNTRUSTED_NOTE, untrusted } from "../fence.js";
import { config } from "../../config.js";
import type { Material } from "./collect.js";

export interface KrContext { kr: OkrKR; prevContent: string | null; prevPct: number | null }
export interface DraftItem { objectId: number; content: string; pct: number; why: string; used: string[] }
export interface Drafted { items: DraftItem[]; unmatched: string[] }

export function draftPrompt(krs: KrContext[], materials: Material[]): { system: string; prompt: string } {
  const system = [
    "你在替用户起草 OKR 平台上的每周进展（每个 KR 一段）。只输出一个 JSON，不要任何其他文字。",
    '格式：{"items":[{"objectId":数字,"content":"正文","pct":数字,"why":"进度依据一句话","used":["素材编号"]}],"unmatched":["没对上任何 KR 的素材编号"]}',
    "正文风格对齐上周：一段话，列本周交付了什么、修了什么，带工单号（m-xxxx）。只写素材里有的事，不编、不夸大；没有素材支撑的 KR 不要出现在 items 里。",
    "进度默认沿用上周；只有素材明确显示 KR 里列的事项这周完成了才上调，并在 why 里说清是哪几项；不要下调。",
    "每条 items 的 used 必须列出它依据的素材编号。",
    UNTRUSTED_NOTE,
  ].join("\n");
  const krBlock = krs.map((k) => `- objectId=${k.kr.id}｜O：${k.kr.objective}｜KR：${k.kr.name}｜上周进度：${k.prevPct ?? "无"}`).join("\n");
  const lastWeek = krs.filter((k) => k.prevContent).map((k) => `objectId=${k.kr.id}：${k.prevContent}`).join("\n");
  const prompt = [
    `【我的 KR】\n${krBlock}`,
    lastWeek ? `【上周各 KR 的正文（参考风格和进度）】\n${untrusted("last-week", lastWeek)}` : "",
    `【本周素材】\n${untrusted("materials", materials.map((m) => `${m.id} ${m.text}`).join("\n"))}`,
  ].filter(Boolean).join("\n\n");
  return { system, prompt };
}

export function parseDraft(text: string, krs: KrContext[], materials: Material[]): Drafted | undefined {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return undefined;
  let raw: { items?: unknown; unmatched?: unknown };
  try {
    raw = JSON.parse(m[0]);
  } catch {
    return undefined;
  }
  const byId = new Map(krs.map((k) => [k.kr.id, k]));
  const ids = new Set(materials.map((x) => x.id));
  const items: DraftItem[] = [];
  for (const it of Array.isArray(raw.items) ? raw.items : []) {
    const o = it as Partial<DraftItem>;
    const k = byId.get(Number(o.objectId));
    if (!k || typeof o.content !== "string" || !o.content.trim()) continue;
    const used = (Array.isArray(o.used) ? o.used : []).map(String).filter((x) => ids.has(x));
    if (!used.length) continue;
    const pct = Math.min(100, Math.max(k.prevPct ?? 0, Number.isFinite(Number(o.pct)) ? Number(o.pct) : (k.prevPct ?? 0)));
    items.push({ objectId: k.kr.id, content: o.content.trim(), pct, why: String(o.why ?? ""), used });
  }
  const unmatched = (Array.isArray(raw.unmatched) ? raw.unmatched : []).map(String).filter((x) => ids.has(x));
  return { items, unmatched };
}

export async function draftWithModel(krs: KrContext[], materials: Material[]): Promise<Drafted> {
  const { system, prompt } = draftPrompt(krs, materials);
  let last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    let text = "";
    for await (const ev of askStream(prompt, { systemPrompt: system, cwd: config.dataDir, model: SONNET_MODEL, oneShot: true, label: "okr_weekly" })) {
      if (ev.type === "delta") text += ev.text;
      if (ev.type === "error") throw new Error(ev.message);
    }
    const parsed = parseDraft(text, krs, materials);
    if (parsed) return parsed;
    last = text;
  }
  throw new Error(`模型输出解析不了：${last.slice(0, 300)}`);
}
```

- [ ] **Step 4: 跑测试确认通过** → PASS（4 条）

- [ ] **Step 5: 提交**

```bash
git add apps/core/src/agent/weekly/draft.ts apps/core/src/agent/weekly/draft.test.ts
git commit -m "OKR 周报：起草提示词与解析钳制"
```

---

### Task 5: 起草一轮并建任务

**Files:**
- Create: `apps/core/src/agent/weekly/index.ts`
- Test: `apps/core/src/agent/weekly/index.test.ts`

**Interfaces:**
- Consumes: Task 1–4 全部；`createTask / updateTask / addPending / updatePending / findTaskBySource`；`record`；`state.notices`（`scheduler/index.ts`）；`getCursor / setCursor`（`memory/inbox.ts`）；`userSettings`
- Produces:
  ```ts
  export type WeeklyResult = { taskId: string; drafted: number; empty: number } | { skipped: string };
  export async function draftWeeklyOnce(opts: { week?: Week; manual: boolean }): Promise<WeeklyResult>;
  export async function autoDraftTick(now?: Date): Promise<void>;
  export const OKR_SUBMIT_LABEL: (n: number) => string; // `提交 ${n} 条到 OKR…`
  ```

- [ ] **Step 1: 写失败测试**

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const okr = vi.hoisted(() => ({
  me: vi.fn(async () => ({ id: 9, name: "me" })),
  myKRs: vi.fn(async () => [
    { id: 10, name: "出入金迁移", objective: "O1", quarter: "2026Q3" },
    { id: 11, name: "组件修复", objective: "O2", quarter: "2026Q3" },
    { id: 12, name: "已手填", objective: "O2", quarter: "2026Q3" },
  ]),
  quarterReports: vi.fn(async () => [
    { id: 1, objectId: 10, week: "2026W0914-0920", content: "上周 A", pct: 90 },
    { id: 2, objectId: 12, week: "2026W0921-0927", content: "我自己填的", pct: 50 },
  ]),
}));
vi.mock("../../connectors/okr.js", async (orig) => ({ ...(await orig<typeof import("../../connectors/okr.js")>()), ...okr }));
vi.mock("./collect.js", () => ({ collectMaterials: vi.fn(() => [{ id: "g1", text: "[whale-console] fix: 出金" }]) }));
const draft = vi.hoisted(() => ({ draftWithModel: vi.fn(async () => ({ items: [{ objectId: 10, content: "修了出金", pct: 90, why: "沿用", used: ["g1"] }], unmatched: [] })) }));
vi.mock("./draft.js", () => draft);

const { draftWeeklyOnce } = await import("./index.js");
const { getTask, updatePending } = await import("../../memory/tasks.js");
const { state } = await import("../../scheduler/index.js");
const { parseWeek } = await import("./week.js");
import type { OkrWeeklyDraft } from "@friday/shared";

const W = parseWeek("2026W0921-0927")!;
const draftOf = (id: string) => getTask(id)!.pending!.find((p) => p.type === "okr_submit")!.payload as unknown as OkrWeeklyDraft;

describe("起草一轮", () => {
  beforeEach(() => { state.notices.splice(0); });

  it("有素材的出草稿并勾上，没素材的默认不勾，平台已有的标 existing 不覆盖", async () => {
    const r = await draftWeeklyOnce({ week: W, manual: true });
    if (!("taskId" in r)) throw new Error(r.skipped);
    const t = getTask(r.taskId)!;
    expect(t.kind).toBe("okr_weekly");
    expect(t.status).toBe("review");
    const rows = draftOf(t.id).rows;
    expect(rows.find((x) => x.objectId === 10)).toMatchObject({ state: "draft", checked: true, content: "修了出金", prevPct: 90, used: [{ id: "g1", text: "[whale-console] fix: 出金" }] });
    expect(rows.find((x) => x.objectId === 11)).toMatchObject({ state: "empty", checked: false, content: "" });
    expect(rows.find((x) => x.objectId === 12)).toMatchObject({ state: "existing", checked: false, content: "我自己填的", reportId: 2 });
    expect(state.notices.some((n) => n.taskId === t.id && n.title.includes("2026W0921-0927"))).toBe(true);
  });

  it("重跑同一周：覆盖草稿但保留已提交的行，不另建卡", async () => {
    const first = (await draftWeeklyOnce({ week: W, manual: true })) as { taskId: string };
    const t = getTask(first.taskId)!;
    const action = t.pending!.find((p) => p.type === "okr_submit")!;
    const d = draftOf(t.id);
    d.rows = d.rows.map((x) => (x.objectId === 10 ? { ...x, state: "submitted", reportId: 500, content: "已交的" } : x));
    updatePending(t.id, action.id, { payload: d as unknown as Record<string, unknown> });
    const again = (await draftWeeklyOnce({ week: W, manual: true })) as { taskId: string };
    expect(again.taskId).toBe(t.id);
    expect(draftOf(t.id).rows.find((x) => x.objectId === 10)).toMatchObject({ state: "submitted", reportId: 500, content: "已交的" });
  });

  it("连不上 OKR 平台：照样建卡，卡住并写明原因", async () => {
    const { OkrError } = await import("../../connectors/okr.js");
    okr.myKRs.mockRejectedValueOnce(new OkrError("~/.claude.json 里没有 mcpServers.okr"));
    const r = (await draftWeeklyOnce({ week: parseWeek("2026W0907-0913")!, manual: true })) as { taskId: string };
    const t = getTask(r.taskId)!;
    expect(t.status).toBe("blocked");
    expect(t.progress).toContain("连不上 OKR 平台");
    expect(t.progress).toContain("mcpServers.okr");
  });

  it("自动模式：平台上这周所有 KR 都已经填过了就不建卡", async () => {
    okr.quarterReports.mockResolvedValueOnce([10, 11, 12].map((o, i) => ({ id: 100 + i, objectId: o, week: "2026W0831-0906", content: "x", pct: 1 })));
    const r = await draftWeeklyOnce({ week: parseWeek("2026W0831-0906")!, manual: false });
    expect(r).toEqual({ skipped: "平台上这周的周报已经都填过了" });
  });
});
```

- [ ] **Step 2: 跑测试确认失败** → FAIL

- [ ] **Step 3: 实现 `apps/core/src/agent/weekly/index.ts`**

```ts
import type { OkrRow, OkrWeeklyDraft, Task } from "@friday/shared";
import { OkrError, me, myKRs, quarterReports } from "../../connectors/okr.js";
import { record } from "../../memory/audit.js";
import { getCursor, setCursor } from "../../memory/inbox.js";
import { addPending, createTask, findTaskBySource, updatePending, updateTask } from "../../memory/tasks.js";
import { state } from "../../scheduler/index.js";
import { userSettings } from "../../settings.js";
import { collectMaterials } from "./collect.js";
import { draftWithModel, type KrContext } from "./draft.js";
import { targetWeek, type Week } from "./week.js";

export type WeeklyResult = { taskId: string; drafted: number; empty: number } | { skipped: string };

export const OKR_SUBMIT_LABEL = (n: number) => `提交 ${n} 条到 OKR…`;
const ranKey = (w: Week) => `okr:drafted:${w.id}`;
const submittable = (d: OkrWeeklyDraft) => d.rows.filter((r) => r.checked && r.state !== "existing" && r.state !== "submitted" && r.content.trim()).length;

function cardFor(week: Week): Task | undefined {
  return findTaskBySource((s) => s.okrWeek === week.id, true);
}

function upsertCard(week: Week, patch: Partial<Task>): Task {
  const cur = cardFor(week);
  if (cur) return updateTask(cur.id, patch)!;
  const t = createTask({ title: `OKR 周报 · ${week.id}`, kind: "okr_weekly", source: { okrWeek: week.id }, status: "review" });
  return updateTask(t.id, patch)!;
}

export async function draftWeeklyOnce(opts: { week?: Week; manual: boolean }): Promise<WeeklyResult> {
  const week = opts.week ?? targetWeek(new Date());
  const existingCard = cardFor(week);
  if (existingCard?.status === "done" && !opts.manual) return { skipped: "这周已经提交过了" };
  let krs, mine, reports;
  try {
    [krs, mine] = await Promise.all([myKRs(), me()]);
    reports = krs.length ? await quarterReports(mine.id, krs[0]!.quarter) : [];
  } catch (e) {
    if (!(e instanceof OkrError)) throw e;
    const t = upsertCard(week, { status: "blocked", progress: `连不上 OKR 平台：${e.message}`, pending: [] });
    setCursor(ranKey(week), new Date().toISOString());
    return { taskId: t.id, drafted: 0, empty: 0 };
  }
  const quarter = krs[0]?.quarter ?? "";
  const existing = new Map(reports.filter((r) => r.week === week.id).map((r) => [r.objectId, r]));
  if (!opts.manual && krs.every((k) => existing.has(k.id))) return { skipped: "平台上这周的周报已经都填过了" };
  const prev = (id: number) => reports.filter((r) => r.objectId === id && r.week < week.id).sort((a, b) => b.week.localeCompare(a.week))[0];
  const ctx: KrContext[] = krs.filter((k) => !existing.has(k.id)).map((k) => ({ kr: k, prevContent: prev(k.id)?.content ?? null, prevPct: prev(k.id)?.pct ?? null }));

  const materials = collectMaterials(week);
  const text = new Map(materials.map((m) => [m.id, m.text]));
  let drafted = { items: [] as Awaited<ReturnType<typeof draftWithModel>>["items"], unmatched: [] as string[] };
  try {
    if (materials.length && ctx.length) drafted = await draftWithModel(ctx, materials);
  } catch (e) {
    const t = upsertCard(week, { status: "blocked", progress: e instanceof Error ? e.message : String(e), pending: [] });
    setCursor(ranKey(week), new Date().toISOString());
    return { taskId: t.id, drafted: 0, empty: 0 };
  }

  const old = existingCard?.pending?.find((p) => p.type === "okr_submit")?.payload as unknown as OkrWeeklyDraft | undefined;
  const kept = new Map((old?.rows ?? []).filter((r) => r.state === "submitted").map((r) => [r.objectId, r]));
  const byKr = new Map(drafted.items.map((i) => [i.objectId, i]));
  const rows: OkrRow[] = krs.map((k) => {
    const base = { objectId: k.id, kr: k.name, objective: k.objective, prevPct: prev(k.id)?.pct ?? null };
    const done = kept.get(k.id);
    if (done) return done;
    const ex = existing.get(k.id);
    if (ex) return { ...base, content: ex.content, pct: ex.pct, why: "平台上这周已经有了", used: [], checked: false, state: "existing", reportId: ex.id };
    const d = byKr.get(k.id);
    if (d) return { ...base, content: d.content, pct: d.pct, why: d.why, used: d.used.map((id) => ({ id, text: text.get(id) ?? "" })), checked: true, state: "draft" };
    return { ...base, content: "", pct: base.prevPct ?? 0, why: "", used: [], checked: false, state: "empty" };
  });
  const draft: OkrWeeklyDraft = { week: week.id, quarter, rows, unmatched: drafted.unmatched.map((id) => ({ id, text: text.get(id) ?? "" })) };
  const nDraft = rows.filter((r) => r.state === "draft").length;
  const nEmpty = rows.filter((r) => r.state === "empty").length;
  const understanding = materials.length
    ? `用本周 ${materials.length} 条素材（git 提交和任务）起草了 ${nDraft} 条，${nEmpty} 条没找到相关工作。`
    : "这周没找到你的 commit 和任务，没调模型；要交的话在下面手写。";

  const t = upsertCard(week, { status: "review", understanding, progress: undefined });
  const action = t.pending?.find((p) => p.type === "okr_submit");
  const payload = draft as unknown as Record<string, unknown>;
  if (action) updatePending(t.id, action.id, { payload, label: OKR_SUBMIT_LABEL(submittable(draft)) });
  else addPending(t.id, { type: "okr_submit", label: OKR_SUBMIT_LABEL(submittable(draft)), detail: `提交 ${week.id} 的 OKR 周报`, payload });
  record({ taskId: t.id, action: "okr_weekly_drafted", why: opts.manual ? "你让 Friday 起草周报" : "每周自动起草", how: understanding, evidence: { week: week.id, materials: materials.length, drafted: nDraft, empty: nEmpty }, risk: "read" });
  setCursor(ranKey(week), new Date().toISOString());
  state.notices.push({ title: `OKR 周报草稿好了 · ${week.id}`, body: understanding, taskId: t.id });
  return { taskId: t.id, drafted: nDraft, empty: nEmpty };
}

export async function autoDraftTick(now = new Date()): Promise<void> {
  if (!userSettings().okrWeekly) return;
  const week = targetWeek(now);
  if (getCursor(ranKey(week)) || cardFor(week)) return;
  await draftWeeklyOnce({ week, manual: false });
}
```

（`userSettings().okrWeekly` 在 Task 7 才加；本 Task 先在 `apps/core/src/settings.ts` 的 `UserSettings`、`DEFAULTS`（`okrWeekly: true`）、读取归一化（`okrWeekly: typeof raw.okrWeekly === "boolean" ? raw.okrWeekly : DEFAULTS.okrWeekly`）、写入（`if (patch.okrWeekly !== undefined) raw.okrWeekly = patch.okrWeekly;`）四处补上，照 `learnHistory` 那四行写。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/agent/weekly/index.test.ts` → PASS（4 条）

- [ ] **Step 5: typecheck + 提交**

```bash
pnpm typecheck
git add apps/core/src/agent/weekly/index.ts apps/core/src/agent/weekly/index.test.ts apps/core/src/settings.ts
git commit -m "OKR 周报：起草一轮落成审核任务，重跑保留已提交的行"
```

---

### Task 6: 提交、改草稿、撤销、HTTP 入口

**Files:**
- Create: `apps/core/src/agent/weekly/submit.ts`
- Modify: `apps/core/src/agent/pipeline.ts`（`executePending` 里 `handbook_apply` 分支前）
- Modify: `apps/core/src/memory/audit.ts`（`Undo` 联合）
- Modify: `apps/core/src/api/tasks.ts`（新路由 + 撤销分支）
- Test: `apps/core/src/agent/weekly/submit.test.ts`

**Interfaces:**
- Consumes: `submit / remove`（Task 1）、`OKR_SUBMIT_LABEL` / `draftWeeklyOnce`（Task 5）、`parseWeek / targetWeek`（Task 2）
- Produces:
  ```ts
  export async function submitRows(taskId: string, draft: OkrWeeklyDraft): Promise<{ draft: OkrWeeklyDraft; failed: number }>;
  export function mergeEdits(draft: OkrWeeklyDraft, edits: Array<{ objectId: number; content?: string; pct?: number; checked?: boolean }>): OkrWeeklyDraft;
  // Undo 增加 { kind: "delete_okr_reports"; ids: number[] }
  // HTTP：POST /tasks/okr-weekly {week?}  →  WeeklyResult
  //       PUT  /tasks/:id/okr-draft {rows} →  Task
  ```

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it, vi } from "vitest";
import type { OkrWeeklyDraft } from "@friday/shared";

const okr = vi.hoisted(() => ({ submit: vi.fn(), remove: vi.fn(async () => {}) }));
vi.mock("../../connectors/okr.js", async (orig) => ({ ...(await orig<typeof import("../../connectors/okr.js")>()), ...okr }));

const { app } = await import("../../api/index.js");
const { createTask, addPending, getTask } = await import("../../memory/tasks.js");
const { listAudit } = await import("../../memory/audit.js");
const { mergeEdits } = await import("./submit.js");

const row = (objectId: number, over: Partial<OkrWeeklyDraft["rows"][number]> = {}) => ({ objectId, kr: `KR${objectId}`, objective: "O", content: `正文${objectId}`, pct: 50, prevPct: 40, why: "", used: [], checked: true, state: "draft" as const, ...over });

function card(rows: OkrWeeklyDraft["rows"]) {
  const t = createTask({ title: "OKR 周报 · 2026W0921-0927", kind: "okr_weekly", source: { okrWeek: "2026W0921-0927" }, status: "review" });
  const draft: OkrWeeklyDraft = { week: "2026W0921-0927", quarter: "2026Q3", rows, unmatched: [] };
  const withAction = addPending(t.id, { type: "okr_submit", label: "提交", detail: "", payload: draft as unknown as Record<string, unknown> })!;
  return { id: t.id, actionId: withAction.pending![0]!.id };
}
const payloadOf = (id: string) => getTask(id)!.pending!.find((p) => p.type === "okr_submit")!.payload as unknown as OkrWeeklyDraft;

describe("提交 OKR 周报", () => {
  it("只交勾上的草稿；existing 和空正文不交；全成功任务完成，记账可撤销", async () => {
    okr.submit.mockReset().mockResolvedValueOnce(501).mockResolvedValueOnce(502);
    const { id, actionId } = card([row(1), row(2), row(3, { checked: false }), row(4, { state: "existing", reportId: 9 }), row(5, { content: "  " })]);
    const res = await app.request(`/tasks/${id}/approve/${actionId}`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(okr.submit.mock.calls.map((c) => c[0].objectId)).toEqual([1, 2]);
    expect(getTask(id)!.status).toBe("done");
    const ev = listAudit({ taskId: id }).find((e) => e.action === "okr_submit")!;
    expect(ev.reversible).toBe(true);
    const undo = await app.request(`/audit/${ev.id}/undo`, { method: "POST" });
    expect(undo.status).toBe(200);
    expect(okr.remove.mock.calls.map((c) => c[0])).toEqual([501, 502]);
  });

  it("部分失败：成功的记下 reportId 不重交，失败的留在卡上，按钮变重试", async () => {
    okr.submit.mockReset().mockResolvedValueOnce(601).mockRejectedValueOnce(new Error("INVALID_ARGUMENT"));
    const { id, actionId } = card([row(1), row(2)]);
    await app.request(`/tasks/${id}/approve/${actionId}`, { method: "POST" });
    const t = getTask(id)!;
    expect(t.status).toBe("review");
    const d = payloadOf(id);
    expect(d.rows[0]).toMatchObject({ state: "submitted", reportId: 601 });
    expect(d.rows[1]).toMatchObject({ state: "failed", error: "INVALID_ARGUMENT" });
    expect(t.pending!.find((p) => p.type === "okr_submit")!.label).toBe("重试剩下的 1 条");

    okr.submit.mockReset().mockResolvedValueOnce(602);
    const retry = getTask(id)!.pending!.find((p) => p.type === "okr_submit")!;
    await app.request(`/tasks/${id}/approve/${retry.id}`, { method: "POST" });
    expect(okr.submit.mock.calls.map((c) => c[0].objectId)).toEqual([2]);
    expect(getTask(id)!.status).toBe("done");
  });

  it("PUT okr-draft 逐字段合并，进度钳在 0–100，重算按钮文案", async () => {
    const { id } = card([row(1), row(2)]);
    const res = await app.request(`/tasks/${id}/okr-draft`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ rows: [{ objectId: 1, content: "改过的" }, { objectId: 2, checked: false, pct: 130 }] }) });
    expect(res.status).toBe(200);
    const d = payloadOf(id);
    expect(d.rows[0]).toMatchObject({ content: "改过的", pct: 50, checked: true });
    expect(d.rows[1]).toMatchObject({ checked: false, pct: 100 });
    expect(getTask(id)!.pending![0]!.label).toBe("提交 1 条到 OKR…");
  });

  it("mergeEdits 不让改 existing / submitted 的行", () => {
    const d: OkrWeeklyDraft = { week: "w", quarter: "q", rows: [row(1, { state: "submitted", reportId: 1 }), row(2, { state: "existing" })], unmatched: [] };
    const out = mergeEdits(d, [{ objectId: 1, content: "x", checked: true }, { objectId: 2, content: "y", checked: true }]);
    expect(out.rows.map((r) => r.content)).toEqual(["正文1", "正文2"]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败** → FAIL

- [ ] **Step 3: 实现 `apps/core/src/agent/weekly/submit.ts`**

```ts
import type { OkrWeeklyDraft } from "@friday/shared";
import { submit } from "../../connectors/okr.js";
import { record } from "../../memory/audit.js";

const LOCKED = new Set(["existing", "submitted"]);

export function mergeEdits(draft: OkrWeeklyDraft, edits: Array<{ objectId: number; content?: string; pct?: number; checked?: boolean }>): OkrWeeklyDraft {
  const by = new Map(edits.map((e) => [e.objectId, e]));
  return {
    ...draft,
    rows: draft.rows.map((r) => {
      const e = by.get(r.objectId);
      if (!e || LOCKED.has(r.state)) return r;
      return {
        ...r,
        ...(typeof e.content === "string" ? { content: e.content } : {}),
        ...(typeof e.pct === "number" && Number.isFinite(e.pct) ? { pct: Math.min(100, Math.max(0, e.pct)) } : {}),
        ...(typeof e.checked === "boolean" ? { checked: e.checked } : {}),
      };
    }),
  };
}

export async function submitRows(taskId: string, draft: OkrWeeklyDraft): Promise<{ draft: OkrWeeklyDraft; failed: number }> {
  const rows = [...draft.rows];
  const sent: Array<{ objectId: number; reportId: number }> = [];
  for (const [i, r] of rows.entries()) {
    if (!r.checked || LOCKED.has(r.state) || !r.content.trim()) continue;
    try {
      const reportId = await submit({ objectId: r.objectId, week: draft.week, quarter: draft.quarter, content: r.content.trim(), pct: r.pct });
      rows[i] = { ...r, state: "submitted", reportId, error: undefined };
      sent.push({ objectId: r.objectId, reportId });
    } catch (e) {
      rows[i] = { ...r, state: "failed", error: e instanceof Error ? e.message : String(e) };
    }
  }
  if (sent.length) {
    record({
      taskId,
      action: "okr_submit",
      why: "你审核通过",
      how: `提交了 ${draft.week} 的 ${sent.length} 条周报到 OKR 平台`,
      evidence: { week: draft.week, reports: sent },
      risk: "reversible",
      status: "approved",
      undo: { kind: "delete_okr_reports", ids: sent.map((s) => s.reportId) },
    });
  }
  return { draft: { ...draft, rows }, failed: rows.filter((r) => r.state === "failed").length };
}
```

- [ ] **Step 4: 接进 `executePending`**

`apps/core/src/agent/pipeline.ts`，在 `} else if (action.type === "handbook_apply") {` 之前插入：

```ts
    } else if (action.type === "okr_submit") {
      const { submitRows } = await import("./weekly/submit.js");
      const { draft, failed } = await submitRows(taskId, action.payload as unknown as OkrWeeklyDraft);
      if (failed) {
        // 部分失败不抛：抛了会把旧 payload 放回去，已经交成功的会被当成没交再交一遍
        const cur = getTask(taskId)!;
        return updateTask(taskId, { status: "review", pending: [...(cur.pending ?? []), { ...action, label: `重试剩下的 ${failed} 条`, payload: draft as unknown as Record<string, unknown> }] })!;
      }
      updateTask(taskId, { progress: `已提交 ${draft.rows.filter((r) => r.state === "submitted").length} 条到 OKR 平台（${draft.week}）` });
```

文件顶部 `import type { Task } from "@friday/shared";` 改成 `import type { OkrWeeklyDraft, Task } from "@friday/shared";`。

- [ ] **Step 5: 撤销类型与路由**

`apps/core/src/memory/audit.ts` 的 `Undo` 联合加一项：

```ts
  | { kind: "delete_okr_reports"; ids: number[] }
```

`apps/core/src/api/tasks.ts`：顶部加

```ts
import { mergeEdits } from "../agent/weekly/submit.js";
import { OKR_SUBMIT_LABEL, draftWeeklyOnce } from "../agent/weekly/index.js";
import { parseWeek } from "../agent/weekly/week.js";
import { remove as removeOkrReport } from "../connectors/okr.js";
import type { OkrWeeklyDraft } from "@friday/shared";
```

在 `.post("/tasks/learn-history", …)` 之后加：

```ts
  .post("/tasks/okr-weekly", async (c) => {
    const { week } = (await c.req.json().catch(() => ({}))) as { week?: string };
    const w = week ? parseWeek(week) : undefined;
    if (week && !w) return c.json({ error: "week 格式应为 2026W0921-0927，且从周一开始" }, 400);
    return c.json(await draftWeeklyOnce({ week: w, manual: true }));
  })
  .put("/tasks/:id/okr-draft", async (c) => {
    const t = getTask(c.req.param("id"));
    const action = t?.pending?.find((p) => p.type === "okr_submit");
    if (!t || !action) return c.json({ error: "这条任务没有待提交的周报" }, 404);
    const { rows } = (await c.req.json().catch(() => ({}))) as { rows?: Array<{ objectId: number; content?: string; pct?: number; checked?: boolean }> };
    if (!Array.isArray(rows)) return c.json({ error: "rows 必须是数组" }, 400);
    const draft = mergeEdits(action.payload as unknown as OkrWeeklyDraft, rows);
    const n = draft.rows.filter((r) => r.checked && r.state !== "existing" && r.state !== "submitted" && r.content.trim()).length;
    return c.json(updatePending(t.id, action.id, { payload: draft as unknown as Record<string, unknown>, label: action.label.startsWith("重试") ? action.label : OKR_SUBMIT_LABEL(n) }));
  })
```

在撤销路由里 `if (plan.kind === "restore_memory") {` 之前加：

```ts
    if (plan.kind === "delete_okr_reports") {
      try {
        for (const id of plan.ids) await removeOkrReport(id);
      } catch (e) {
        return c.json({ error: `删不掉（报告被锁定就只能去平台上改）：${e instanceof Error ? e.message : String(e)}` }, 409);
      }
      setEventStatus(c.req.param("id"), "undone");
      return c.json({ ok: true });
    }
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run src/agent/weekly/submit.test.ts` → PASS（4 条）

- [ ] **Step 7: 全量 core 测试 + typecheck + 提交**

```bash
pnpm typecheck && pnpm test
git add apps/core/src/agent/weekly/submit.ts apps/core/src/agent/weekly/submit.test.ts apps/core/src/agent/pipeline.ts apps/core/src/memory/audit.ts apps/core/src/api/tasks.ts
git commit -m "OKR 周报：审核通过后逐条提交，部分失败可重试，操作记录可撤销"
```

---

### Task 7: 定时、开关、会话工具、系统提示

**Files:**
- Modify: `apps/core/src/scheduler/index.ts`
- Modify: `apps/core/src/api/settings.ts`
- Modify: `apps/core/src/agent/tools.ts`
- Modify: `apps/core/src/agent/prompt.ts`
- Test: `apps/core/src/agent/weekly/index.test.ts`（追加一条）

**Interfaces:**
- Consumes: `autoDraftTick` / `draftWeeklyOnce`（Task 5）、`parseWeek`（Task 2）

- [ ] **Step 1: 追加失败测试**（`index.test.ts` 末尾）

```ts
describe("自动起草", () => {
  it("开关关掉不跑；跑过一次同一周不再跑", async () => {
    const { autoDraftTick } = await import("./index.js");
    const { updateSettings } = await import("../../settings.js");
    const friday = new Date(2026, 7, 28, 17, 0); // 2026-08-28 周五 17:00 → 2026W0824-0830
    draft.draftWithModel.mockClear();
    updateSettings({ okrWeekly: false });
    await autoDraftTick(friday);
    expect(draft.draftWithModel).toHaveBeenCalledTimes(0);
    updateSettings({ okrWeekly: true });
    await autoDraftTick(friday);
    await autoDraftTick(friday);
    expect(draft.draftWithModel).toHaveBeenCalledTimes(1);
  });
});
```

（`updateSettings` 是 `settings.ts` 里给 `PUT /settings` 用的写入函数；名字不同就用实际导出的那个。）

- [ ] **Step 2: 跑测试确认失败**（`okrWeekly` 还不能经 settings 写入时失败；若已通过，检查断言确实跑到）

- [ ] **Step 3: 接调度器**

`apps/core/src/scheduler/index.ts` 顶部加 `import { autoDraftTick } from "../agent/weekly/index.js";`，在 `sweepTick` 那段之后加：

```ts
  const okrTick = async () => {
    await autoDraftTick().catch((e) => console.error(`[okr] 起草失败：${e instanceof Error ? e.message : e}`));
    setTimeout(okrTick, 30 * 60_000).unref();
  };
  setTimeout(okrTick, 60_000).unref();
```

（若 `weekly/index.ts` 从 `scheduler/index.ts` 导入 `state` 造成循环导入报错，把这里改成 `const { autoDraftTick } = await import("../agent/weekly/index.js")` 放进 `okrTick` 里。）

- [ ] **Step 4: 设置接口**

`apps/core/src/api/settings.ts` 的 zod 对象里 `learnHistory: z.boolean().optional(),` 后加 `okrWeekly: z.boolean().optional(),`。

- [ ] **Step 5: 会话工具**

`apps/core/src/agent/tools.ts` 顶部加 `import { draftWeeklyOnce } from "./weekly/index.js";` 和 `import { parseWeek } from "./weekly/week.js";`，在 `learn_history` 工具之后加：

```ts
    tool(
      "okr_weekly",
      "起草 OKR 平台上的周报：用本周 git 提交和任务，按用户每个 KR 各写一段进展和建议进度，挂成一张审核卡。用户说“填周报”“写 OKR 周报”“补上周的周报”时用。不会直接提交，用户在卡上改完点提交才会写到平台。要补某一周就传 week（如 2026W0914-0920）。",
      { week: z.string().optional().describe("周标识，如 2026W0921-0927；不传按周五 16:00 前算上周、之后算本周") },
      async ({ week }) => {
        const w = week ? parseWeek(week) : undefined;
        if (week && !w) return text("week 格式不对，应为 2026W0921-0927 这种、从周一开始。");
        const r = await draftWeeklyOnce({ week: w, manual: true });
        return text("skipped" in r ? `没起草：${r.skipped}` : `起草好了：${r.drafted} 条有草稿，${r.empty} 条没找到相关工作。已挂成审核卡（${r.taskId.slice(0, 8)}），在任务里改完点「提交」才会写到 OKR 平台。`);
      },
    ),
```

- [ ] **Step 6: 系统提示**

`apps/core/src/agent/prompt.ts` 里「用户问某个项目的状态…」那一句之后加一条：

```ts
    "用户要填周报、写 OKR 周报时用 okr_weekly 起草，建好卡让用户去审；你能起草和提交 OKR 周报，不要说做不了，也不要把素材贴给用户让他自己填。",
```

- [ ] **Step 7: 跑测试 + typecheck + 提交**

```bash
cd apps/core && npx vitest run src/agent/weekly && cd ../.. && pnpm typecheck && pnpm test
git add apps/core/src/scheduler/index.ts apps/core/src/api/settings.ts apps/core/src/agent/tools.ts apps/core/src/agent/prompt.ts apps/core/src/agent/weekly/index.test.ts
git commit -m "OKR 周报：每周自动起草、设置开关、会话工具 okr_weekly"
```

---

### Task 8: 前端审核卡与设置

**Files:**
- Create: `apps/desktop/src/views/OkrWeekly.tsx`
- Modify: `apps/desktop/src/views/Board.tsx`
- Modify: `apps/desktop/src/lib/core.ts`
- Modify: `apps/desktop/src/views/Settings.tsx`
- Modify: `apps/desktop/src/styles.css`

**Interfaces:**
- Consumes: `PUT /tasks/:id/okr-draft`、`POST /tasks/okr-weekly`（Task 6）、`OkrWeeklyDraft`（Task 1）
- Produces:
  ```ts
  // core.ts
  export async function saveOkrDraft(id: string, rows: Array<{ objectId: number; content?: string; pct?: number; checked?: boolean }>): Promise<Task>;
  export async function okrWeeklyNow(week?: string): Promise<{ taskId?: string; drafted?: number; empty?: number; skipped?: string }>;
  // OkrWeekly.tsx
  export function OkrWeekly(props: { t: Task }): JSX.Element | null;
  export function flushOkrDraft(taskId: string): Promise<void>;
  ```

- [ ] **Step 1: 客户端函数**（`lib/core.ts`，放在 `learnHistory` 旁边）

```ts
export async function saveOkrDraft(id: string, rows: Array<{ objectId: number; content?: string; pct?: number; checked?: boolean }>): Promise<Task> {
  const res = await fetch(`${await coreBaseUrl()}/tasks/${encodeURIComponent(id)}/okr-draft`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ rows }) });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `core 返回 ${res.status}`);
  return res.json();
}

export async function okrWeeklyNow(week?: string): Promise<{ taskId?: string; drafted?: number; empty?: number; skipped?: string }> {
  const res = await fetch(`${await coreBaseUrl()}/tasks/okr-weekly`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(week ? { week } : {}) });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `core 返回 ${res.status}`);
  return res.json();
}
```

- [ ] **Step 2: `views/OkrWeekly.tsx`**

```tsx
import { useEffect, useRef, useState } from "react";
import type { OkrRow, OkrWeeklyDraft, Task } from "@friday/shared";
import { saveOkrDraft } from "../lib/core";

type Edit = { objectId: number; content?: string; pct?: number; checked?: boolean };

// 提交前要等最后一次编辑落盘，不然交出去的是防抖里还没存的旧草稿
const queued = new Map<string, { edits: Map<number, Edit>; timer: number; flush: () => Promise<void> }>();

export function flushOkrDraft(taskId: string): Promise<void> {
  const q = queued.get(taskId);
  if (!q) return Promise.resolve();
  window.clearTimeout(q.timer);
  return q.flush();
}

function queueEdit(taskId: string, e: Edit) {
  const q = queued.get(taskId) ?? { edits: new Map<number, Edit>(), timer: 0, flush: async () => {} };
  q.edits.set(e.objectId, { ...q.edits.get(e.objectId), ...e });
  q.flush = async () => {
    queued.delete(taskId);
    await saveOkrDraft(taskId, [...q.edits.values()]);
    window.dispatchEvent(new Event("friday:tasks-changed"));
  };
  window.clearTimeout(q.timer);
  q.timer = window.setTimeout(() => void q.flush(), 400);
  queued.set(taskId, q);
}

const STATE_NOTE: Partial<Record<OkrRow["state"], string>> = { existing: "平台上这周已经有了，不会覆盖", submitted: "已提交", failed: "提交失败" };

export function OkrWeekly({ t }: { t: Task }) {
  const action = t.pending?.find((p) => p.type === "okr_submit");
  const server = action?.payload as unknown as OkrWeeklyDraft | undefined;
  const [rows, setRows] = useState<OkrRow[]>(server?.rows ?? []);
  const lastServer = useRef(server);
  useEffect(() => {
    if (server && server !== lastServer.current && !queued.has(t.id)) setRows(server.rows);
    lastServer.current = server;
  }, [server, t.id]);
  if (!server) return t.progress ? <div className="fx__text">{t.progress}</div> : null;

  const edit = (objectId: number, patch: Omit<Edit, "objectId">) => {
    setRows((rs) => rs.map((r) => (r.objectId === objectId ? { ...r, ...patch } : r)));
    queueEdit(t.id, { objectId, ...patch });
  };
  const withWork = rows.filter((r) => r.state !== "empty" || r.checked);
  const empty = rows.filter((r) => r.state === "empty" && !r.checked);
  const byO = [...new Set(withWork.map((r) => r.objective))];

  const Row = (r: OkrRow) => {
    const locked = r.state === "existing" || r.state === "submitted";
    return (
      <div key={r.objectId} className={`okr__row okr__row--${r.state}`}>
        <label className="okr__head">
          <input type="checkbox" checked={r.checked} disabled={locked} onChange={(e) => edit(r.objectId, { checked: e.target.checked })} />
          <span className="okr__kr" title={r.kr}>{r.kr}</span>
          {STATE_NOTE[r.state] && <span className="okr__state">{STATE_NOTE[r.state]}{r.error ? `：${r.error}` : ""}</span>}
        </label>
        <textarea className="okr__text" value={r.content} readOnly={locked} rows={3} placeholder="这周在这个 KR 上做了什么" onChange={(e) => edit(r.objectId, { content: e.target.value })} />
        <div className="okr__meta">
          <input className="okr__pct" type="number" min={0} max={100} value={r.pct} readOnly={locked} onChange={(e) => edit(r.objectId, { pct: Number(e.target.value) })} aria-label="进度百分比" />
          <span>%</span>
          <span className="okr__why">{r.prevPct !== null ? `上周 ${r.prevPct}` : "上周没填"}{r.why ? ` · 依据：${r.why}` : ""}</span>
        </div>
        {r.used.length > 0 && (
          <details className="okr__used">
            <summary>用到的素材 {r.used.length} 条</summary>
            <ul>{r.used.map((u) => <li key={u.id}>{u.text}</li>)}</ul>
          </details>
        )}
      </div>
    );
  };

  return (
    <div className="okr">
      {byO.map((o) => (
        <section key={o} className="okr__group">
          <span className="k">{o}</span>
          {withWork.filter((r) => r.objective === o).map(Row)}
        </section>
      ))}
      {empty.length > 0 && (
        <section className="okr__group">
          <span className="k">本周没找到相关工作（勾上可以手写补交）</span>
          {empty.map((r) => (
            <label key={r.objectId} className="okr__head okr__head--empty">
              <input type="checkbox" checked={false} onChange={() => edit(r.objectId, { checked: true })} />
              <span className="okr__kr" title={r.kr}>{r.kr}</span>
            </label>
          ))}
        </section>
      )}
      {server.unmatched.length > 0 && (
        <details className="okr__used">
          <summary>没对上任何 KR 的工作 {server.unmatched.length} 条</summary>
          <ul>{server.unmatched.map((u) => <li key={u.id}>{u.text}</li>)}</ul>
        </details>
      )}
    </div>
  );
}
```

- [ ] **Step 3: 接进 `Board.tsx`**

1. 顶部 `import { OkrWeekly, flushOkrDraft } from "./OkrWeekly";`
2. `consequence()` 里 `if (a.type === "start_job") {` 之前加：

```ts
  if (a.type === "okr_submit") {
    return `以你的身份提交到 OKR 平台 ${String(a.payload.week ?? "")}；可以在操作记录里撤销（会删掉这几条）。`;
  }
```

3. Focus 里 `primary` 的三元链中，`: first\n    ? isMessage` 这一段改成先判 okr：

```ts
    : first
    ? first.type === "okr_submit"
      ? { label: first.label, run: async () => { await flushOkrDraft(t.id); await taskApprove(t.id, first.id); } }
      : isMessage
      ? { /* 原样保留 */ }
      : { /* 原样保留「通过并执行」 */ }
```
4. Focus 的回车 `useEffect` 里 `if (!primary || !active) return;` 改成 `if (!primary || !active || first?.type === "okr_submit") return;`，并把 `first?.type` 加进依赖数组。注释一行：`// 周报一次写十几条到平台，只认点按钮`。
5. `<div className={\`fx__grid …\`}>…</div>` 整块外面包一层：`{t.kind === "okr_weekly" ? <OkrWeekly t={t} /> : (<div className=…>…</div>)}`。

- [ ] **Step 4: 样式**（`styles.css` 末尾，只用现有 token）

```css
.okr { display: flex; flex-direction: column; gap: var(--s-6); }
.okr__group { display: flex; flex-direction: column; gap: var(--s-4); }
.okr__row { display: flex; flex-direction: column; gap: var(--s-2); padding-bottom: var(--s-4); border-bottom: 1px solid var(--line-1); }
.okr__row--existing, .okr__row--submitted { opacity: .7; }
.okr__head { display: flex; align-items: center; gap: var(--s-2); font-size: var(--t-body); color: var(--fg-1); }
.okr__head--empty { color: var(--fg-3); }
.okr__kr { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
.okr__state { font-size: var(--t-xs); color: var(--fg-3); }
.okr__row--failed .okr__state { color: var(--bad); }
.okr__text { width: 100%; resize: vertical; font: inherit; font-size: var(--t-body); color: var(--fg-1); background: var(--bg-2); border: 1px solid var(--line-2); border-radius: var(--r-sm); padding: var(--s-2) var(--s-3); }
.okr__text:focus-visible, .okr__pct:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--ring); }
.okr__meta { display: flex; align-items: center; gap: var(--s-2); font-size: var(--t-sm); color: var(--fg-3); }
.okr__pct { width: 4.5em; font: inherit; font-variant-numeric: tabular-nums; color: var(--fg-1); background: var(--bg-2); border: 1px solid var(--line-2); border-radius: var(--r-sm); padding: 2px var(--s-2); }
.okr__why { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.okr__used { font-size: var(--t-sm); color: var(--fg-3); }
.okr__used ul { margin: var(--s-2) 0 0; padding-left: 1.2em; }
```

（若某个 token 名在 `:root` 里不存在，换成 `styles.css` 里同层级已有的那个，别写字面量颜色。）

- [ ] **Step 5: 设置页**（`Settings.tsx`，照「项目手册」分组里 `learnHistory` 开关 + 「现在学一轮」按钮的写法）

新增一个分组「OKR 周报」：一行开关 `okrWeekly`（hint：「每周五 16:00 后用本周 git 提交和任务起草，挂成审核卡，你点了才提交」），一行按钮「现在起草一份」→ `okrWeeklyNow()`，结果文案：`skipped` 就显示原因，否则「起草好了：N 条，去任务里审」。

- [ ] **Step 6: typecheck**

Run: `pnpm typecheck` → 通过

- [ ] **Step 7: 浏览器验证**（CLAUDE.md「验收方式」）

```bash
D=$(mktemp -d); echo '{"mcpServers":{"okr":{"url":"http://127.0.0.1:9/mcp","headers":{}}}}' > $D/claude.json
FRIDAY_PORT=7791 FRIDAY_DATA_DIR=$D FRIDAY_NO_SCHEDULER=1 FRIDAY_CLAUDE_JSON=$D/claude.json pnpm dev:core &
(cd apps/desktop && VITE_FRIDAY_PORT=7791 npx vite --port 1421 --strictPort &)
```

用 sqlite 往 `$D/todos.db` 插一条 `kind='okr_weekly'`、`status='review'`、`pending` 为一个 `okr_submit`（payload 含 3 行：draft / empty / existing）的任务。agent-browser 打开 `http://localhost:1421/`，逐项确认并截图：
- 卡片按 O 分组，draft 行已勾、existing 行只读并标「不会覆盖」、empty 行在「本周没找到」里
- 改正文和进度 → 刷新页面还在（落盘了）
- 改完正文**立刻**（400ms 内）点提交 → 提交失败后查 `$D/todos.db` 里该任务 `okr_submit` 的 payload，那一行 `content` 是改过的（证明 `flushOkrDraft` 先落盘再提交）
- 焦点在 body 上按回车 → **没有**提交（`pending` 仍在）
- 点「提交 1 条到 OKR…」→ 因为端点是 127.0.0.1:9 连不上，行变「提交失败：…」，按钮变「重试剩下的 1 条」
- 后果预览文案出现在按钮上方

- [ ] **Step 8: 提交**

```bash
git add apps/desktop/src
git commit -m "OKR 周报：任务卡上的可编辑周报表、设置页开关与手动起草"
```

---

### Task 9: 文档与真机起草

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: CLAUDE.md 加一节**（放在「从 Claude Code 历史学」之后），要点：定位（Friday 起草、你审、Friday 提交）、凭证读 `~/.claude.json` 的 `mcpServers.okr` 不另存、周的口径与定时、钳制规则（不降进度、不覆盖 existing）、部分失败不抛的原因、撤销删平台报告（被锁定的删不掉）、入口（会话工具 / `POST /tasks/okr-weekly` / 设置页）、`strictMcpConfig` 不动。

- [ ] **Step 2: 全量验证**

```bash
pnpm typecheck && pnpm test
```

Expected: 全部通过，贴出通过数。

- [ ] **Step 3: 提交、合并、打包安装**（在主仓目录操作，见 memory「worktree 合并前先 cd 回主仓」）

```bash
cd /Users/jinghaoran/hr-lys/friday-feat-okr-weekly && git add CLAUDE.md && git commit -m "CLAUDE.md：OKR 周报"
cd /Users/jinghaoran/hr-lys/friday && git merge --ff-only feat/okr-weekly
arch -arm64 /bin/zsh -c 'source ~/.cargo/env && pnpm --filter @friday/desktop tauri build'
# 退出 Friday → 替换 /Applications/Friday.app → 启动
```

- [ ] **Step 4: 真机起草（不提交）**

```bash
curl -s -X POST http://127.0.0.1:7788/tasks/okr-weekly -H 'content-type: application/json' -d '{}'
```

Expected：返回 `taskId`，工作台里出现「OKR 周报 · 2026W0921-0927」审核卡，并弹通知。把草稿质量（每条是否有素材支撑、进度是否没降）汇报给用户，**提交由用户自己点**。
