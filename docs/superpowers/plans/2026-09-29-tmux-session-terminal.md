# 终端内嵌（tmux 持有进程）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把终端从外部 Ghostty 窗口搬进 Friday：tmux 持有进程，xterm.js 在任务详情里渲染；一个根任务 = 一个 worktree = 一个 tmux session；任务详情按「你在做 / Friday 自主」两种形态展示，状态位只取终端里的现实。

**Architecture:** core 新增 `agent/tmux.ts`（tmux 命令薄封装）、`memory/termSessions.ts`（`term_sessions` 表）、`agent/sessions.ts`（开会话 / 加入会话 / 接回 / 准备段回报的编排）、`agent/attach.ts`（node-pty 跑 `tmux attach` 当观众）、`api/sessions.ts`（attach / 流 / 输入 / 窗口 / seen）。启动脚本改成两段：准备段 `claude -p --model sonnet` 按项目规则建 worktree 并写路径文件，干活段 cd 进去起真正的 Claude。前端新增 `Terminal.tsx`、`TaskHeader.tsx`、`TaskDialog.tsx`、`Resources.tsx`，`Board.tsx` 的 deck 从「所有卡片纵向滚动」改成「只渲染选中那一条」。

**Tech Stack:** Node 25 + TypeScript + hono + vitest（core）；React 19 + vite（desktop）；tmux ≥ 3.3（前置依赖）；node-pty 1.1.0；@xterm/xterm 6 + addon-webgl / unicode11 / fit / web-links / clipboard。

**Spec:** `docs/superpowers/specs/2026-09-29-tmux-session-terminal-design.md`；设计稿源文件 `docs/superpowers/specs/2026-09-29-tmux-session-terminal-design/`（`Main / Drawer / Card / States.dc.html`，浏览器直接打开）；在线版 https://claude.ai/artifact/Y379Q3E9qoHrPiysJ6nx5o

**工作目录：** `/Users/jinghaoran/hr-lys/friday-feat-tmux-terminal`（分支 `feat/tmux-terminal`，已建好）。开工前跑一次 `pnpm install`。

## Global Constraints

- 所有 tmux 命令一律 `tmux -L friday -f <dataDir>/tmux.conf …`；会话目标一律精确匹配：会话级 `=<name>`，窗口 / pane 级 `=<name>:` 或 `=<name>:<idx>`。
- 任何进 git 的名字（分支、worktree 目录）不带 `friday`；tmux 会话名 = `<repo>-<id8>`，准备段回报后改为 worktree 目录名（经 `safeName` 清洗）。
- 模型一律写别名：准备段 `--model sonnet`；自主和后台查询 `--model opus`（`HEADLESS_MODEL`）；交互式不传。
- 新表名 **`term_sessions`**（`sessions` 表已被 `/ask` 的日志占用，spec 里写的 `sessions` 表即此表）；HTTP 路由仍用 `/sessions/:id/*`，`:id` = 根任务 id。
- `term_sessions` 不存 `claude_session_id`，用 `jobs.claude_session_id`（已有）。
- 接回会话（resume）**复用原 job 行**（`reviveJob`），和现在 `reopenTerminal` 语义一致，不新建 job。
- tmux 客户端在 xterm 里处于 alt screen，历史在 tmux 自己手里：**不做** `capture-pane` 灌历史，滚轮进 tmux copy-mode；`⌘F` 用 tmux copy-mode 的 `search-backward`，**不用** `@xterm/addon-search`。
- 复制：tmux 选区经 OSC 52 → `@xterm/addon-clipboard` → core `POST /clipboard`（`pbcopy`）；按住 Option 拖选走 xterm 本地选区（`macOptionClickForcesSelection: true`）。
- `turnFinished` 不再往任务会话追加「这轮说完了」，也不再写 `attention: "review"`；`task.progress` 只存最新一条、不拼「之前：」。
- 终端聚焦时 ⌘ 组合归终端层；Friday 全局只留 `⌘N`（会话）、`⌘\`、`⌘↑` / `⌘↓`（切任务）；Friday 搜索从 `⌘K` 改为 `⌘P`。页面上不显示任何快捷键提示。
- 代码默认不写注释，只在 WHY 不明显时写一行；不加「以防万一」的兜底。
- 提交信息用中文，git author 用仓库配置（不加 `-c user.*`），结尾：`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。
- core 验证：`pnpm --filter @friday/core test`、`pnpm --filter @friday/core typecheck`；desktop 验证：`pnpm --filter @friday/desktop typecheck` + 浏览器里对设计稿（spec §12）。
- UI 任务（8、9、10、11、12）完成时按 spec §12 对应小节逐条对图，截图存 `<dataDir>/runs/design-check/<task>-*.png`，在提交说明里写「§12 X 小节 N/N 条已对」。对不上不提交。

## Review Focus

- **tmux 没装**：点「开始做」应得到「内嵌终端需要 tmux：brew install tmux」，任务状态不变、不留 job 行 —— Task 4 测试。
- **对账误收**：tmux 命令失败（不是「没有 server」）时 `listSessionNames` 返回 `undefined`，对账必须什么都不动，否则一次抖动把所有开着的会话标成已关 —— Task 5 测试。
- **缺陷收工杀掉需求的会话**：带 `rootId` 的缺陷 `finishTask` 只改自己，不能 kill 根的 tmux session —— Task 5 测试。
- **准备段失败**：没写出 worktree 文件时，任务标 blocked、会话标 exited 但 tmux session 保留（用户要进去看输出），不能走 `onJobExit` 把交互式任务收成「会话已结束」—— Task 4 测试。
- **中文输入法**：在 xterm 里用拼音输入一句带标点的中文，组合期间按回车上屏不提交、字不丢不重 —— Task 8 手动验证步骤（xterm 无法在 vitest 里测）。

---

## File Structure

**core（新建）**
- `apps/core/src/agent/tmux.ts` —— tmux 命令封装、配置文件、会话名清洗、`TmuxMissingError`
- `apps/core/src/memory/termSessions.ts` —— `term_sessions` 读写与三个时间戳
- `apps/core/src/agent/sessions.ts` —— `resolveRoot` / `openSession` / `sayToSession` / `joinRootSession` / `resumeInSession` / `worktreeReady` / `prepareFailed` / 排队
- `apps/core/src/agent/sessionState.ts` —— 纯函数状态机 + 给 `GET /tasks` 用的 `taskSession`
- `apps/core/src/agent/attach.ts` —— node-pty 跑 `tmux attach` 的观众
- `apps/core/src/api/sessions.ts` —— `/sessions/:id/*`、`/clipboard`、`/terminal/prefs`
- `apps/core/src/api/worktrees.ts` —— 遗留 worktree 列表与手动删除
- `apps/core/src/agent/docTitle.ts` —— 资料链接取标题
- 对应 `*.test.ts`

**core（修改）**
- `memory/schema.ts`、`memory/db.ts`（表与迁移）、`memory/jobs.ts`（`session_id`、`setJobDir`）、`memory/tasks.ts`（`addPending.at`、建任务即建会话）
- `agent/runner.ts`（两段脚本、准备段、接回脚本；删 `launchClaude` / `reopenTerminal` / `focusTerminal`）
- `agent/pipeline.ts`（三个开工入口、`finishTask`、删 `handOffToStory` / `cleanupTaskWorktree`）
- `agent/terminal.ts`（重写：tmux 版 say / 对账 / 关会话）
- `agent/bridge.ts`（`turnFinished`、`friday_done` 不写 attention review、`friday_finish` 描述）
- `agent/slack/queryJob.ts`（删 `spawnHeadless`）
- `agent/tools.ts`（`task_approve` / `task_reject`）
- `api/jobs.ts`、`api/tasks.ts`、`api/health.ts`、`api/index.ts`、`index.ts`、`scheduler/index.ts`
- `connectors/meegle.ts`、`agent/meegle.ts`（docs 数组）
- 删除：`agent/ghostty.ts`

**desktop（新建）**：`src/views/Terminal.tsx`、`src/views/TaskHeader.tsx`、`src/views/TaskDialog.tsx`、`src/views/Resources.tsx`、`src/lib/sessions.ts`
**desktop（修改）**：`src/views/Board.tsx`、`src/views/Thread.tsx`、`src/views/Settings.tsx`、`src/styles.css`、`package.json`

**shared**：`packages/shared/src/index.ts`（`TermSession*`、`SessionState`、`TaskSession`、`TaskDoc`、`PendingAction.at`、`TaskSource.rootId`、`Job.sessionId`、`HealthResponse.tmux`）

---

### Task 1: tmux 封装

**Files:**
- Create: `apps/core/src/agent/tmux.ts`
- Create: `apps/core/src/agent/tmux.test.ts`
- Modify: `apps/core/src/api/health.ts`
- Modify: `packages/shared/src/index.ts`（`HealthResponse`）
- Modify: `apps/core/src/index.ts`

**Interfaces:**
- Produces:
  - `TMUX_SOCKET = "friday"`、`TMUX_CONF: string`、`tmuxConfPath(): string`、`writeTmuxConf(): void`
  - `tmuxArgs(...args: string[]): string[]`
  - `setTmuxRunner(fn: (args: string[]) => Promise<string>): void`（测试注入）
  - `safeName(s: string): string`、`sessionName(repoDir: string, suffix: string): string`
  - `class TmuxMissingError extends Error`
  - `tmuxVersion(): Promise<string | undefined>`
  - `hasSession(name): Promise<boolean>`、`listSessionNames(): Promise<string[] | undefined>`
  - `newSession(name, cwd, script): Promise<void>`、`renameSession(from, to): Promise<boolean>`、`killSession(name): Promise<void>`
  - `sendText(name, text): Promise<void>`
  - `interface TmuxWindow { index: number; name: string; active: boolean }`
  - `listWindows(name): Promise<TmuxWindow[]>`、`newWindow(name, cwd)`、`killWindow(name, index): Promise<boolean>`、`selectWindow(name, index)`、`splitWindow(name, cwd, dir: "h" | "v")`、`searchBack(name, q)`、`clearHistory(name)`

- [ ] **Step 1: 写失败的测试** `apps/core/src/agent/tmux.test.ts`

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { hasSession, killWindow, listSessionNames, listWindows, newSession, safeName, sendText, sessionName, setTmuxRunner, tmuxArgs, TMUX_CONF } from "./tmux.js";

let calls: string[][] = [];
let reply: (args: string[]) => string | Error = () => "";
beforeEach(() => {
  calls = [];
  reply = () => "";
  setTmuxRunner(async (args) => {
    calls.push(args);
    const r = reply(args);
    if (r instanceof Error) throw r;
    return r;
  });
});
const tail = (c: string[]) => c.slice(4);

describe("tmux 封装", () => {
  it("一律走 friday socket 和 Friday 自己的配置文件", () => {
    const a = tmuxArgs("ls");
    expect(a.slice(0, 3)).toEqual(["-L", "friday", "-f"]);
    expect(a[3]).toMatch(/tmux\.conf$/);
    expect(a.slice(4)).toEqual(["ls"]);
  });

  it("配置禁掉前缀、关状态栏、开鼠标、剪贴板走 OSC 52", () => {
    for (const line of ["set -g prefix None", "set -g status off", "set -g mouse on", "set -g set-clipboard on"]) expect(TMUX_CONF).toContain(line);
  });

  it("会话名取仓库目录名，非法字符换成 -", () => {
    expect(sessionName("/Users/me/workspace/fe-wealth-admin/", "3f2a9c1b")).toBe("fe-wealth-admin-3f2a9c1b");
    expect(safeName("repo-feat/a.b:c")).toBe("repo-feat-a-b-c");
  });

  it("建会话：detached、工作目录、zsh 跑脚本", async () => {
    await newSession("repo-1", "/x/repo", "/data/runs/j.sh");
    expect(tail(calls[0]!)).toEqual(["new-session", "-d", "-s", "repo-1", "-c", "/x/repo", "-x", "200", "-y", "50", "/bin/zsh", "/data/runs/j.sh"]);
  });

  it("说话：文本按字面发到精确匹配的会话，再单独发一个回车", async () => {
    await sendText("repo-1", "改一下 $HOME; rm -rf");
    expect(calls.map(tail)).toEqual([
      ["send-keys", "-t", "=repo-1:", "-l", "改一下 $HOME; rm -rf"],
      ["send-keys", "-t", "=repo-1:", "Enter"],
    ]);
  });

  it("has-session 报错就是不在", async () => {
    reply = () => new Error("can't find session: nope");
    expect(await hasSession("nope")).toBe(false);
    reply = () => "";
    expect(await hasSession("repo-1")).toBe(true);
    expect(tail(calls.at(-1)!)).toEqual(["has-session", "-t", "=repo-1"]);
  });

  it("没有 server 时会话列表为空；别的错误返回 undefined，调用方不许据此收尸", async () => {
    reply = () => Object.assign(new Error("exit 1"), { stderr: "no server running on /private/tmp/tmux-501/friday" });
    expect(await listSessionNames()).toEqual([]);
    reply = () => Object.assign(new Error("exit 1"), { stderr: "error connecting to /private/tmp/tmux-501/friday (No such file or directory)" });
    expect(await listSessionNames()).toEqual([]);
    reply = () => Object.assign(new Error("spawn tmux ENOENT"), { code: "ENOENT" });
    expect(await listSessionNames()).toBeUndefined();
    reply = () => "a\nb\n";
    expect(await listSessionNames()).toEqual(["a", "b"]);
  });

  it("窗口列表解析；只剩一个窗口时不关", async () => {
    reply = (a) => (a.includes("list-windows") ? "0|claude|1\n1|zsh|0\n" : "");
    expect(await listWindows("repo-1")).toEqual([{ index: 0, name: "claude", active: true }, { index: 1, name: "zsh", active: false }]);
    expect(await killWindow("repo-1", 1)).toBe(true);
    expect(tail(calls.at(-1)!)).toEqual(["kill-window", "-t", "=repo-1:1"]);
    reply = (a) => (a.includes("list-windows") ? "0|claude|1\n" : "");
    calls = [];
    expect(await killWindow("repo-1", 0)).toBe(false);
    expect(calls.some((c) => c.includes("kill-window"))).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @friday/core exec vitest run src/agent/tmux.test.ts`
Expected: FAIL，`Cannot find module './tmux.js'`

- [ ] **Step 3: 实现** `apps/core/src/agent/tmux.ts`

```ts
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { config } from "../config.js";

const execFileP = promisify(execFile);

export const TMUX_SOCKET = "friday";

export const TMUX_CONF = [
  "set -g prefix None",
  "unbind C-b",
  "set -g mouse on",
  "set -g history-limit 50000",
  "set -g status off",
  'set -g default-terminal "tmux-256color"',
  'set -ga terminal-overrides ",xterm-256color:Tc"',
  "set -s escape-time 0",
  "set -g focus-events on",
  "set -g allow-passthrough on",
  "set -g set-clipboard on",
  "set -g window-size latest",
  "set -g remain-on-exit off",
  "",
].join("\n");

export const tmuxConfPath = (): string => join(config.dataDir, "tmux.conf");

export function writeTmuxConf(): void {
  writeFileSync(tmuxConfPath(), TMUX_CONF);
}

export const tmuxArgs = (...args: string[]): string[] => ["-L", TMUX_SOCKET, "-f", tmuxConfPath(), ...args];

type Runner = (args: string[]) => Promise<string>;
let runner: Runner = async (args) => (await execFileP("tmux", args, { timeout: 5_000 })).stdout;

export function setTmuxRunner(fn: Runner): void {
  runner = fn;
}

const run = (...args: string[]) => runner(tmuxArgs(...args));
const S = (name: string) => `=${name}`;
const W = (name: string, index?: number) => `=${name}:${index ?? ""}`;

export class TmuxMissingError extends Error {
  constructor() {
    super("内嵌终端需要 tmux：brew install tmux");
  }
}

export const safeName = (s: string): string =>
  s.replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 80);

export function sessionName(repoDir: string, suffix: string): string {
  const repo = repoDir.replace(/\/+$/, "").split("/").pop() || "repo";
  return safeName(`${repo}-${suffix}`);
}

export async function tmuxVersion(): Promise<string | undefined> {
  try {
    return (await runner(["-V"])).trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function hasSession(name: string): Promise<boolean> {
  try {
    await run("has-session", "-t", S(name));
    return true;
  } catch {
    return false;
  }
}

export async function listSessionNames(): Promise<string[] | undefined> {
  try {
    return (await run("list-sessions", "-F", "#{session_name}")).split("\n").map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    const msg = `${(e as { stderr?: string }).stderr ?? ""} ${(e as Error).message}`;
    return /no server running|error connecting/.test(msg) ? [] : undefined;
  }
}

export async function newSession(name: string, cwd: string, script: string): Promise<void> {
  await run("new-session", "-d", "-s", name, "-c", cwd, "-x", "200", "-y", "50", "/bin/zsh", script);
}

export async function renameSession(from: string, to: string): Promise<boolean> {
  try {
    await run("rename-session", "-t", S(from), to);
    return true;
  } catch {
    return false;
  }
}

export async function killSession(name: string): Promise<void> {
  await run("kill-session", "-t", S(name)).catch(() => "");
}

// 文本和回车分两次发：连着发 Claude Code 会当成粘贴，回车变成换行不提交
const ENTER_DELAY_MS = 200;

export async function sendText(name: string, text: string): Promise<void> {
  await run("send-keys", "-t", W(name), "-l", text);
  await new Promise((r) => setTimeout(r, ENTER_DELAY_MS));
  await run("send-keys", "-t", W(name), "Enter");
}

export interface TmuxWindow {
  index: number;
  name: string;
  active: boolean;
}

export async function listWindows(name: string): Promise<TmuxWindow[]> {
  const out = await run("list-windows", "-t", S(name), "-F", "#{window_index}|#{window_name}|#{window_active}");
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [i, n, a] = l.split("|");
      return { index: Number(i), name: n ?? "", active: a === "1" };
    });
}

export async function newWindow(name: string, cwd: string): Promise<void> {
  await run("new-window", "-t", W(name), "-c", cwd);
}

export async function killWindow(name: string, index: number): Promise<boolean> {
  if ((await listWindows(name)).length <= 1) return false;
  await run("kill-window", "-t", W(name, index));
  return true;
}

export async function selectWindow(name: string, index: number): Promise<void> {
  await run("select-window", "-t", W(name, index));
}

export async function splitWindow(name: string, cwd: string, dir: "h" | "v"): Promise<void> {
  await run("split-window", dir === "h" ? "-h" : "-v", "-t", W(name), "-c", cwd);
}

export async function searchBack(name: string, q: string): Promise<void> {
  await run("copy-mode", "-t", W(name));
  await run("send-keys", "-t", W(name), "-X", "search-backward", q);
}

export async function clearHistory(name: string): Promise<void> {
  await run("send-keys", "-t", W(name), "C-l");
  await run("clear-history", "-t", W(name));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @friday/core exec vitest run src/agent/tmux.test.ts`
Expected: PASS（8 个）

- [ ] **Step 5: `/health` 带上 tmux 版本，启动时写配置**

`packages/shared/src/index.ts` 的 `HealthResponse` 加一行：

```ts
export interface HealthResponse {
  ok: true;
  version: string;
  uptimeMs: number;
  /** tmux -V 的输出；没装是 null，内嵌终端不可用 */
  tmux: string | null;
}
```

`apps/core/src/api/health.ts`：

```ts
import { Hono } from "hono";
import type { HealthResponse } from "@friday/shared";
import { config } from "../config.js";
import { tmuxVersion } from "../agent/tmux.js";

const startedAt = Date.now();

export const health = new Hono().get("/health", async (c) => {
  const body: HealthResponse = {
    ok: true,
    version: config.version,
    uptimeMs: Date.now() - startedAt,
    tmux: (await tmuxVersion()) ?? null,
  };
  return c.json(body);
});
```

`apps/core/src/index.ts` 在 `initMemory();` 之后加：

```ts
writeTmuxConf();
```

并在顶部 `import { writeTmuxConf } from "./agent/tmux.js";`。

- [ ] **Step 6: 跑全量 core 测试与类型检查**

Run: `pnpm --filter @friday/core test && pnpm --filter @friday/core typecheck`
Expected: 全过（若某处测试断言 `/health` 的精确 JSON，补上 `tmux` 字段）

- [ ] **Step 7: 提交**

```bash
git add apps/core/src/agent/tmux.ts apps/core/src/agent/tmux.test.ts apps/core/src/api/health.ts apps/core/src/index.ts packages/shared/src/index.ts
git commit -m "$(cat <<'EOF'
tmux 封装：friday socket + 独立配置，会话名清洗，窗口与搜索命令

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `term_sessions` 表与 job 归属

**Files:**
- Modify: `apps/core/src/memory/schema.ts`（加表）
- Modify: `apps/core/src/memory/db.ts`（`jobs.session_id` 迁移）
- Modify: `apps/core/src/memory/jobs.ts`（`sessionId`、`setJobDir`）
- Create: `apps/core/src/memory/termSessions.ts`
- Create: `apps/core/src/memory/termSessions.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - shared：`type TermSessionKind = "interactive" | "autonomous" | "query"`、`type TermSessionStatus = "preparing" | "running" | "exited" | "closed"`、`interface TermSession { id; project; repoDir; tmuxName; kind; status; jobId?; worktree?; branch?; lastInputAt?; lastStopAt?; seenAt?; createdAt; updatedAt }`；`Job.sessionId?: string`
  - `createTermSession(input: { id: string; project: string; repoDir: string; tmuxName: string; kind: TermSessionKind; jobId: string }): TermSession`（同 id 已存在则覆盖成新会话）
  - `getTermSession(id): TermSession | undefined`、`termSessionByJob(jobId): TermSession | undefined`、`openTermSessions(): TermSession[]`
  - `updateTermSession(id, patch: Partial<Pick<TermSession, "status" | "jobId" | "worktree" | "branch" | "tmuxName">>): TermSession | undefined`
  - `markInput(id)`、`markStop(id)`、`markSeen(id)`
  - `createJob(input)` 多一个可选 `sessionId`；`setJobDir(id: string, dir: string): void`

- [ ] **Step 1: 写失败的测试** `apps/core/src/memory/termSessions.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { createJob, getJob, setJobDir } from "./jobs.js";
import { createTermSession, getTermSession, markInput, markSeen, markStop, openTermSessions, termSessionByJob, updateTermSession } from "./termSessions.js";

describe("term_sessions", () => {
  it("交互式建出来是 preparing，job 挂上 session_id", () => {
    createJob({ id: "j-ts-1", project: "p", dir: "/r", logPath: "/l", taskId: "root-1", sessionId: "root-1" });
    const s = createTermSession({ id: "root-1", project: "p", repoDir: "/r", tmuxName: "r-root1", kind: "interactive", jobId: "j-ts-1" });
    expect(s).toMatchObject({ status: "preparing", kind: "interactive", tmuxName: "r-root1", jobId: "j-ts-1" });
    expect(s.lastInputAt).toBeTruthy();
    expect(getJob("j-ts-1")?.sessionId).toBe("root-1");
    expect(termSessionByJob("j-ts-1")?.id).toBe("root-1");
  });

  it("后台查询不走准备段，直接 running", () => {
    expect(createTermSession({ id: "q-1", project: "p", repoDir: "/r", tmuxName: "r-q1", kind: "query", jobId: "jq" }).status).toBe("running");
  });

  it("输入 / Stop / 看过 三个时间各记各的", async () => {
    markStop("root-1");
    await new Promise((r) => setTimeout(r, 5));
    markSeen("root-1");
    const s = getTermSession("root-1")!;
    expect(s.lastStopAt).toBeTruthy();
    expect(s.seenAt! > s.lastStopAt!).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    markInput("root-1");
    expect(getTermSession("root-1")!.lastInputAt! > s.seenAt!).toBe(true);
  });

  it("closed 的不在开着的列表里；同一个根再开一次覆盖成新会话", () => {
    updateTermSession("q-1", { status: "closed" });
    expect(openTermSessions().map((s) => s.id)).not.toContain("q-1");
    const again = createTermSession({ id: "q-1", project: "p", repoDir: "/r", tmuxName: "r-q1b", kind: "query", jobId: "jq2" });
    expect(again).toMatchObject({ status: "running", tmuxName: "r-q1b", jobId: "jq2" });
    expect(again.lastStopAt).toBeUndefined();
  });

  it("worktree 建好后 job 的目录跟着换，transcript 路径才找得到", () => {
    setJobDir("j-ts-1", "/r-feat-x");
    expect(getJob("j-ts-1")?.dir).toBe("/r-feat-x");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @friday/core exec vitest run src/memory/termSessions.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 共享类型** 在 `packages/shared/src/index.ts` 的 `Job` 接口里加 `sessionId?: string;`，并在它旁边加：

```ts
export type TermSessionKind = "interactive" | "autonomous" | "query";
export type TermSessionStatus = "preparing" | "running" | "exited" | "closed";

/** 一个根任务的 tmux 会话：根 = worktree = 会话 = 分支 */
export interface TermSession {
  id: string;
  project: string;
  repoDir: string;
  tmuxName: string;
  kind: TermSessionKind;
  status: TermSessionStatus;
  jobId?: string;
  worktree?: string;
  branch?: string;
  lastInputAt?: string;
  lastStopAt?: string;
  seenAt?: string;
  createdAt: string;
  updatedAt: string;
}
```

- [ ] **Step 4: 建表** 在 `apps/core/src/memory/schema.ts` 的 `SCHEMA` 字符串末尾（`stage_signals` 之后）加：

```sql
CREATE TABLE IF NOT EXISTS term_sessions (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  repo_dir TEXT NOT NULL,
  tmux_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('interactive', 'autonomous', 'query')),
  status TEXT NOT NULL CHECK (status IN ('preparing', 'running', 'exited', 'closed')),
  job_id TEXT,
  worktree TEXT,
  branch TEXT,
  last_input_at TEXT,
  last_stop_at TEXT,
  seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

`apps/core/src/memory/db.ts` 的 `migrate()` 里，`task_id` 那行之后加：

```ts
  if (!jobCols.includes("session_id")) d.exec("ALTER TABLE jobs ADD COLUMN session_id TEXT");
```

- [ ] **Step 5: jobs.ts** —— `Row` 加 `session_id: string | null;`，`toJob` 加 `...(r.session_id ? { sessionId: r.session_id } : {}),`；`createJob` 改为：

```ts
export function createJob(input: { id: string; project: string; dir: string; task?: string; conversationId?: string; logPath: string; terminal?: TerminalApp; taskId?: string; sessionId?: string }): Job {
  const startedAt = new Date().toISOString();
  db()
    .prepare("INSERT INTO jobs (id, project, dir, task, conversation_id, status, log_path, started_at, terminal, task_id, session_id) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)")
    .run(input.id, input.project, input.dir, input.task ?? null, input.conversationId ?? null, input.logPath, startedAt, input.terminal ?? userSettings().terminal, input.taskId ?? null, input.sessionId ?? null);
  return getJob(input.id)!;
}

export function setJobDir(id: string, dir: string): void {
  db().prepare("UPDATE jobs SET dir = ? WHERE id = ?").run(dir, id);
}
```

- [ ] **Step 6: 实现** `apps/core/src/memory/termSessions.ts`

```ts
import type { TermSession, TermSessionKind, TermSessionStatus } from "@friday/shared";
import { db } from "./db.js";

interface Row {
  id: string;
  project: string;
  repo_dir: string;
  tmux_name: string;
  kind: TermSessionKind;
  status: TermSessionStatus;
  job_id: string | null;
  worktree: string | null;
  branch: string | null;
  last_input_at: string | null;
  last_stop_at: string | null;
  seen_at: string | null;
  created_at: string;
  updated_at: string;
}

const toSession = (r: Row): TermSession => ({
  id: r.id,
  project: r.project,
  repoDir: r.repo_dir,
  tmuxName: r.tmux_name,
  kind: r.kind,
  status: r.status,
  ...(r.job_id ? { jobId: r.job_id } : {}),
  ...(r.worktree ? { worktree: r.worktree } : {}),
  ...(r.branch ? { branch: r.branch } : {}),
  ...(r.last_input_at ? { lastInputAt: r.last_input_at } : {}),
  ...(r.last_stop_at ? { lastStopAt: r.last_stop_at } : {}),
  ...(r.seen_at ? { seenAt: r.seen_at } : {}),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const now = () => new Date().toISOString();

export function createTermSession(input: { id: string; project: string; repoDir: string; tmuxName: string; kind: TermSessionKind; jobId: string }): TermSession {
  const t = now();
  const status: TermSessionStatus = input.kind === "query" ? "running" : "preparing";
  db()
    .prepare(
      `INSERT INTO term_sessions (id, project, repo_dir, tmux_name, kind, status, job_id, last_input_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET project = excluded.project, repo_dir = excluded.repo_dir, tmux_name = excluded.tmux_name,
         kind = excluded.kind, status = excluded.status, job_id = excluded.job_id, worktree = NULL, branch = NULL,
         last_input_at = excluded.last_input_at, last_stop_at = NULL, seen_at = NULL, updated_at = excluded.updated_at`,
    )
    .run(input.id, input.project, input.repoDir, input.tmuxName, input.kind, status, input.jobId, t, t, t);
  return getTermSession(input.id)!;
}

export function getTermSession(id: string): TermSession | undefined {
  const r = db().prepare("SELECT * FROM term_sessions WHERE id = ?").get(id) as unknown as Row | undefined;
  return r ? toSession(r) : undefined;
}

export function termSessionByJob(jobId: string): TermSession | undefined {
  const r = db().prepare("SELECT * FROM term_sessions WHERE job_id = ?").get(jobId) as unknown as Row | undefined;
  return r ? toSession(r) : undefined;
}

export function openTermSessions(): TermSession[] {
  return (db().prepare("SELECT * FROM term_sessions WHERE status != 'closed' ORDER BY updated_at DESC").all() as unknown as Row[]).map(toSession);
}

const COLS: Record<string, string> = { status: "status", jobId: "job_id", worktree: "worktree", branch: "branch", tmuxName: "tmux_name" };

export function updateTermSession(id: string, patch: Partial<Pick<TermSession, "status" | "jobId" | "worktree" | "branch" | "tmuxName">>): TermSession | undefined {
  const keys = Object.keys(patch).filter((k) => k in COLS) as Array<keyof typeof patch>;
  if (keys.length) {
    db()
      .prepare(`UPDATE term_sessions SET ${keys.map((k) => `${COLS[k]} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((k) => (patch[k] ?? null) as string | null), now(), id);
  }
  return getTermSession(id);
}

const stamp = (col: "last_input_at" | "last_stop_at" | "seen_at") => (id: string) => {
  const t = now();
  db().prepare(`UPDATE term_sessions SET ${col} = ?, updated_at = ? WHERE id = ?`).run(t, t, id);
};

export const markInput = stamp("last_input_at");
export const markStop = stamp("last_stop_at");
export const markSeen = stamp("seen_at");
```

- [ ] **Step 7: 跑测试确认通过**

Run: `pnpm --filter @friday/core exec vitest run src/memory/termSessions.test.ts src/memory/jobs.test.ts src/memory/db.test.ts`
Expected: PASS

- [ ] **Step 8: 类型检查并提交**

Run: `pnpm --filter @friday/core typecheck`

```bash
git add apps/core/src/memory packages/shared/src/index.ts
git commit -m "$(cat <<'EOF'
term_sessions 表：根任务的 tmux 会话，记输入 / Stop / 看过三个时间；job 挂 session_id

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: 两段式启动脚本

**Files:**
- Modify: `apps/core/src/agent/runner.ts`
- Create: `apps/core/src/agent/runner.session.test.ts`

**Interfaces:**
- Consumes: `newSession`（Task 1）、`TermSessionKind`（Task 2）
- Produces:
  - `interface SessionLaunch { id: string; repoDir: string; task?: string; kind: TermSessionKind; project?: string; baseBranch?: string; resumeSessionId?: string }`
  - `worktreeFile(id: string): string`（`<runs>/<id>.worktree`）
  - `prepPrompt(id: string, repoDir: string, base?: string): string`
  - `workCommand(req: SessionLaunch, claudePath: string, port: number, files: ClaudeFiles): string[]`
  - `buildSessionScript(req: SessionLaunch, claudePath: string, port: number, files: ClaudeFiles, prepSettings?: string): string`
  - `writePrepSettings(id: string): string`（返回 settings 路径）
  - `launchInSession(req: SessionLaunch, tmuxName: string): Promise<void>`
  - `writeResumeScript(req: SessionLaunch, cwd: string): Promise<string>`（返回脚本路径）
  - `shellQuote`（改为 export）

- [ ] **Step 1: 写失败的测试** `apps/core/src/agent/runner.session.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { buildSessionScript, prepPrompt, workCommand, worktreeFile } from "./runner.js";
import { FORBIDDEN } from "./guard.js";

const files = { settings: "/d/runs/j.settings.json", mcp: "/d/runs/j.mcp.json" };
const prep = "/d/runs/j.prep.settings.json";

describe("两段式启动脚本", () => {
  it("交互式：先在主仓跑准备段，拿到 worktree 再 cd 进去起干活的 Claude，最后留 shell", () => {
    const s = buildSessionScript({ id: "j", repoDir: "/r/app", task: "改个按钮", kind: "interactive", project: "app" }, "/bin/claude", 7788, files, prep);
    const lines = s.split("\n");
    expect(lines).toContain("cd '/r/app' || exit 1");
    const prepAt = lines.findIndex((l) => l.includes("--model sonnet") && l.includes(prep));
    const cdAt = lines.findIndex((l) => l.startsWith(`cd "$(cat '${worktreeFile("j")}')"`));
    const workAt = lines.findIndex((l) => l.startsWith("script -q"));
    expect(prepAt).toBeGreaterThan(0);
    expect(cdAt).toBeGreaterThan(prepAt);
    expect(workAt).toBeGreaterThan(cdAt);
    expect(s).toContain('"code":2,"phase":"prepare"');
    expect(s).toContain("/jobs/j/worktree");
    expect(lines.at(-2)).toBe("exec /bin/zsh -il");
    expect(lines[workAt]).not.toContain("-p --model");
  });

  it("后台查询不建 worktree：没有准备段，直接在主仓只读跑 -p", () => {
    const s = buildSessionScript({ id: "j", repoDir: "/r/app", task: "查一下", kind: "query" }, "/bin/claude", 7788, files);
    expect(s).not.toContain("--model sonnet");
    expect(s).not.toContain(".worktree");
    expect(s).toContain("-p --model opus");
  });

  it("自主任务：准备段之后干活段用 -p --model opus", () => {
    const s = buildSessionScript({ id: "j", repoDir: "/r/app", task: "修 bug", kind: "autonomous", project: "app" }, "/bin/claude", 7788, files, prep);
    expect(s).toContain("--model sonnet");
    expect(s).toMatch(/script -q .*-p --model opus/);
  });

  it("接回：带 --resume，接不上就新开；追加写日志；带上要说的话", () => {
    const [cmd] = workCommand({ id: "j", repoDir: "/r/app", kind: "interactive", resumeSessionId: "sess-1", task: "顺带改一下" }, "/bin/claude", 7788, files);
    expect(cmd).toContain("script -q -a");
    expect(cmd).toContain("--resume");
    expect(cmd).toContain("sess-1");
    expect(cmd!.split("||").length).toBe(2);
    expect(cmd).toContain("顺带改一下");
  });

  it("准备段提示词：先看项目规则、兄弟目录、基线、不带 friday、写路径文件", () => {
    const p = prepPrompt("j", "/r/app", "feat/base");
    expect(p).toContain("CLAUDE.md");
    expect(p).toContain("../app-<分支简称>");
    expect(p).toContain("feat/base");
    expect(p).toContain(worktreeFile("j"));
    expect(p).toMatch(/不要出现 friday/);
  });

  it("准备段要用的 git 命令不被守卫拦，push 照样拦", () => {
    const blocked = (cmd: string) => FORBIDDEN.some(([p]) => new RegExp(p).test(cmd));
    expect(blocked("git fetch origin")).toBe(false);
    expect(blocked("git worktree add ../app-feat-x -b feat/x origin/main")).toBe(false);
    expect(blocked("git push origin feat/x")).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @friday/core exec vitest run src/agent/runner.session.test.ts`
Expected: FAIL，`buildSessionScript` 等未导出

- [ ] **Step 3: 实现** —— 在 `apps/core/src/agent/runner.ts` 里：把 `const shellQuote = …` 改成 `export const shellQuote = …`；import 里加 `import type { TermSessionKind } from "@friday/shared";` 与 `import { newSession } from "./tmux.js";`；在文件末尾加：

```ts
export interface SessionLaunch {
  id: string;
  repoDir: string;
  task?: string;
  kind: TermSessionKind;
  project?: string;
  baseBranch?: string;
  resumeSessionId?: string;
}

export const worktreeFile = (id: string) => join(runsDir(), `${id}.worktree`);

export function prepPrompt(id: string, repoDir: string, base?: string): string {
  const repo = repoDir.replace(/\/+$/, "").split("/").pop() ?? "repo";
  return [
    `你在 ${repoDir} 这个仓库的主目录里，只做一件事：为接下来的任务准备好分支和 git worktree，然后退出。不要改任何业务代码，不要 push。`,
    "1. 先查这个项目自己的规则：CLAUDE.md、项目 skill、CONTRIBUTING、git worktree list 和现有分支的惯例。项目有规则就照项目的来。",
    `2. 项目没有规则时：分支名按「${BRANCH_RULE}」；worktree 建在主仓的兄弟目录 ../${repo}-<分支简称>（分支名里的 / 换成 -）。`,
    base ? `3. 基线是分支 ${base}：先 git fetch，再从它检出新分支。` : "3. 基线是默认分支：先 git fetch，再从 origin 的默认分支检出新分支。",
    "4. 按项目的方式把依赖装好，让新 worktree 能直接跑起来（前端仓库可以先用 cp -c 从主仓克隆 node_modules，再跑一次 install 补差）。",
    "5. 分支名和 worktree 目录名里都不要出现 friday。",
    `6. 最后把 worktree 的绝对路径（只有路径，一行）写进 ${worktreeFile(id)}，然后结束。`,
    "拿不准时选最保守的做法，不要提问——没人会回答。",
  ].join("\n");
}

export function workCommand(req: SessionLaunch, claudePath: string, port: number, files: ClaudeFiles): string[] {
  const flags = claudeFlags(files, req.kind !== "interactive", req.project);
  const prompt = req.task ? ` ${shellQuote(req.task)}` : "";
  const claude = req.resumeSessionId
    ? `${shellQuote(claudePath)} ${flags} --resume ${shellQuote(req.resumeSessionId)}${prompt} || ${shellQuote(claudePath)} ${flags}${prompt}`
    : `${shellQuote(claudePath)} ${flags}${prompt}`;
  return [
    `script -q ${req.resumeSessionId ? "-a " : ""}${shellQuote(jobLog(req.id))} /bin/zsh -c ${shellQuote(claude)}`,
    "code=$?",
    `curl -s -m 3 -X POST ${shellQuote(`http://127.0.0.1:${port}/jobs/${req.id}/exit`)} -H 'content-type: application/json' -d "{\\"code\\":$code}" >/dev/null 2>&1`,
  ];
}

export function buildSessionScript(req: SessionLaunch, claudePath: string, port: number, files: ClaudeFiles, prepSettings?: string): string {
  const api = (p: string) => shellQuote(`http://127.0.0.1:${port}/jobs/${req.id}/${p}`);
  const wt = shellQuote(worktreeFile(req.id));
  const prepare =
    req.kind === "query"
      ? []
      : [
          `${shellQuote(claudePath)} -p --model sonnet --dangerously-skip-permissions --settings ${shellQuote(prepSettings ?? "")} ${shellQuote(prepPrompt(req.id, req.repoDir, req.baseBranch))}`,
          `if [ ! -s ${wt} ]; then`,
          `  curl -s -m 3 -X POST ${api("exit")} -H 'content-type: application/json' -d '{"code":2,"phase":"prepare"}' >/dev/null 2>&1`,
          "  exec /bin/zsh -il",
          "fi",
          `cd "$(cat ${wt})" || exit 1`,
          `curl -s -m 3 -X POST ${api("worktree")} -H 'content-type: application/json' -d "{\\"path\\":\\"$PWD\\"}" >/dev/null 2>&1`,
        ];
  return [
    "#!/bin/zsh",
    `cd ${shellQuote(req.repoDir)} || exit 1`,
    UNSET_CLAUDE_ENV,
    ...prepare,
    `printf '\\033]0;%s\\007' "$(basename "$PWD")"`,
    ...workCommand(req, claudePath, port, files),
    "exec /bin/zsh -il",
    "",
  ].join("\n");
}

export function writePrepSettings(id: string): string {
  mkdirSync(runsDir(), { recursive: true });
  const guard = join(runsDir(), `${id}.prep.guard.sh`);
  writeFileSync(guard, buildGuardScript());
  chmodSync(guard, 0o755);
  const settings = join(runsDir(), `${id}.prep.settings.json`);
  writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: shellQuote(guard), timeout: 10 }] }] } }, null, 2));
  return settings;
}

export async function launchInSession(req: SessionLaunch, tmuxName: string): Promise<void> {
  const claudePath = await findClaude();
  const files = writeHookFiles(req.id, req.kind === "autonomous", req.kind === "query");
  const prep = req.kind === "query" ? undefined : writePrepSettings(req.id);
  const script = join(runsDir(), `${req.id}.sh`);
  writeFileSync(script, buildSessionScript(req, claudePath, config.port, files, prep));
  chmodSync(script, 0o755);
  await newSession(tmuxName, req.repoDir, script);
}

export async function writeResumeScript(req: SessionLaunch, cwd: string): Promise<string> {
  const claudePath = await findClaude();
  const files = writeHookFiles(req.id, false, false);
  const script = join(runsDir(), `${req.id}.resume.sh`);
  writeFileSync(script, ["#!/bin/zsh", `cd ${shellQuote(cwd)} || exit 1`, UNSET_CLAUDE_ENV, ...workCommand(req, claudePath, config.port, files), ""].join("\n"));
  chmodSync(script, 0o755);
  return script;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @friday/core exec vitest run src/agent/runner.session.test.ts src/agent/runner.test.ts src/agent/report.test.ts`
Expected: PASS。若 `FORBIDDEN` 拦了 `git worktree add`，改 `guard.ts` 的那条正则只拦 `git worktree remove --force` / `prune`，并在 `guard.test.ts` 加对应断言。

- [ ] **Step 5: 提交**

```bash
git add apps/core/src/agent/runner.ts apps/core/src/agent/runner.session.test.ts apps/core/src/agent/guard.ts apps/core/src/agent/guard.test.ts
git commit -m "$(cat <<'EOF'
两段式启动脚本：准备段按项目规则建 worktree 写路径文件，干活段 cd 进去起 Claude，结束留 shell

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: 会话编排与三个开工入口

**Files:**
- Create: `apps/core/src/agent/sessions.ts`
- Create: `apps/core/src/agent/sessions.test.ts`
- Modify: `apps/core/src/agent/pipeline.ts`（`startInteractiveJob`、`startAutonomousJob`；删 `handOffToStory`）
- Modify: `apps/core/src/agent/runner.ts`（`autonomousPrompt` 第 1 条）
- Modify: `apps/core/src/agent/slack/queryJob.ts`（删 `spawnHeadless`）
- Modify: `apps/core/src/api/jobs.ts`（`/jobs/:id/worktree`、`/jobs/:id/exit` 的 `phase`、SessionStart 冲刷排队）
- Modify: `apps/core/src/api/tasks.ts`（`/tasks/:id/start`、`/retry` 把 `TmuxMissingError` 翻成 400）
- Modify: `apps/core/src/agent/storyGroup.test.ts`（改测 `joinRootSession`）
- Modify: `packages/shared/src/index.ts`（`TaskSource.rootId`）

**Interfaces:**
- Consumes: Task 1 全部；Task 2 `createTermSession` / `getTermSession` / `updateTermSession` / `markInput` / `termSessionByJob` / `setJobDir`；Task 3 `launchInSession` / `writeResumeScript` / `shellQuote`
- Produces:
  - `TaskSource.rootId?: string`
  - `resolveRoot(task: Task): Task`
  - `setLauncher(fn: typeof launchInSession): void`（测试注入）
  - `openSession(root: Task, owner: Task, o: { kind: TermSessionKind; project: string; repoDir: string; task: string; baseBranch?: string; jobId?: string }): Promise<string>`（返回 jobId）
  - `sayToSession(sessionId: string, text: string): Promise<"sent" | "queued" | "no-terminal">`
  - `flushQueued(sessionId: string): Promise<void>`
  - `joinRootSession(task: Task, root: Task, detail: string): Promise<"joined" | "no-session">`
  - `resumeInSession(sessionId: string, prompt?: string): Promise<boolean>`
  - `worktreeReady(jobId: string, path: string): Promise<TermSession | undefined>`
  - `prepareFailed(jobId: string): Task | undefined`
  - `baseBranchOf(t: Task): { baseBranch?: string }`

- [ ] **Step 1: 共享类型** —— `TaskSource` 里 `jobId?: string;` 下面加：

```ts
  /** 缺陷挂在哪个需求（根任务）下：缺陷不建自己的会话和 worktree，进根的 */
  rootId?: string;
```

- [ ] **Step 2: 写失败的测试** `apps/core/src/agent/sessions.test.ts`

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { createTask, getTask } from "../memory/tasks.js";
import { getJob, listJobs } from "../memory/jobs.js";
import { getTermSession } from "../memory/termSessions.js";
import { setTmuxRunner } from "./tmux.js";
import { flushQueued, joinRootSession, openSession, prepareFailed, resolveRoot, sayToSession, setLauncher, worktreeReady } from "./sessions.js";
import { startInteractiveJob } from "./pipeline.js";

let calls: string[][] = [];
let tmuxInstalled = true;
let alive = new Set<string>();
beforeEach(() => {
  calls = [];
  tmuxInstalled = true;
  setTmuxRunner(async (args) => {
    calls.push(args);
    if (args[0] === "-V") {
      if (!tmuxInstalled) throw Object.assign(new Error("spawn tmux ENOENT"), { code: "ENOENT" });
      return "tmux 3.5a";
    }
    const sub = args[4];
    const target = (args[args.indexOf("-t") + 1] ?? "").replace(/^=/, "").replace(/:.*$/, "");
    if (sub === "has-session" && !alive.has(target)) throw new Error("can't find session");
    if (sub === "rename-session") { alive.delete(target); alive.add(args.at(-1)!); }
    return "";
  });
  setLauncher(async (_req, name) => { alive.add(name); });
});
const sent = () => calls.filter((c) => c[4] === "send-keys" && c.includes("-l")).map((c) => c.at(-1));

describe("根任务与会话", () => {
  it("缺陷按 linkedStoryId 找到需求当根，并把 rootId 写回", () => {
    const story = createTask({ title: "养牛计划", kind: "meegle", source: { meegleId: "S1" }, status: "understood" });
    const bug = createTask({ title: "积分错位", kind: "meegle", source: { meegleId: "B1", linkedStoryId: "S1" }, status: "understood" });
    expect(resolveRoot(bug).id).toBe(story.id);
    expect(getTask(bug.id)!.source.rootId).toBe(story.id);
    const loose = createTask({ title: "散任务", kind: "verbal", source: {}, status: "understood" });
    expect(resolveRoot(loose).id).toBe(loose.id);
  });

  it("tmux 没装：开始做直接报错，任务状态不变、不留 job", async () => {
    tmuxInstalled = false;
    const t = createTask({ title: "没 tmux", kind: "verbal", source: {}, status: "understood", project: "app" });
    const before = listJobs(1000).length;
    await expect(startInteractiveJob(t, "app", "/r/app", "做一下")).rejects.toThrow("brew install tmux");
    expect(getTask(t.id)!.status).toBe("understood");
    expect(listJobs(1000).length).toBe(before);
  });

  it("开会话：会话键是根任务 id，job 归 owner，状态 preparing", async () => {
    const root = createTask({ title: "导出中心", kind: "verbal", source: {}, status: "understood", project: "app" });
    const jobId = await openSession(root, root, { kind: "interactive", project: "app", repoDir: "/r/app", task: "做导出" });
    const s = getTermSession(root.id)!;
    expect(s).toMatchObject({ status: "preparing", jobId, tmuxName: `app-${root.id.slice(0, 8)}` });
    expect(getJob(jobId)).toMatchObject({ taskId: root.id, sessionId: root.id });
  });

  it("准备段还没跑完时说的话先排队，SessionStart 到了再送", async () => {
    const root = createTask({ title: "排队", kind: "verbal", source: {}, status: "understood", project: "app" });
    await openSession(root, root, { kind: "interactive", project: "app", repoDir: "/r/app", task: "x" });
    expect(await sayToSession(root.id, "先等等")).toBe("queued");
    expect(sent()).toEqual([]);
    await flushQueued(root.id);
    expect(sent()).toEqual(["先等等"]);
  });

  it("需求的会话在跑：缺陷的活转达进去，不开新会话", async () => {
    const root = createTask({ title: "计费", kind: "meegle", source: { meegleId: "S2" }, status: "processing", project: "app" });
    const jobId = await openSession(root, root, { kind: "interactive", project: "app", repoDir: "/r/app", task: "x" });
    await worktreeReady(jobId, "/r/app-feat-billing");
    const bug = createTask({ title: "合计没刷新", kind: "meegle", source: { meegleId: "B2", linkedStoryId: "S2" }, status: "understood" });
    const jobs = listJobs(1000).length;
    expect(await joinRootSession(bug, resolveRoot(bug), "账单页合计没刷新")).toBe("joined");
    expect(sent().at(-1)).toContain("顺带再改一条同需求下的缺陷");
    expect(getTask(bug.id)).toMatchObject({ status: "processing", source: { rootId: root.id } });
    expect(listJobs(1000).length).toBe(jobs);
  });

  it("准备段回报：会话改名成 worktree 目录名，任务和 job 目录跟着换", async () => {
    const root = createTask({ title: "改名", kind: "verbal", source: {}, status: "understood", project: "app" });
    const jobId = await openSession(root, root, { kind: "interactive", project: "app", repoDir: "/r/app", task: "x" });
    const s = await worktreeReady(jobId, "/r/app-feat-rename");
    expect(s).toMatchObject({ status: "running", worktree: "/r/app-feat-rename", tmuxName: "app-feat-rename" });
    expect(getTask(root.id)!.source.worktree).toBe("/r/app-feat-rename");
    expect(getJob(jobId)!.dir).toBe("/r/app-feat-rename");
  });

  it("准备段失败：任务 blocked，会话 exited 但 tmux 会话留着", async () => {
    const root = createTask({ title: "失败", kind: "verbal", source: {}, status: "understood", project: "app" });
    const jobId = await openSession(root, root, { kind: "interactive", project: "app", repoDir: "/r/app", task: "x" });
    const t = prepareFailed(jobId)!;
    expect(t.status).toBe("blocked");
    expect(getTermSession(root.id)!.status).toBe("exited");
    expect(calls.some((c) => c[4] === "kill-session")).toBe(false);
  });
});
```

注意：`worktreeReady` 调 `currentBranchSync("/r/app-feat-…")`，路径不存在时返回空串，断言里不要求 `branch`。

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @friday/core exec vitest run src/agent/sessions.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 4: 实现** `apps/core/src/agent/sessions.ts`

```ts
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { Task, TermSession, TermSessionKind } from "@friday/shared";
import { publish } from "../bus.js";
import { record } from "../memory/audit.js";
import { createJob, finishJob, getJob, recordTerminalInput, reviveJob, setJobDir } from "../memory/jobs.js";
import { findTaskBySource, getTask, updateTask } from "../memory/tasks.js";
import { createTermSession, getTermSession, markInput, updateTermSession } from "../memory/termSessions.js";
import { currentBranchSync } from "./git.js";
import { jobLog, launchInSession, shellQuote, writeResumeScript } from "./runner.js";
import { hasSession, renameSession, safeName, sendText, sessionName, tmuxVersion, TmuxMissingError, writeTmuxConf } from "./tmux.js";

let launch: typeof launchInSession = launchInSession;
export function setLauncher(fn: typeof launchInSession): void {
  launch = fn;
}

export function resolveRoot(task: Task): Task {
  if (task.source.rootId) return getTask(task.source.rootId) ?? task;
  const story = task.source.linkedStoryId;
  if (!story) return task;
  const root = findTaskBySource((s) => s.meegleId === story || (s.mergedMeegleIds ?? []).includes(story));
  if (!root || root.id === task.id) return task;
  updateTask(task.id, { source: { rootId: root.id } });
  return root;
}

export function baseBranchOf(t: Task): { baseBranch?: string } {
  const b = t.source.baseTaskId ? getTask(t.source.baseTaskId)?.source.branch : undefined;
  return b ? { baseBranch: b } : {};
}

export async function openSession(
  root: Task,
  owner: Task,
  o: { kind: TermSessionKind; project: string; repoDir: string; task: string; baseBranch?: string; jobId?: string },
): Promise<string> {
  if (!(await tmuxVersion())) throw new TmuxMissingError();
  writeTmuxConf();
  const jobId = o.jobId ?? randomUUID();
  const name = sessionName(o.repoDir, root.id.slice(0, 8));
  createJob({ id: jobId, project: o.project, dir: o.repoDir, task: o.task.slice(0, 500), logPath: jobLog(jobId), taskId: owner.id, sessionId: root.id });
  createTermSession({ id: root.id, project: o.project, repoDir: o.repoDir, tmuxName: name, kind: o.kind, jobId });
  try {
    await launch({ id: jobId, repoDir: o.repoDir, task: o.task, kind: o.kind, project: o.project, ...(o.baseBranch ? { baseBranch: o.baseBranch } : {}) }, name);
  } catch (e) {
    finishJob(jobId, 1);
    updateTermSession(root.id, { status: "closed" });
    throw e;
  }
  publish({ type: "tasks" });
  return jobId;
}

const queued = new Map<string, string[]>();

export async function sayToSession(sessionId: string, text: string): Promise<"sent" | "queued" | "no-terminal"> {
  const s = getTermSession(sessionId);
  if (!s || s.status === "closed" || s.status === "exited" || !(await hasSession(s.tmuxName))) return "no-terminal";
  if (s.status === "preparing") {
    queued.set(sessionId, [...(queued.get(sessionId) ?? []), text]);
    return "queued";
  }
  await sendText(s.tmuxName, text);
  markInput(sessionId);
  if (s.jobId) recordTerminalInput(s.jobId, text);
  return "sent";
}

export async function flushQueued(sessionId: string): Promise<void> {
  const list = queued.get(sessionId);
  if (!list?.length) return;
  queued.delete(sessionId);
  updateTermSession(sessionId, { status: "running" });
  for (const text of list) await sayToSession(sessionId, text);
}

export async function resumeInSession(sessionId: string, prompt?: string): Promise<boolean> {
  const s = getTermSession(sessionId);
  const job = s?.jobId ? getJob(s.jobId) : undefined;
  if (!s || !job || !(await hasSession(s.tmuxName))) return false;
  const file = await writeResumeScript(
    { id: job.id, repoDir: s.repoDir, kind: "interactive", project: s.project, ...(job.claudeSessionId ? { resumeSessionId: job.claudeSessionId } : {}), ...(prompt ? { task: prompt } : {}) },
    s.worktree ?? s.repoDir,
  );
  await sendText(s.tmuxName, `/bin/zsh ${shellQuote(file)}`);
  reviveJob(job.id);
  updateTermSession(sessionId, { status: "running" });
  markInput(sessionId);
  record({ taskId: job.taskId, action: "terminal_reopened", why: "Claude 退出了但任务还没做完", how: job.claudeSessionId ? "在同一个会话里 --resume 接回" : "在同一个会话里开新 Claude", evidence: { jobId: job.id, session: s.tmuxName }, risk: "reversible" });
  publish({ type: "tasks" });
  return true;
}

export async function joinRootSession(task: Task, root: Task, detail: string): Promise<"joined" | "no-session"> {
  const s = getTermSession(root.id);
  if (!s || s.status === "closed" || !(await hasSession(s.tmuxName))) return "no-session";
  const text = `顺带再改一条同需求下的缺陷：\n${detail}\n\n改完一并在同一个分支上交付，不要另起分支。`;
  const ok = s.status === "exited" ? await resumeInSession(root.id, text) : (await sayToSession(root.id, text)) !== "no-terminal";
  if (!ok) return "no-session";
  updateTask(task.id, { status: "processing", progress: `在需求「${root.title.slice(0, 24)}」的会话里改`, source: { rootId: root.id } });
  record({ taskId: task.id, action: "handed_to_story_terminal", why: "同一个需求下的改动要走同一个分支，免得两个终端改同一片代码后合不上", how: `转达给需求任务 ${root.id.slice(0, 8)} 的会话`, evidence: { rootId: root.id, detail: detail.slice(0, 300) }, risk: "reversible" });
  return "joined";
}

export async function worktreeReady(jobId: string, path: string): Promise<TermSession | undefined> {
  const job = getJob(jobId);
  const s = job?.sessionId ? getTermSession(job.sessionId) : undefined;
  if (!job || !s) return undefined;
  const branch = currentBranchSync(path) || undefined;
  const next = safeName(basename(path));
  const renamed = Boolean(next) && next !== s.tmuxName && (await renameSession(s.tmuxName, next));
  setJobDir(jobId, path);
  const updated = updateTermSession(s.id, { status: "running", worktree: path, ...(branch ? { branch } : {}), ...(renamed ? { tmuxName: next } : {}) })!;
  for (const id of new Set([s.id, job.taskId].filter((x): x is string => Boolean(x)))) {
    updateTask(id, { source: { worktree: path, repoDir: s.repoDir, ...(branch ? { branch } : {}) } });
  }
  record({ taskId: job.taskId, action: "worktree_ready", why: "准备段按项目规则建好了 worktree", how: `${path}${branch ? ` · ${branch}` : ""}`, evidence: { jobId, path, branch: branch ?? null }, risk: "read" });
  publish({ type: "tasks" });
  return updated;
}

export function prepareFailed(jobId: string): Task | undefined {
  const job = getJob(jobId);
  if (!job) return undefined;
  finishJob(jobId, 2);
  if (job.sessionId) updateTermSession(job.sessionId, { status: "exited" });
  if (!job.taskId) return undefined;
  record({ taskId: job.taskId, action: "claude_code_blocked", why: "准备段没建出 worktree", how: "准备段结束时路径文件为空", evidence: { jobId }, risk: "read", status: "failed" });
  return updateTask(job.taskId, { status: "blocked", progress: "准备段没建出 worktree，打开终端看它的输出" });
}
```

`updateTask` 的 `source` 是浅合并（现有行为），传部分字段即可。

- [ ] **Step 5: 改开工入口** —— `apps/core/src/agent/pipeline.ts`：
  - 删除 `handOffToStory` 整个函数，删除 `launchClaude` / `setGhosttyId` / `addWorktree` / `fridayWorktree` 的 import；加 `import { baseBranchOf, joinRootSession, openSession, resolveRoot } from "./sessions.js";`
  - `startInteractiveJob` 替换为：

```ts
export async function startInteractiveJob(task: Task, project: string, dir: string, detail: string): Promise<Task> {
  const root = resolveRoot(task);
  if (root.id !== task.id) {
    if ((await joinRootSession(task, root, detail)) === "joined") return getTask(task.id)!;
    if (!root.project) updateTask(root.id, { project });
    const jobId = await openSession(root, root, { kind: "interactive", project, repoDir: dir, task: `我要开始做这条需求：${root.title}\n\n先做名下这条缺陷：\n${detail}`, ...baseBranchOf(root) });
    updateTask(root.id, { status: "processing", source: { jobId, autonomous: false, repoDir: dir } });
    record({ taskId: root.id, action: "terminal_opened", why: "你点了名下缺陷的「开始做」，需求还没有会话", how: `在 tmux 会话里起交互式 Claude Code，先按项目规则建 worktree`, evidence: { jobId, project, dir }, risk: "reversible" });
    return updateTask(task.id, { status: "processing", progress: `在需求「${root.title.slice(0, 24)}」的会话里改`, source: { rootId: root.id } })!;
  }
  const jobId = await openSession(task, task, { kind: "interactive", project, repoDir: dir, task: detail, ...baseBranchOf(task) });
  record({ taskId: task.id, action: "terminal_opened", why: "你点了「开始做」，这条需求自己动手", how: `在 tmux 会话里起交互式 Claude Code，先按项目规则建 worktree`, evidence: { jobId, project, dir }, risk: "reversible" });
  return updateTask(task.id, { status: "processing", source: { jobId, autonomous: false, repoDir: dir } })!;
}
```

  - `startAutonomousJob`：把开头的 `if (await handOffToStory(task, detail))` 换成下面，并把「`const id = randomUUID(); const tree = …` 到 `if (ghosttyId) setGhosttyId(id, ghosttyId);`」这一段换成 `openSession` 调用；`worktreeDirt` 体检保留：

```ts
  const root = resolveRoot(task);
  if (root.id !== task.id && (await joinRootSession(task, root, detail)) === "joined") return getTask(task.id)!;
  const dirt = await worktreeDirt(dir);
  if (dirt) {
    record({ taskId: task.id, action: "claude_code_blocked", why: "开工前体检不通过", how: dirt, evidence: { dir, project }, risk: "read", status: "failed" });
    return updateTask(task.id, { status: "blocked", progress: `没有开工：${dirt}。提交或清掉这些改动后点「重新开工」。` })!;
  }
  const id = randomUUID();
  const base = baseBranchOf(task).baseBranch;
  await openSession(root, task, { kind: "autonomous", project, repoDir: dir, task: autonomousPrompt(id, detail, project, base), jobId: id, ...(base ? { baseBranch: base } : {}) });
  createRun({ id, jobId: id, taskId: task.id, project, kind: "autonomous", trigger, ...(task.source.intake?.confidence !== undefined ? { intakeConfidence: task.source.intake.confidence } : {}) });
  record({ taskId: task.id, action: "claude_code_start", why: "任务需要改代码，按策略自动在分支上完成再交审核", how: `在 tmux 会话里先按项目规则建 worktree，再跑 claude -p，完成后写交付报告`, evidence: { jobId: id, project, dir }, risk: "reversible" });
  const progress = [task.progress, `Claude Code 正在 ${project} 上处理`].filter(Boolean).join("\n");
  return updateTask(task.id, { status: "processing", progress, source: { jobId: id, autonomous: true, repoDir: dir } })!;
```

- [ ] **Step 6: 自主提示词第 1 条** —— `runner.ts` 的 `autonomousPrompt` 里把规则 1 的三行（「你已经在一个专门给这次任务开的 git worktree 里…」到「起好后第一时间调 friday_progress…」）换成：

```ts
    "1. 你已经在为这次任务准备好的 git worktree 里、在新分支上，直接开工；不要再建分支，不要回主仓操作。",
    "   开工先调 friday_progress 把当前分支名告诉 Friday（写成「在分支 xxx 上开工」）。",
    "   push、merge、rebase、reset --hard 会被 Friday 的守卫直接拒绝，不用试。",
```

  并删掉 `base` 相关的两行分支（基线已由准备段处理）；`autonomousPrompt` 的 `base` 参数保留但不再使用时直接删掉参数，同步改 `report.test.ts` 里的调用。

- [ ] **Step 7: 后台查询** —— `apps/core/src/agent/slack/queryJob.ts`：删 `spawnHeadless` 及其 import（`spawn`、`createWriteStream`、`findClaude`、`claudeArgs`、`writeHookFiles`、`cleanEnv`）；`startQueryJob` 里把 `createJob(...)` 和 `spawnHeadless(id, dir, prompt)` 两行换成：

```ts
  await openSession(task, task, { kind: "query", project: picked[0]!.name, repoDir: dir, task: prompt, jobId: id });
```

  `import { openSession } from "../sessions.js";`。`reopenTerminal` 里原来判断 headless 补 `readonly` 的逻辑随 Task 13 一起删。

- [ ] **Step 8: jobs 路由** —— `apps/core/src/api/jobs.ts`：
  - import：`import { flushQueued, prepareFailed, worktreeReady } from "../agent/sessions.js";`、`import { updateTermSession } from "../memory/termSessions.js";`
  - 新增路由（放在 `/jobs/:id/exit` 前）：

```ts
  .post("/jobs/:id/worktree", async (c) => {
    const parsed = z.object({ path: z.string().min(1).max(1000) }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "path 必填" }, 400);
    const s = await worktreeReady(c.req.param("id"), parsed.data.path);
    return s ? c.json(s) : c.json({ error: "没有这个会话" }, 404);
  })
```

  - `/jobs/:id/exit` 的 schema 改成 `z.object({ code: z.number().int(), phase: z.literal("prepare").optional() })`，解析后第一件事：

```ts
    if (parsed.data.phase === "prepare") {
      const t = prepareFailed(c.req.param("id"));
      return t ? c.json(t) : c.json({ error: "任务不存在" }, 404);
    }
```

    `finishJob` 之后加 `if (job.sessionId) updateTermSession(job.sessionId, { status: "exited" });`
  - `/jobs/:id/message` 里 `const okSid = …` 之后加：

```ts
    if (event === "SessionStart") {
      const sid = getJob(id)?.sessionId;
      if (sid) await flushQueued(sid);
    }
```

- [ ] **Step 9: 开工接口的错误** —— `apps/core/src/api/tasks.ts` 的 `/tasks/:id/start` 与 `/tasks/:id/retry`：把 `return c.json(await startInteractiveJob(...))` / `startAutonomousJob(...)` 包成：

```ts
    try {
      return c.json(await startInteractiveJob(t, r.project.name, r.project.dir, detail));
    } catch (e) {
      if (e instanceof TmuxMissingError) return c.json({ error: e.message }, 400);
      throw e;
    }
```

  （`import { TmuxMissingError } from "../agent/tmux.js";`）。

- [ ] **Step 10: 旧测试** —— `apps/core/src/agent/storyGroup.test.ts` 里测 `handOffToStory` 的 case 改测 `joinRootSession`（同样的 fake tmux runner + `setLauncher`，照 Step 2 的写法）；`apps/core/src/api/relay.test.ts` 若引用 `ghostty`，改成 `setTmuxRunner` 注入。

- [ ] **Step 11: 跑测试**

Run: `pnpm --filter @friday/core test && pnpm --filter @friday/core typecheck`
Expected: 全过

- [ ] **Step 12: 提交**

```bash
git add -A apps/core packages/shared
git commit -m "$(cat <<'EOF'
开工一律进 tmux 会话：会话归根任务，缺陷转达进需求的会话；准备段回报 worktree、失败标 blocked

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: 说话、对账、收工

**Files:**
- Modify: `apps/core/src/agent/terminal.ts`（重写）
- Modify: `apps/core/src/agent/terminal.test.ts`（重写）
- Modify: `apps/core/src/agent/pipeline.ts`（`finishTask`；删 `cleanupTaskWorktree`；`git_merge` 执行后不再收 worktree）
- Modify: `apps/core/src/memory/jobs.ts`（删 `reapStaleJobs`、`setGhosttyId`）
- Modify: `apps/core/src/memory/jobs.test.ts`（删收尸那组）
- Create: `apps/core/src/api/worktrees.ts`
- Modify: `apps/core/src/api/index.ts`
- Modify: `apps/core/src/agent/bridge.ts`（`friday_finish` 描述）

**Interfaces:**
- Consumes: Task 1 `hasSession` / `listSessionNames` / `killSession`；Task 2 `openTermSessions` / `updateTermSession` / `termSessionByJob`；Task 4 `sayToSession`
- Produces:
  - `say(jobId: string, text: string): Promise<"sent" | "queued" | "no-terminal">`（签名不变，调用方不用改）
  - `sweepClosedTerminals(): Promise<string[]>`（改为按 tmux 对账，返回被收的 jobId）
  - `closeJobTerminal(jobId, why, taskId?): Promise<boolean>`、`closeTaskTerminal(task, why): Promise<boolean>`（只对根任务 kill）
  - `leftoverWorktrees(): Array<{ path: string; repoDir: string; branch?: string; dirty: boolean; taskId?: string; title?: string }>`
  - `GET /worktrees/leftover`、`POST /worktrees/remove {path, repoDir}`

- [ ] **Step 1: 写失败的测试** —— 用下面内容**整个替换** `apps/core/src/agent/terminal.test.ts`：

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTask, getTask } from "../memory/tasks.js";
import { getJob } from "../memory/jobs.js";
import { getTermSession } from "../memory/termSessions.js";
import { listAudit } from "../memory/audit.js";
import { setTmuxRunner } from "./tmux.js";
import { openSession, setLauncher, worktreeReady } from "./sessions.js";
import { say, sweepClosedTerminals } from "./terminal.js";
import { finishTask } from "./pipeline.js";

let calls: string[][] = [];
let alive = new Set<string>();
let listFails = false;
beforeEach(() => {
  calls = [];
  listFails = false;
  setTmuxRunner(async (args) => {
    calls.push(args);
    if (args[0] === "-V") return "tmux 3.5a";
    const sub = args[4];
    const target = (args[args.indexOf("-t") + 1] ?? "").replace(/^=/, "").replace(/:.*$/, "");
    if (sub === "has-session" && !alive.has(target)) throw new Error("can't find session");
    if (sub === "list-sessions") {
      if (listFails) throw Object.assign(new Error("spawn tmux EAGAIN"), { code: "EAGAIN" });
      return [...alive].join("\n");
    }
    if (sub === "kill-session") alive.delete(target);
    if (sub === "rename-session") { alive.delete(target); alive.add(args.at(-1)!); }
    return "";
  });
  setLauncher(async (_req, name) => { alive.add(name); });
});

async function running(title: string, extra: Record<string, unknown> = {}) {
  const t = createTask({ title, kind: "verbal", source: extra, status: "processing", project: "app" });
  const jobId = await openSession(t, t, { kind: "interactive", project: "app", repoDir: "/r/app", task: "x" });
  await worktreeReady(jobId, `/r/app-${t.id.slice(0, 6)}`);
  return { t, jobId };
}

describe("tmux 版终端", () => {
  it("say 走 send-keys 并记下输入时间", async () => {
    const { t, jobId } = await running("说话");
    const before = getTermSession(t.id)!.lastInputAt!;
    await new Promise((r) => setTimeout(r, 5));
    expect(await say(jobId, "先提交")).toBe("sent");
    expect(calls.some((c) => c[4] === "send-keys" && c.at(-1) === "先提交")).toBe(true);
    expect(getTermSession(t.id)!.lastInputAt! > before).toBe(true);
  });

  it("tmux 列不出来（不是没有 server）时对账什么都不动", async () => {
    const { t, jobId } = await running("抖动");
    alive.clear();
    listFails = true;
    expect(await sweepClosedTerminals()).toEqual([]);
    expect(getTermSession(t.id)!.status).toBe("running");
    expect(getJob(jobId)!.status).toBe("running");
  });

  it("tmux 里已经没有的会话才收：会话 closed、job 结束", async () => {
    const { t, jobId } = await running("没了");
    alive.delete(getTermSession(t.id)!.tmuxName);
    expect(await sweepClosedTerminals()).toContain(jobId);
    expect(getTermSession(t.id)!.status).toBe("closed");
    expect(getJob(jobId)!.status).not.toBe("running");
  });

  it("缺陷收工不杀需求的会话；需求收工才杀", async () => {
    const { t: root } = await running("需求");
    const bug = createTask({ title: "缺陷", kind: "meegle", source: { rootId: root.id }, status: "processing" });
    await finishTask(bug.id, "done", "测试");
    expect(calls.some((c) => c[4] === "kill-session")).toBe(false);
    expect(getTermSession(root.id)!.status).toBe("running");
    await finishTask(root.id, "done", "测试");
    expect(calls.some((c) => c[4] === "kill-session")).toBe(true);
    expect(getTermSession(root.id)!.status).toBe("closed");
  });

  it("收工后 worktree 目录还在就记 worktree_kept，Friday 自己不删", async () => {
    const dir = mkdtempSync(join(tmpdir(), "app-feat-keep-"));
    const t = createTask({ title: "留着", kind: "verbal", source: {}, status: "processing", project: "app" });
    const jobId = await openSession(t, t, { kind: "interactive", project: "app", repoDir: "/r/app", task: "x" });
    await worktreeReady(jobId, dir);
    await finishTask(t.id, "done", "测试");
    expect(listAudit({ limit: 50 }).some((e) => e.taskId === t.id && e.action === "worktree_kept")).toBe(true);
    expect(getTask(t.id)!.source.worktree).toBe(dir);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @friday/core exec vitest run src/agent/terminal.test.ts`
Expected: FAIL（还是 Ghostty 版实现）

- [ ] **Step 3: 重写** `apps/core/src/agent/terminal.ts`

```ts
import { existsSync } from "node:fs";
import type { Task } from "@friday/shared";
import { isFridayRun } from "@friday/shared";
import { finishJob, getJob, runningJobs } from "../memory/jobs.js";
import { listTasks } from "../memory/tasks.js";
import { record } from "../memory/audit.js";
import { getTermSession, openTermSessions, updateTermSession } from "../memory/termSessions.js";
import { killSession, listSessionNames } from "./tmux.js";
import { sayToSession } from "./sessions.js";
import { publish } from "../bus.js";

export type SayResult = "sent" | "queued" | "no-terminal";

export async function say(jobId: string, text: string): Promise<SayResult> {
  const sid = getJob(jobId)?.sessionId;
  return sid ? sayToSession(sid, text) : "no-terminal";
}

export async function sweepClosedTerminals(): Promise<string[]> {
  const names = await listSessionNames();
  if (!names) return [];
  const live = new Set(names);
  const dead: string[] = [];
  for (const s of openTermSessions()) {
    if (live.has(s.tmuxName)) continue;
    updateTermSession(s.id, { status: "closed" });
    if (s.jobId && getJob(s.jobId)?.status === "running") {
      finishJob(s.jobId, -1);
      dead.push(s.jobId);
    }
  }
  for (const j of runningJobs()) if (!j.sessionId) { finishJob(j.id, -1); dead.push(j.id); }
  const stuck = listTasks("processing", 1000)
    .filter((t) => isFridayRun(t.source) && t.source.jobId && getJob(t.source.jobId)?.status !== "running")
    .map((t) => t.source.jobId!);
  const exits = [...new Set([...dead, ...stuck])];
  if (exits.length) {
    const { onJobExit } = await import("./pipeline.js");
    for (const jobId of exits) onJobExit(jobId, -1);
    publish({ type: "tasks" });
  }
  return dead;
}

export async function closeJobTerminal(jobId: string, why: string, taskId?: string): Promise<boolean> {
  const job = getJob(jobId);
  const s = job?.sessionId ? getTermSession(job.sessionId) : undefined;
  const killed = Boolean(s && s.status !== "closed");
  if (s && killed) {
    await killSession(s.tmuxName);
    updateTermSession(s.id, { status: "closed" });
  }
  if (job?.status === "running") finishJob(jobId, 0);
  if (killed || job?.status === "running") {
    record({ ...(taskId ? { taskId } : {}), action: "terminal_closed", why, how: killed ? "关掉 tmux 会话，job 收尾" : "job 收尾（会话已不在）", evidence: { jobId, project: job?.project ?? null }, risk: "reversible" });
  }
  return killed;
}

export async function closeTaskTerminal(task: Pick<Task, "id" | "source">, why: string): Promise<boolean> {
  if (task.source.rootId) return false;
  const s = getTermSession(task.id);
  const jobId = s?.jobId ?? task.source.jobId;
  if (!jobId) return false;
  const closed = await closeJobTerminal(jobId, why, task.id);
  const tree = task.source.worktree;
  if (tree && existsSync(tree)) record({ taskId: task.id, action: "worktree_kept", why, how: `worktree 还在：${tree}，终端里的 Claude 没收，留给你在设置页处理`, evidence: { worktree: tree, branch: task.source.branch ?? null }, risk: "read" });
  return closed;
}
```

  删掉 `TERMINAL_STATE_LABEL`、`terminalState`、`refreshTerminalState`、`markStop`、`isIdle`（`api/tasks.ts` 与 `api/jobs.ts` 里对它们的引用在 Task 6 换成 `sessionState`，这一步先把引用改成临时的 `"idle"` 常量会造成歧义——**所以本 Task 与 Task 6 连续做，本 Task 的 Step 6 类型检查允许 `api/tasks.ts` / `api/jobs.ts` 里 `terminalState` / `markStop` 的报错，Task 6 Step 5 修掉**）。

- [ ] **Step 4: `finishTask`** —— `pipeline.ts`：

```ts
export async function finishTask(id: string, status: "done" | "ignored", why: string, { keepTerminal = false } = {}): Promise<Task | undefined> {
  const t = updateTask(id, { status, pending: [], attention: undefined });
  if (t) for (const r of pendingRunsForTask(id)) if (r.kind === "autonomous") settleRun(r, t, status, why);
  if (t && !keepTerminal) await closeTaskTerminal(t, why);
  return t;
}
```

  删除 `cleanupTaskWorktree` 函数及其所有调用（`git_merge` 执行分支里那处也删）、`removeWorktree` 的 import 保留给 `api/worktrees.ts`。

- [ ] **Step 5: 遗留 worktree 接口** —— `apps/core/src/api/worktrees.ts`：

```ts
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { listTasks } from "../memory/tasks.js";
import { loadProjects } from "../memory/projects.js";
import { record } from "../memory/audit.js";
import { currentBranchSync, removeWorktree, worktreeDirtySync } from "../agent/git.js";

export interface Leftover { path: string; repoDir: string; branch?: string; dirty: boolean; taskId?: string; title?: string }

export function leftoverWorktrees(): Leftover[] {
  const out = new Map<string, Leftover>();
  for (const t of [...listTasks("done", 2000), ...listTasks("ignored", 2000)]) {
    const p = t.source.worktree;
    const repo = t.source.repoDir;
    if (!p || !repo || !existsSync(p)) continue;
    out.set(p, { path: p, repoDir: repo, ...(currentBranchSync(p) ? { branch: currentBranchSync(p) } : {}), dirty: worktreeDirtySync(p), taskId: t.id, title: t.title });
  }
  for (const proj of loadProjects()) {
    const dir = join(proj.dir, ".claude", "worktrees");
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((n) => n.startsWith("friday-"))) {
      const p = join(dir, name);
      if (!out.has(p)) out.set(p, { path: p, repoDir: proj.dir, ...(currentBranchSync(p) ? { branch: currentBranchSync(p) } : {}), dirty: worktreeDirtySync(p) });
    }
  }
  return [...out.values()];
}

export const worktrees = new Hono()
  .get("/worktrees/leftover", (c) => c.json(leftoverWorktrees()))
  .post("/worktrees/remove", async (c) => {
    const parsed = z.object({ path: z.string().min(1), repoDir: z.string().min(1) }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "path / repoDir 必填" }, 400);
    const r = await removeWorktree(parsed.data.repoDir, parsed.data.path);
    record({ action: r.removed ? "worktree_removed" : "worktree_kept", why: "你在设置页手动删遗留的 worktree", how: r.removed ? `删了 ${parsed.data.path}${r.branchDeleted ? `，分支 ${r.branch} 也删了` : r.branch ? `，分支 ${r.branch} 没合并留着` : ""}` : `没删：${r.kept ?? "未知原因"}`, evidence: { ...parsed.data, branch: r.branch ?? null }, risk: "reversible" });
    return c.json(r);
  });
```

  `git.ts` 若没有 `worktreeDirtySync(dir): boolean`，加一个：

```ts
export function worktreeDirtySync(dir: string): boolean {
  try {
    return execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8", timeout: 5_000 }).trim().length > 0;
  } catch {
    return false;
  }
}
```

  `api/index.ts` 加 `import { worktrees } from "./worktrees.js";` 与 `.route("/", worktrees)`。

- [ ] **Step 6: `friday_finish` 描述** —— `bridge.ts` 里 `friday_finish` 的 `description` 改为：

```ts
    description: "整条任务收工：只在 MR 已经合并之后调。调之前你自己按项目规则删掉这次的 worktree 和本地分支（git worktree remove、git branch -d，不要 --force；删不掉就说明原因）。Friday 会把任务标完成并关掉这个终端会话。做完一轮、提测了、MR 还没合，都用 friday_done，不要调这个。",
```

- [ ] **Step 7: 删旧收尸** —— `memory/jobs.ts` 删 `reapStaleJobs`、`setGhosttyId`；`memory/jobs.test.ts` 删「启动收尸」那组 describe 与 `mk` 里的 `setGhosttyId`。`index.ts` 里启动时的 `sweepClosedTerminals()` 调用保留（现在是 tmux 对账）。

- [ ] **Step 8: 跑测试**

Run: `pnpm --filter @friday/core exec vitest run src/agent/terminal.test.ts src/memory/jobs.test.ts`
Expected: PASS（全量测试等 Task 6 一起跑）

- [ ] **Step 9: 不单独提交，接着做 Task 6，两者一起提交**

---

### Task 6: 状态位

**Files:**
- Create: `apps/core/src/agent/sessionState.ts`
- Create: `apps/core/src/agent/sessionState.test.ts`
- Modify: `packages/shared/src/index.ts`（`SessionState`、`TaskSession`、`PendingAction.at`、`Task.session`）
- Modify: `apps/core/src/memory/tasks.ts`（`addPending` 写 `at`）
- Modify: `apps/core/src/api/tasks.ts`（`GET /tasks` 带 `session`）
- Modify: `apps/core/src/api/jobs.ts`（Stop → `markStop`）
- Modify: `apps/core/src/agent/bridge.ts`（`turnFinished`、`friday_done` 交互式分支、`clearAttention`）

**Interfaces:**
- Consumes: Task 2 `getTermSession` / `markStop`；Task 5
- Produces:
  - shared：`type SessionState = "asking" | "working" | "awaiting" | "deciding" | "blocked" | "exited" | "idle" | "none"`；`interface TaskSession { state: SessionState; lastStopAt?: string; waitingSince?: string; name?: string; worktree?: string; branch?: string; kind?: TermSessionKind; delivery?: { files?: number; insertions?: number; deletions?: number; costUsd?: number; minutes?: number; model?: string } }`；`PendingAction.at?: string`；`Task.session?: TaskSession`
  - `sessionState(t: Pick<Task, "attention" | "pending" | "status">, s?: TermSession): SessionState`
  - `taskSession(t: Task): TaskSession`

- [ ] **Step 1: 共享类型** —— `PendingAction` 加 `/** 挂上的时刻；「等了 N」只从它算 */ at?: string;`；`Task` 里 `terminal?: TerminalState;` 下面加 `/** 只在 GET /tasks 里有：状态位与会话信息 */ session?: TaskSession;`；加：

```ts
export type SessionState = "asking" | "working" | "awaiting" | "deciding" | "blocked" | "exited" | "idle" | "none";

export interface TaskSession {
  state: SessionState;
  lastStopAt?: string;
  waitingSince?: string;
  name?: string;
  worktree?: string;
  branch?: string;
  kind?: TermSessionKind;
  delivery?: { files?: number; insertions?: number; deletions?: number; costUsd?: number; minutes?: number; model?: string };
}

export const SESSION_STATE_LABEL: Record<SessionState, string> = {
  asking: "在问你",
  working: "干活中",
  awaiting: "等你输入",
  deciding: "待你决定",
  blocked: "卡住",
  exited: "Claude 已退出",
  idle: "",
  none: "",
};
```

- [ ] **Step 2: 写失败的测试** `apps/core/src/agent/sessionState.test.ts`

```ts
import { describe, expect, it } from "vitest";
import type { TermSession } from "@friday/shared";
import { sessionState } from "./sessionState.js";

const T = (iso: number) => new Date(Date.UTC(2026, 8, 29, 12, 0, iso)).toISOString();
const S = (p: Partial<TermSession>): TermSession => ({ id: "r", project: "p", repoDir: "/r", tmuxName: "r", kind: "interactive", status: "running", createdAt: T(0), updatedAt: T(0), ...p });
const task = (p: Record<string, unknown> = {}) => ({ status: "processing" as const, ...p });

describe("状态位只取终端里的现实", () => {
  it("在问你压过一切", () => {
    expect(sessionState(task({ attention: "question", pending: [{}] }) as never, S({ lastInputAt: T(5), lastStopAt: T(1) }))).toBe("asking");
  });
  it("输入晚于 Stop = 干活中；准备段也算干活中", () => {
    expect(sessionState(task() as never, S({ lastInputAt: T(5), lastStopAt: T(1) }))).toBe("working");
    expect(sessionState(task() as never, S({ status: "preparing", lastInputAt: T(0) }))).toBe("working");
  });
  it("Stop 晚于看过 = 等你输入；看过之后变空闲", () => {
    expect(sessionState(task() as never, S({ lastInputAt: T(1), lastStopAt: T(5), seenAt: T(2) }))).toBe("awaiting");
    expect(sessionState(task() as never, S({ lastInputAt: T(1), lastStopAt: T(5), seenAt: T(6) }))).toBe("idle");
  });
  it("挂着待审动作 = 待你决定；卡住；Claude 已退出；没有会话", () => {
    expect(sessionState(task({ pending: [{}] }) as never, S({ status: "exited" }))).toBe("deciding");
    expect(sessionState(task({ status: "blocked" }) as never, S({ status: "exited" }))).toBe("blocked");
    expect(sessionState(task() as never, S({ status: "exited" }))).toBe("exited");
    expect(sessionState(task({ status: "understood" }) as never, undefined)).toBe("none");
    expect(sessionState(task() as never, S({ status: "closed" }))).toBe("none");
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @friday/core exec vitest run src/agent/sessionState.test.ts`
Expected: FAIL

- [ ] **Step 4: 实现** `apps/core/src/agent/sessionState.ts`

```ts
import type { SessionState, Task, TaskSession, TermSession } from "@friday/shared";
import { getTermSession } from "../memory/termSessions.js";
import { runByJob } from "../memory/runs.js";

export function sessionState(t: Pick<Task, "attention" | "pending" | "status">, s?: TermSession): SessionState {
  const alive = s?.status === "running" || s?.status === "preparing";
  if (alive && t.attention === "question") return "asking";
  if (alive && (s!.status === "preparing" || (s!.lastInputAt && (!s!.lastStopAt || s!.lastInputAt > s!.lastStopAt)))) return "working";
  if (alive && s!.lastStopAt && (!s!.seenAt || s!.lastStopAt > s!.seenAt)) return "awaiting";
  if (t.pending?.length) return "deciding";
  if (t.status === "blocked") return "blocked";
  if (s?.status === "exited") return "exited";
  return alive ? "idle" : "none";
}

export function taskSession(t: Task): TaskSession {
  const s = getTermSession(t.source.rootId ?? t.id);
  const own = s && s.id === t.id ? s : undefined;
  const state = sessionState(t, own);
  const waitingSince = (t.pending ?? []).map((p) => p.at).filter((x): x is string => Boolean(x)).sort()[0];
  const run = t.source.jobId ? runByJob(t.source.jobId) : undefined;
  const minutes = run?.endedAt ? Math.max(1, Math.round((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 60000)) : undefined;
  return {
    state,
    ...(own?.lastStopAt ? { lastStopAt: own.lastStopAt } : {}),
    ...(state === "deciding" && waitingSince ? { waitingSince } : {}),
    ...(own ? { name: own.tmuxName, kind: own.kind, ...(own.worktree ? { worktree: own.worktree } : {}), ...(own.branch ? { branch: own.branch } : {}) } : {}),
    ...(t.source.autonomous && run
      ? { delivery: { ...(run.filesChanged !== undefined ? { files: run.filesChanged } : {}), ...(run.insertions !== undefined ? { insertions: run.insertions } : {}), ...(run.deletions !== undefined ? { deletions: run.deletions } : {}), ...(run.costUsd !== undefined ? { costUsd: run.costUsd } : {}), ...(minutes ? { minutes } : {}), ...(run.model ? { model: run.model } : {}) } }
      : {}),
  };
}
```

  说明：缺陷（有 `rootId`）的 `own` 为空，状态只看它自己的 pending / blocked；它在需求会话里的进度由列表的阶段文字表达。

- [ ] **Step 5: 接线**
  - `memory/tasks.ts` `addPending`：`{ id: randomUUID(), at: new Date().toISOString(), ...action }`。
  - `api/tasks.ts` `GET /tasks`：`withTerminal` 换成 `const withSession = (t: Task): Task => ({ ...t, session: taskSession(t) });`，`tasks: board.tasks.map((t) => withSlack(withSession(t)))`；import `taskSession`；删 `terminalState` import。
  - `api/jobs.ts` `/jobs/:id/message`：`markStop(id)` 改为：

```ts
    if (event === "Stop" || (event === "SessionStart" && source === "resume") || (!event && text)) {
      const sid = getJob(id)?.sessionId;
      if (sid) markStop(sid);
      clearAttention(id);
    }
```

    `markStop` 从 `../memory/termSessions.js` 导入；删 `terminalState` import，`/jobs/:id/activity` 返回里的 `terminal` 字段改为 `session: getJob(id)?.sessionId ? getTermSession(getJob(id)!.sessionId!)?.status ?? "closed" : "closed"`。
  - `bridge.ts` `turnFinished`：

```ts
export function turnFinished(jobId: string, text: string): void {
  const task = findTaskBySource((s) => s.jobId === jobId);
  if (!task || task.source.autonomous || task.status !== "processing") return;
  updateTask(task.id, { progress: `这轮说完了：${text.replace(/\s+/g, " ").slice(0, 140)}` });
}
```

  - `bridge.ts` `friday_done` 交互式分支（约第 264 行 `attention: "review"`）去掉 `attention: "review"`，`progress` 改为 `这轮做完了：${report.summary}`（不拼旧值）。
  - `bridge.ts` `clearAttention`：只清 `question` / `blocked`，不再有 `review` 可清（逻辑不变，保留）。
  - `pipeline.ts` `onJobExit` 交互式分支的 `progress` 改为 `` `终端会话已结束（${exitText(exitCode)}）` ``，不拼「之前：」；`exitText(-1)` 文案改为 `"会话已不在"`。

- [ ] **Step 6: 全量测试与类型检查**

Run: `pnpm --filter @friday/core test && pnpm --filter @friday/core typecheck`
Expected: 全过。旧测试里断言 `attention: "review"` / 「这轮说完了」会话消息 / 「之前：」的，按新口径改断言（`bridge.test.ts`、`api/jobs.test.ts`）。

- [ ] **Step 7: 提交（含 Task 5）**

```bash
git add -A apps/core packages/shared
git commit -m "$(cat <<'EOF'
tmux 版说话 / 对账 / 收工，状态位只取终端里的现实

- 对账按 tmux list-sessions，列不出来时不动；缺陷收工不杀需求的会话
- Friday 不再删 worktree，遗留的列在 /worktrees/leftover
- 状态位七档，「等了 N」只从待审动作挂上的时刻算；Stop 不再写 attention review

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: attach 后端（node-pty 观众）与会话接口

**Files:**
- Create: `apps/core/src/agent/attach.ts`
- Create: `apps/core/src/api/sessions.ts`
- Create: `apps/core/src/api/sessions.test.ts`
- Modify: `apps/core/src/api/index.ts`
- Modify: `apps/core/package.json`（`node-pty: 1.1.0`）、根 `package.json`（`postinstall`）、`scripts/bundle-core.sh`

**Interfaces:**
- Consumes: Task 1 窗口 / 搜索 / 清屏命令、`tmuxArgs`；Task 2 `getTermSession` / `markInput` / `markSeen`
- Produces:
  - `setPtySpawner(fn: PtySpawner): void`（测试注入）
  - `attach(sessionId: string, tmuxName: string, cols: number, rows: number): string`（attachId）
  - `subscribe(attachId, fn: (chunk: string) => void): (() => void) | undefined`
  - `writeAttach(attachId, data): boolean`、`resizeAttach(attachId, cols, rows): boolean`、`detach(attachId): void`
  - HTTP：`POST /sessions/:id/attach {cols, rows}` → `{ attachId }`；`GET /sessions/:id/stream?attach=`（SSE，`data: {"d": "..."}`）；`POST /sessions/:id/input {attach, data}`；`POST /sessions/:id/resize {attach, cols, rows}`；`POST /sessions/:id/seen`；`GET /sessions/:id/windows`；`POST /sessions/:id/windows`（新窗口）；`POST /sessions/:id/windows/:idx/select`；`DELETE /sessions/:id/windows/:idx`；`POST /sessions/:id/split {dir}`；`POST /sessions/:id/search {q}`；`POST /sessions/:id/clear`；`POST /clipboard {text}`；`GET /terminal/prefs` → `{ fontFamily?: string; fontSize?: number }`

- [ ] **Step 1: 依赖** —— `apps/core/package.json` 的 `dependencies` 加 `"node-pty": "1.1.0"`；根 `package.json` 的 `scripts` 加 `"postinstall": "find node_modules -maxdepth 7 -path '*node-pty*' -name spawn-helper -type f -exec chmod +x {} +"`；`scripts/bundle-core.sh` 在 `pnpm deploy` 之后加回：

```bash
# node-pty 的 spawn-helper 复制后会丢可执行位，没有它 PTY 起不来。
find "$OUT/node_modules" -path "*node-pty*" -name spawn-helper -type f -print0 | xargs -0 chmod +x
```

  Run: `pnpm install`

- [ ] **Step 2: 写失败的测试** `apps/core/src/api/sessions.test.ts`

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "./index.js";
import { createTask } from "../memory/tasks.js";
import { getTermSession } from "../memory/termSessions.js";
import { setTmuxRunner } from "../agent/tmux.js";
import { openSession, setLauncher, worktreeReady } from "../agent/sessions.js";
import { setPtySpawner } from "../agent/attach.js";

let calls: string[][] = [];
let written: string[] = [];
beforeEach(() => {
  calls = [];
  written = [];
  setTmuxRunner(async (args) => {
    calls.push(args);
    if (args[0] === "-V") return "tmux 3.5a";
    if (args[4] === "list-windows") return "0|claude|1\n1|zsh|0\n";
    return "";
  });
  setLauncher(async () => {});
  setPtySpawner(() => ({ onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), write: (d) => void written.push(d), resize: () => {}, kill: () => {} }));
});
const post = (path: string, body: unknown = {}) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function session() {
  const t = createTask({ title: "会话接口", kind: "verbal", source: {}, status: "processing", project: "app" });
  const jobId = await openSession(t, t, { kind: "interactive", project: "app", repoDir: "/r/app", task: "x" });
  await worktreeReady(jobId, "/r/app-feat-api");
  return t.id;
}

describe("/sessions", () => {
  it("attach 后输入写进 pty，带回车才记输入时间", async () => {
    const id = await session();
    const { attachId } = (await (await post(`/sessions/${id}/attach`, { cols: 120, rows: 40 })).json()) as { attachId: string };
    const before = getTermSession(id)!.lastInputAt!;
    await new Promise((r) => setTimeout(r, 5));
    await post(`/sessions/${id}/input`, { attach: attachId, data: "ls" });
    expect(getTermSession(id)!.lastInputAt).toBe(before);
    await post(`/sessions/${id}/input`, { attach: attachId, data: "\r" });
    expect(written).toEqual(["ls", "\r"]);
    expect(getTermSession(id)!.lastInputAt! > before).toBe(true);
  });

  it("没有 attach 的输入 404", async () => {
    const id = await session();
    expect((await post(`/sessions/${id}/input`, { attach: "nope", data: "x" })).status).toBe(404);
  });

  it("seen 记看过时间", async () => {
    const id = await session();
    expect((await post(`/sessions/${id}/seen`)).status).toBe(200);
    expect(getTermSession(id)!.seenAt).toBeTruthy();
  });

  it("窗口：列出、新建在 worktree 里、只剩一个不关", async () => {
    const id = await session();
    const list = (await (await app.request(`/sessions/${id}/windows`)).json()) as Array<{ index: number; name: string }>;
    expect(list.map((w) => w.name)).toEqual(["claude", "zsh"]);
    await post(`/sessions/${id}/windows`);
    expect(calls.some((c) => c[4] === "new-window" && c.includes("/r/app-feat-api"))).toBe(true);
    expect((await app.request(`/sessions/${id}/windows/1`, { method: "DELETE" })).status).toBe(200);
  });

  it("不存在的会话 404", async () => {
    expect((await app.request(`/sessions/nope/windows`)).status).toBe(404);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @friday/core exec vitest run src/api/sessions.test.ts`
Expected: FAIL

- [ ] **Step 4: 实现** `apps/core/src/agent/attach.ts`

```ts
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { cleanEnv } from "./env.js";
import { tmuxArgs } from "./tmux.js";

export interface PtyLike {
  onData(fn: (d: string) => void): { dispose(): void };
  onExit(fn: () => void): { dispose(): void };
  write(d: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}
export type PtySpawner = (file: string, args: string[], opts: { cols: number; rows: number; env: Record<string, string> }) => PtyLike;

let spawner: PtySpawner = (file, args, opts) => {
  // esbuild 不打包原生模块，运行时 require
  const pty = createRequire(import.meta.url)("node-pty") as typeof import("node-pty");
  return pty.spawn(file, args, { name: "xterm-256color", ...opts });
};
export function setPtySpawner(fn: PtySpawner): void {
  spawner = fn;
}

interface Viewer { sessionId: string; pty: PtyLike; listeners: Set<(d: string) => void> }
const viewers = new Map<string, Viewer>();

export function attach(sessionId: string, tmuxName: string, cols: number, rows: number): string {
  const id = randomUUID();
  const env = { ...cleanEnv(process.env), TERM: "xterm-256color", COLORTERM: "truecolor", LANG: process.env.LANG ?? "zh_CN.UTF-8" } as Record<string, string>;
  const pty = spawner("tmux", tmuxArgs("attach-session", "-t", `=${tmuxName}`), { cols: clamp(cols, 20, 400), rows: clamp(rows, 5, 200), env });
  const v: Viewer = { sessionId, pty, listeners: new Set() };
  pty.onData((d) => v.listeners.forEach((l) => l(d)));
  pty.onExit(() => {
    v.listeners.forEach((l) => l("\r\n"));
    viewers.delete(id);
  });
  viewers.set(id, v);
  return id;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)));

export function viewerSession(attachId: string): string | undefined {
  return viewers.get(attachId)?.sessionId;
}

export function subscribe(attachId: string, fn: (d: string) => void): (() => void) | undefined {
  const v = viewers.get(attachId);
  if (!v) return undefined;
  v.listeners.add(fn);
  return () => {
    v.listeners.delete(fn);
    if (!v.listeners.size) detach(attachId);
  };
}

export function writeAttach(attachId: string, data: string): boolean {
  const v = viewers.get(attachId);
  if (!v) return false;
  v.pty.write(data);
  return true;
}

export function resizeAttach(attachId: string, cols: number, rows: number): boolean {
  const v = viewers.get(attachId);
  if (!v) return false;
  v.pty.resize(clamp(cols, 20, 400), clamp(rows, 5, 200));
  return true;
}

export function detach(attachId: string): void {
  const v = viewers.get(attachId);
  if (!v) return;
  viewers.delete(attachId);
  v.pty.kill();
}
```

- [ ] **Step 5: 实现** `apps/core/src/api/sessions.ts`

```ts
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { attach, resizeAttach, subscribe, viewerSession, writeAttach } from "../agent/attach.js";
import { clearHistory, killWindow, listWindows, newWindow, searchBack, selectWindow, splitWindow } from "../agent/tmux.js";
import { getTermSession, markInput, markSeen } from "../memory/termSessions.js";
import { publish } from "../bus.js";

const body = async <T extends z.ZodTypeAny>(c: { req: { json(): Promise<unknown> } }, schema: T) => schema.safeParse(await c.req.json().catch(() => null));
const cwdOf = (id: string) => { const s = getTermSession(id)!; return s.worktree ?? s.repoDir; };

export function ghosttyPrefs(file = join(homedir(), ".config", "ghostty", "config")): { fontFamily?: string; fontSize?: number } {
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch { return {}; }
  const val = (k: string) => text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith(k)).map((l) => l.split("=").slice(1).join("=").trim().replace(/^"|"$/g, "")).at(-1);
  const size = Number(val("font-size"));
  return { ...(val("font-family") ? { fontFamily: val("font-family")! } : {}), ...(size > 0 ? { fontSize: size } : {}) };
}

export const sessions = new Hono()
  .use("/sessions/:id/*", async (c, next) => (getTermSession(c.req.param("id")) ? next() : c.json({ error: "没有这个会话" }, 404)))
  .post("/sessions/:id/attach", async (c) => {
    const p = await body(c, z.object({ cols: z.number(), rows: z.number() }));
    if (!p.success) return c.json({ error: "cols / rows 必填" }, 400);
    const s = getTermSession(c.req.param("id"))!;
    return c.json({ attachId: attach(s.id, s.tmuxName, p.data.cols, p.data.rows) });
  })
  .get("/sessions/:id/stream", (c) => {
    const attachId = c.req.query("attach") ?? "";
    if (viewerSession(attachId) !== c.req.param("id")) return c.json({ error: "没有这个 attach" }, 404);
    return streamSSE(c, async (stream) => {
      await new Promise<void>((resolve) => {
        const off = subscribe(attachId, (d) => void stream.writeSSE({ data: JSON.stringify({ d }) }).catch(() => {}));
        if (!off) return resolve();
        const ping = setInterval(() => void stream.writeSSE({ data: JSON.stringify({ ping: 1 }) }).catch(() => {}), 15_000);
        stream.onAbort(() => { off(); clearInterval(ping); resolve(); });
      });
    });
  })
  .post("/sessions/:id/input", async (c) => {
    const p = await body(c, z.object({ attach: z.string(), data: z.string().max(65536) }));
    if (!p.success) return c.json({ error: "attach / data 必填" }, 400);
    if (viewerSession(p.data.attach) !== c.req.param("id") || !writeAttach(p.data.attach, p.data.data)) return c.json({ error: "没有这个 attach" }, 404);
    if (p.data.data.includes("\r")) { markInput(c.req.param("id")); publish({ type: "tasks" }); }
    return c.json({ ok: true });
  })
  .post("/sessions/:id/resize", async (c) => {
    const p = await body(c, z.object({ attach: z.string(), cols: z.number(), rows: z.number() }));
    if (!p.success) return c.json({ error: "attach / cols / rows 必填" }, 400);
    return resizeAttach(p.data.attach, p.data.cols, p.data.rows) ? c.json({ ok: true }) : c.json({ error: "没有这个 attach" }, 404);
  })
  .post("/sessions/:id/seen", (c) => {
    markSeen(c.req.param("id"));
    publish({ type: "tasks" });
    return c.json({ ok: true });
  })
  .get("/sessions/:id/windows", async (c) => c.json(await listWindows(getTermSession(c.req.param("id"))!.tmuxName)))
  .post("/sessions/:id/windows", async (c) => {
    await newWindow(getTermSession(c.req.param("id"))!.tmuxName, cwdOf(c.req.param("id")));
    return c.json({ ok: true });
  })
  .post("/sessions/:id/windows/:idx/select", async (c) => {
    await selectWindow(getTermSession(c.req.param("id"))!.tmuxName, Number(c.req.param("idx")));
    return c.json({ ok: true });
  })
  .delete("/sessions/:id/windows/:idx", async (c) => c.json({ closed: await killWindow(getTermSession(c.req.param("id"))!.tmuxName, Number(c.req.param("idx"))) }))
  .post("/sessions/:id/split", async (c) => {
    const p = await body(c, z.object({ dir: z.enum(["h", "v"]) }));
    if (!p.success) return c.json({ error: "dir 是 h 或 v" }, 400);
    await splitWindow(getTermSession(c.req.param("id"))!.tmuxName, cwdOf(c.req.param("id")), p.data.dir);
    return c.json({ ok: true });
  })
  .post("/sessions/:id/search", async (c) => {
    const p = await body(c, z.object({ q: z.string().min(1).max(200) }));
    if (!p.success) return c.json({ error: "q 必填" }, 400);
    await searchBack(getTermSession(c.req.param("id"))!.tmuxName, p.data.q);
    return c.json({ ok: true });
  })
  .post("/sessions/:id/clear", async (c) => {
    await clearHistory(getTermSession(c.req.param("id"))!.tmuxName);
    return c.json({ ok: true });
  })
  .post("/clipboard", async (c) => {
    const p = await body(c, z.object({ text: z.string().max(1_000_000) }));
    if (!p.success) return c.json({ error: "text 必填" }, 400);
    await new Promise<void>((resolve) => { const child = execFile("/usr/bin/pbcopy", () => resolve()); child.stdin?.end(p.data.text); });
    return c.json({ ok: true });
  })
  .get("/terminal/prefs", (c) => c.json(ghosttyPrefs()));
```

  `api/index.ts` 加 `import { sessions } from "./sessions.js";` 与 `.route("/", sessions)`。

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm --filter @friday/core exec vitest run src/api/sessions.test.ts && pnpm --filter @friday/core typecheck`
Expected: PASS

- [ ] **Step 7: 真机冒烟（不开窗口）**

```bash
FRIDAY_PORT=7791 FRIDAY_DATA_DIR=$(mktemp -d) FRIDAY_NO_SCHEDULER=1 pnpm --filter @friday/core dev &
sleep 4 && curl -s http://127.0.0.1:7791/health
```

Expected: JSON 里 `"tmux":"tmux 3.x"`（没装时是 `null`，先 `brew install tmux`）。结束后 `kill %1`。

- [ ] **Step 8: 提交**

```bash
git add -A apps/core package.json pnpm-lock.yaml scripts/bundle-core.sh
git commit -m "$(cat <<'EOF'
attach 后端：node-pty 跑 tmux attach 当观众，SSE 推输出；会话窗口 / 分屏 / 搜索 / 清屏 / 剪贴板接口

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: 前端内嵌终端

**Files:**
- Modify: `apps/desktop/package.json`
- Create: `apps/desktop/src/lib/sessions.ts`
- Create: `apps/desktop/src/views/Terminal.tsx`
- Modify: `apps/desktop/src/styles.css`

**Interfaces:**
- Consumes: Task 7 全部 HTTP 接口
- Produces:
  - `lib/sessions.ts`：`sessionWindows(id)`、`newSessionWindow(id)`、`selectSessionWindow(id, idx)`、`closeSessionWindow(id, idx)`、`splitSession(id, dir)`、`searchSession(id, q)`、`clearSession(id)`、`markSessionSeen(id)`、`terminalPrefs()`
  - `<Terminal sessionId={string} />`（自带窗口标签条）

- [ ] **Step 1: 依赖**

```bash
pnpm --filter @friday/desktop add @xterm/xterm@6.0.0 @xterm/addon-fit@0.11.0 @xterm/addon-web-links@0.12.0 @xterm/addon-webgl@0.19.0 @xterm/addon-unicode11 @xterm/addon-clipboard
```

- [ ] **Step 2: API 客户端** `apps/desktop/src/lib/sessions.ts`

```ts
import { coreBaseUrl } from "./core";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const base = await coreBaseUrl();
  const res = await fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}
const post = <T>(path: string, body: unknown = {}) => call<T>(path, { method: "POST", body: JSON.stringify(body) });
const S = (id: string) => `/sessions/${encodeURIComponent(id)}`;

export interface TmuxWindow { index: number; name: string; active: boolean }
export const sessionWindows = (id: string) => call<TmuxWindow[]>(`${S(id)}/windows`);
export const newSessionWindow = (id: string) => post(`${S(id)}/windows`);
export const selectSessionWindow = (id: string, idx: number) => post(`${S(id)}/windows/${idx}/select`);
export const closeSessionWindow = (id: string, idx: number) => call(`${S(id)}/windows/${idx}`, { method: "DELETE" });
export const splitSession = (id: string, dir: "h" | "v") => post(`${S(id)}/split`, { dir });
export const searchSession = (id: string, q: string) => post(`${S(id)}/search`, { q });
export const clearSession = (id: string) => post(`${S(id)}/clear`);
export const markSessionSeen = (id: string) => post(`${S(id)}/seen`).catch(() => undefined);
export const attachSession = (id: string, cols: number, rows: number) => post<{ attachId: string }>(`${S(id)}/attach`, { cols, rows });
export const terminalPrefs = () => call<{ fontFamily?: string; fontSize?: number }>("/terminal/prefs");
export const copyText = (text: string) => post("/clipboard", { text });
```

- [ ] **Step 3: 终端配色变量** —— `styles.css` 里恢复 `1668499^` 版本的 `--term-*` 那一段 `:root { … }`（`git show 1668499^:apps/desktop/src/styles.css | sed -n 2870,2897p` 取出），把 `--term-bg` 改为 `#05080c`（设计稿终端底色）。再加终端容器样式：

```css
.term { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.term__tabs { display: flex; align-items: center; gap: var(--s-1); font-size: var(--t-xs); }
.term__tab { padding: 4px 10px; border-radius: 6px 6px 0 0; color: var(--fg-3); background: none; border: 1px solid transparent; border-bottom: none; font: inherit; cursor: default; }
.term__tab[aria-current="true"] { background: rgba(56, 214, 255, 0.10); border-color: rgba(56, 214, 255, 0.16); color: var(--fg-1); }
.term__tab--add { color: var(--fg-4); }
.term__body { flex: 1; min-height: 0; border: 1px solid rgba(56, 214, 255, 0.16); border-radius: 0 var(--r-md) var(--r-md) var(--r-md); background: var(--term-bg); padding: 10px 12px; }
.term__body .xterm { height: 100%; }
.term__find { position: absolute; top: 8px; right: 12px; display: flex; gap: var(--s-1); }
.term__dead { padding: var(--s-4); color: var(--fg-3); }
```

- [ ] **Step 4: 组件** `apps/desktop/src/views/Terminal.tsx`

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { openUrl } from "@tauri-apps/plugin-opener";
import "@xterm/xterm/css/xterm.css";
import { coreBaseUrl } from "../lib/core";
import { attachSession, clearSession, closeSessionWindow, copyText, markSessionSeen, newSessionWindow, searchSession, selectSessionWindow, sessionWindows, splitSession, terminalPrefs, type TmuxWindow } from "../lib/sessions";

function termTheme(): Record<string, string> {
  const s = getComputedStyle(document.documentElement);
  const v = (n: string) => s.getPropertyValue(`--term-${n}`).trim();
  const names = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
  const bright = Object.fromEntries(names.map((n) => [`bright${n[0]!.toUpperCase()}${n.slice(1)}`, v(`bright-${n}`)]));
  return { background: v("bg"), foreground: v("fg"), cursor: v("cursor"), cursorAccent: v("bg"), selectionBackground: v("sel"), ...Object.fromEntries(names.map((n) => [n, v(n)])), ...bright };
}

export function Terminal({ sessionId }: { sessionId: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [windows, setWindows] = useState<TmuxWindow[]>([]);
  const [finding, setFinding] = useState(false);
  const [q, setQ] = useState("");
  const [dead, setDead] = useState(false);

  const refreshWindows = useCallback(() => void sessionWindows(sessionId).then(setWindows).catch(() => setWindows([])), [sessionId]);

  useEffect(() => {
    refreshWindows();
    const t = window.setInterval(refreshWindows, 2000);
    return () => window.clearInterval(t);
  }, [refreshWindows]);

  useEffect(() => {
    const seen = () => { if (document.hasFocus() && document.visibilityState === "visible") void markSessionSeen(sessionId); };
    seen();
    window.addEventListener("focus", seen);
    document.addEventListener("visibilitychange", seen);
    return () => { window.removeEventListener("focus", seen); document.removeEventListener("visibilitychange", seen); };
  }, [sessionId]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    setDead(false);
    const term = new XTerm({ fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace', fontSize: 13, lineHeight: 1.2, cursorBlink: true, allowProposedApi: true, macOptionClickForcesSelection: true, macOptionIsMeta: false, theme: termTheme() });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_e, uri) => void openUrl(uri)));
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    term.loadAddon(new ClipboardAddon(undefined, { readText: async () => "", writeText: async (_sel, text) => void (await copyText(text)) }));
    term.open(el);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {}
    void terminalPrefs().then((p) => {
      if (p.fontFamily) term.options.fontFamily = `"${p.fontFamily}", "JetBrains Mono", Menlo, monospace`;
      if (p.fontSize) term.options.fontSize = p.fontSize;
      fit.fit();
    }).catch(() => {});

    // 输入法组合期间 xterm 会把按键先编码发出去，字就丢了；组合结束由 onData 一次性送
    let composing = false;
    const ta = term.textarea;
    const onStart = () => { composing = true; };
    const onEnd = () => { setTimeout(() => { composing = false; }, 0); };
    ta?.addEventListener("compositionstart", onStart);
    ta?.addEventListener("compositionend", onEnd);

    let base = "";
    let attachId = "";
    const ctrl = new AbortController();
    const post = (path: string, body: unknown) => fetch(`${base}/sessions/${encodeURIComponent(sessionId)}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => undefined);
    let inflight = false;
    let pending = "";
    const drain = async () => {
      if (inflight || !pending || !attachId) return;
      inflight = true;
      while (pending) { const data = pending; pending = ""; await post("input", { attach: attachId, data }); }
      inflight = false;
    };
    const onData = term.onData((d) => { pending += d; void drain(); });

    term.attachCustomKeyEventHandler((e) => {
      if (composing || e.isComposing || e.keyCode === 229) return false;
      if (e.type !== "keydown" || !e.metaKey) return true;
      const k = e.key.toLowerCase();
      const act = (fn: () => unknown) => { e.preventDefault(); void Promise.resolve(fn()).then(refreshWindows); return false; };
      if (k === "t") return act(() => newSessionWindow(sessionId));
      if (k === "w") return act(() => { const w = windows.find((x) => x.active); return w ? closeSessionWindow(sessionId, w.index) : undefined; });
      if (k === "d") return act(() => splitSession(sessionId, e.shiftKey ? "v" : "h"));
      if (/^[1-9]$/.test(k)) return act(() => { const w = windows[Number(k) - 1]; return w ? selectSessionWindow(sessionId, w.index) : undefined; });
      if (k === "[" || k === "]") return act(() => { const i = windows.findIndex((x) => x.active); const w = windows[(i + (k === "]" ? 1 : -1) + windows.length) % windows.length]; return w ? selectSessionWindow(sessionId, w.index) : undefined; });
      if (k === "f") { e.preventDefault(); setFinding(true); return false; }
      if (k === "k") return act(() => clearSession(sessionId));
      if (k === "=" || k === "+") { e.preventDefault(); term.options.fontSize = (term.options.fontSize ?? 13) + 1; fit.fit(); return false; }
      if (k === "-") { e.preventDefault(); term.options.fontSize = Math.max(9, (term.options.fontSize ?? 13) - 1); fit.fit(); return false; }
      if (k === "0") { e.preventDefault(); term.options.fontSize = 13; fit.fit(); return false; }
      if (k === "c" && term.hasSelection()) { e.preventDefault(); void copyText(term.getSelection()); return false; }
      return true;
    });

    void (async () => {
      base = await coreBaseUrl();
      await new Promise((r) => requestAnimationFrame(r));
      fit.fit();
      try {
        attachId = (await attachSession(sessionId, term.cols, term.rows)).attachId;
      } catch {
        setDead(true);
        return;
      }
      void drain();
      const res = await fetch(`${base}/sessions/${encodeURIComponent(sessionId)}/stream?attach=${encodeURIComponent(attachId)}`, { signal: ctrl.signal }).catch(() => null);
      if (!res?.ok || !res.body) { setDead(true); return; }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let out = "";
      let raf = 0;
      const flush = () => { raf = 0; if (out) { term.write(out); out = ""; } };
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const data = buf.slice(0, i).split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
          buf = buf.slice(i + 2);
          try {
            const msg = JSON.parse(data) as { d?: string };
            if (msg.d) { out += msg.d; if (!raf) raf = requestAnimationFrame(flush); }
          } catch {}
        }
      }
      flush();
      if (!ctrl.signal.aborted) setDead(true);
    })();

    let resizeTimer = 0;
    const ro = new ResizeObserver(() => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => { fit.fit(); if (attachId) void post("resize", { attach: attachId, cols: term.cols, rows: term.rows }); }, 120);
    });
    ro.observe(el);
    return () => {
      ta?.removeEventListener("compositionstart", onStart);
      ta?.removeEventListener("compositionend", onEnd);
      onData.dispose();
      window.clearTimeout(resizeTimer);
      ro.disconnect();
      ctrl.abort();
      term.dispose();
    };
    // windows 故意不进依赖：快捷键里读的是最新窗口列表的闭包，重建终端代价太大
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  return (
    <div className="term">
      <div className="term__tabs" role="tablist" aria-label="终端窗口">
        {windows.map((w) => (
          <button key={w.index} role="tab" className="term__tab" aria-current={w.active} onClick={() => void selectSessionWindow(sessionId, w.index).then(refreshWindows)}>
            {w.index + 1} · {w.name}
          </button>
        ))}
        <button className="term__tab term__tab--add" aria-label="新窗口" onClick={() => void newSessionWindow(sessionId).then(refreshWindows)}>＋</button>
      </div>
      <div className="term__body" style={{ position: "relative" }}>
        <div ref={host} style={{ height: "100%" }} />
        {finding && (
          <form className="term__find" onSubmit={(e) => { e.preventDefault(); if (q.trim()) void searchSession(sessionId, q.trim()); setFinding(false); }}>
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setFinding(false); }} placeholder="在历史里往上找" aria-label="搜索终端历史" />
          </form>
        )}
        {dead && <div className="term__dead">会话已不在</div>}
      </div>
    </div>
  );
}
```

  注意：`windows` 在 key handler 闭包里是挂载那一刻的值。实现时把它放进 `useRef`（`windowsRef.current = windows`，handler 里读 `windowsRef.current`），替换上面三处 `windows`，并删掉那行 eslint 注释。

- [ ] **Step 5: 类型检查**

Run: `pnpm --filter @friday/desktop typecheck`
Expected: 通过

- [ ] **Step 6: 手动验证（Review Focus：中文输入法）** —— 这一步的接线在 Task 9 完成后才有入口，所以 Task 8 与 Task 9 连续做，本步骤在 Task 9 Step 8 一起执行：
  - 在内嵌终端里切拼音，输入「改一下账单页，合计没刷新？」，组合中按回车上屏：字不丢、不重、未提交；再按回车才提交。
  - `⌘T` 出现第二个标签；`⌘W` 关掉它；`⌘D` 左右分屏、`⌘⇧D` 上下分屏；`⌘F` 输入 `claude` 回车跳到历史里的匹配；`⌘K` 清屏；`⌘+` / `⌘-` / `⌘0` 字号。
  - 鼠标拖选后 `⌘V` 到别处，内容是刚选的（OSC 52 → pbcopy）。
  - 另开一个系统终端 `tmux -L friday attach -t <会话名>`，两边同屏。

---

### Task 9: 详情翻转：你在做的 = 终端，Friday 自主的 = 卡片

**Files:**
- Create: `apps/desktop/src/views/TaskHeader.tsx`
- Modify: `apps/desktop/src/views/Board.tsx`
- Modify: `apps/desktop/src/styles.css`
- Modify: `apps/desktop/src/lib/core.ts`（任务类型已带 `session`，无需改；`⌘K` 相关文案）

**Interfaces:**
- Consumes: shared `TaskSession` / `SESSION_STATE_LABEL`；Task 8 `<Terminal />`
- Produces: `<TaskHeader t={Task} onDetail={() => void} onToggleTerminal?={() => void} showingTerminal?={boolean} />`

- [ ] **Step 1: 头部组件** `apps/desktop/src/views/TaskHeader.tsx`（对应设计稿 Main / Card 顶部三行）

```tsx
import type { Task } from "@friday/shared";
import { SESSION_STATE_LABEL, STAGE_LABEL } from "@friday/shared";
import { Icon } from "./Icon";

const KIND: Record<string, string> = { slack: "Slack", meegle: "Meegle", verbal: "口头", doc: "文档", code: "代码", learn: "自学", handbook: "手册", okr_weekly: "OKR 周报", other: "其他" };
const hhmm = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }) : "");
const mmdd = (d?: string) => (d ? d.slice(5) : "");

export function waitedFor(iso: string): string {
  const m = Math.max(1, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return m < 60 ? `等了 ${m} 分钟` : m < 1440 ? `等了 ${Math.round(m / 60)} 小时` : `等了 ${Math.round(m / 1440)} 天`;
}

export function stateLabel(t: Task): string {
  const s = t.session;
  if (!s) return "";
  const label = SESSION_STATE_LABEL[s.state];
  return s.state === "deciding" && s.waitingSince ? `${label} · ${waitedFor(s.waitingSince)}` : label;
}

export function TaskHeader({ t, counts, onDetail, onToggleTerminal, showingTerminal, onPin }: {
  t: Task;
  counts: { defects: number; docs: number; convs: number };
  onDetail: () => void;
  onToggleTerminal?: () => void;
  showingTerminal?: boolean;
  onPin: () => void;
}) {
  const s = t.session;
  const state = s?.state ?? "none";
  const meta = [t.stage ? STAGE_LABEL[t.stage] : "", KIND[t.kind] ?? t.kind, t.project, t.source.feDue ? `排期 ${mmdd(t.source.feDue)}` : "", s?.lastStopAt ? `最近一轮 ${hhmm(s.lastStopAt)}` : ""].filter(Boolean);
  const hint = [counts.defects ? `${counts.defects} 条缺陷` : "", counts.docs ? `${counts.docs} 份资料` : "", counts.convs ? `${counts.convs} 段 Slack 讨论` : ""].filter(Boolean).join(" · ");
  const d = s?.delivery;
  const branchLine = [s?.worktree, s?.branch, t.source.autonomous ? "Friday 自主" : "", d?.model, d?.costUsd !== undefined ? `$${d.costUsd.toFixed(2)}` : "", d?.minutes ? `${d.minutes} 分钟` : ""].filter(Boolean).join(" · ");
  return (
    <div className="th">
      <div className="th__meta">
        {stateLabel(t) && <span className={`th__state th__state--${state}`}><span className={`sdot sdot--${state}`} />{stateLabel(t)}</span>}
        {meta.map((m, i) => <span key={i} className="th__m">{(stateLabel(t) || i > 0) && <span className="th__sep">·</span>}{m}</span>)}
        <span className="th__sp" />
        <button className={`th__pin ${t.pinned ? "is-on" : ""}`} onClick={onPin}>{t.pinned ? "★ 已关注" : "☆ 关注"}</button>
      </div>
      <div className="th__title">
        <h2>{t.title}</h2>
        <button className="th__detail" onClick={onDetail}><Icon name="panel" />详情</button>
        {hint && <span className="th__hint">{hint}</span>}
      </div>
      {(branchLine || onToggleTerminal) && (
        <div className="th__branch">
          <span>{branchLine}</span>
          <span className="th__sp" />
          {onToggleTerminal && <button className="th__btn" onClick={onToggleTerminal}>{showingTerminal ? "看交付" : "看终端"}</button>}
        </div>
      )}
    </div>
  );
}
```

  `Icon.tsx` 里加一个 `panel` 图标（与设计稿同形：矩形 + 一条横线 + 左侧竖线）：

```tsx
  panel: "M3 4h18v16H3z M3 10h18 M9 10v10",
```

  （按 `Icon.tsx` 现有 path 表的写法加一项；描边 1.5px 与其他图标一致。）

- [ ] **Step 2: 样式**（值取自设计稿 Main.dc.html）

```css
.th { display: flex; flex-direction: column; gap: 8px; padding: 14px 20px 0; }
.th__meta { display: flex; align-items: center; gap: 10px; font-size: 12px; color: var(--fg-3); }
.th__state { display: inline-flex; align-items: center; gap: 7px; font-weight: 500; }
.th__state--asking, .th__state--blocked { color: #ff5d6c; }
.th__state--working { color: #38d6ff; }
.th__state--awaiting, .th__state--deciding { color: #f2b144; }
.th__state--exited { color: var(--fg-3); }
.th__sep { margin-right: 10px; color: var(--fg-4); }
.th__sp { flex: 1; }
.th__pin { background: none; border: none; color: var(--fg-4); font: inherit; cursor: default; }
.th__pin.is-on { color: #f2b144; }
.th__title { display: flex; align-items: center; gap: 10px; }
.th__title h2 { margin: 0; font-size: 22px; font-weight: 600; color: var(--fg-1); letter-spacing: -0.01em; }
.th__detail { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px 3px 8px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.10); background: transparent; color: var(--fg-2); font-size: 11.5px; font-family: inherit; cursor: default; }
.th__hint { font-size: 11.5px; color: var(--fg-4); }
.th__branch { display: flex; align-items: center; gap: 6px; padding-bottom: 10px; font-size: 11.5px; color: var(--fg-4); }
.th__btn { padding: 4px 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.10); background: transparent; color: var(--fg-2); font-size: 11.5px; font-family: inherit; cursor: default; }
.sdot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
.sdot--asking, .sdot--blocked { background: #ff5d6c; }
.sdot--working { background: #38d6ff; box-shadow: 0 0 8px #38d6ff; }
.sdot--awaiting, .sdot--deciding { background: #f2b144; }
.sdot--exited { border: 1.5px solid var(--fg-3); box-sizing: border-box; }
.sdot--idle, .sdot--none { background: rgba(125, 139, 153, 0.35); }
.detail { flex: 1; min-width: 0; display: flex; flex-direction: column; border-radius: 12px; border: 1px solid rgba(56,214,255,0.14); background: rgba(8,13,20,0.82); overflow: hidden; }
.detail__term { flex: 1; min-height: 0; display: flex; flex-direction: column; margin: 0 20px 16px; }
.detail__card { flex: 1; min-height: 0; overflow: auto; margin: 0 20px 16px; }
```

  `prefers-reduced-motion` 下 `.sdot--working` 去掉 `box-shadow` 动画（本身是静态阴影，不需要额外处理）。

- [ ] **Step 3: Board 布局** —— `Board.tsx` 的 `Board` 组件渲染部分（约 748–830 行）：
  1. 删除整个 `{board && view !== "ledger" && (<div className="gauges">…</div>)}` 块，以及 `Gauge` 组件和 `liveTerminals` / `byStage` 里只供它用的计算。
  2. 删除页头问候那行 `<p className="q__sub">…`。
  3. `deck__stage` 里：搜索框保留，但删掉 `find__n` 以外的快捷键角标（本来就没有）；`deck__scroll` 整段替换为只渲染选中的那一条：

```tsx
            <div className="deck__one">
              {!board ? null : focus ? (
                <Detail key={focus.id} t={focus} all={board.tasks} busy={busyIds.has(focus.id)} onAct={act} onPick={setSelectedId} onStartPack={(items) => void startPack(items)} packBusy={packBusy} onDetail={() => setDialogFor(focus.id)} />
              ) : (
                <div className="empty">
                  <strong>{q ? "没有匹配的任务" : "没有等你决定的事"}</strong>
                  {q ? "换个词试试，或者按 Esc 清空。" : "⌘N 问 Friday，或者等 Slack 和 Meegle 来活。"}
                </div>
              )}
            </div>
```

  4. 删除 `deck__cmd`（`↑↓ 翻页 / ⌘K 搜索 / 01 / 09`）整块。
  5. 删除约 700–712 行那个给 `.deck__card` 挂 IntersectionObserver 的 effect（选中不再由滚动决定）。
  6. 键盘 effect（约 712–720 行）改为：`⌘P` 聚焦搜索框（原来的 `k` 换成 `p`）；`⌘↑` / `⌘↓` 任何时候切上一条 / 下一条（`flat` 里前后邻居）；不带 ⌘ 的 `↑↓` 只在焦点不在输入框和 `.xterm` 里时切；原来回车 = 主动作的逻辑保留给卡片形态。
  7. 新增 state：`const [dialogFor, setDialogFor] = useState<string | null>(null);`（Task 10 用）。

- [ ] **Step 4: `Detail` 组件**（加在 `Board.tsx`，`Focus` 之前）

```tsx
function Detail({ t, all, busy, onAct, onPick, onStartPack, packBusy, onDetail }: {
  t: Task; all: Task[]; busy: boolean;
  onAct: (t: Task | null, fn: () => Promise<unknown>) => Promise<void>;
  onPick: (id: string) => void; onStartPack: (items: Task[]) => void; packBusy: boolean; onDetail: () => void;
}) {
  const s = t.session;
  const hasTerm = Boolean(s?.name) && s!.state !== "none";
  const autonomous = Boolean(t.source.autonomous);
  const [showTerm, setShowTerm] = useState(!autonomous);
  const counts = {
    defects: all.filter((x) => x.source.rootId === t.id || (t.source.meegleId && x.source.linkedStoryId === t.source.meegleId)).length,
    docs: (t.source.docs ?? []).length,
    convs: (t.conversations ?? []).length,
  };
  const termVisible = hasTerm && (!autonomous || showTerm);
  return (
    <section className="detail">
      <TaskHeader t={t} counts={counts} onDetail={onDetail} onPin={() => void onAct(t, () => taskPin(t.id, !t.pinned))} {...(autonomous && hasTerm ? { onToggleTerminal: () => setShowTerm((v) => !v), showingTerminal: showTerm } : {})} />
      {termVisible ? (
        <div className="detail__term"><Terminal sessionId={t.id} /></div>
      ) : (
        <div className="detail__card">
          <Focus t={t} all={all} active busy={busy} onAct={onAct} onClose={() => {}} onPick={onPick} onStartPack={onStartPack} packBusy={packBusy} closable={false} embedded />
        </div>
      )}
    </section>
  );
}
```

  （`t.source.docs ?? []` 在 Task 12 之前是对象，这里先写 `Object.keys(t.source.docs ?? {}).length`，Task 12 改成数组长度。`taskPin` 是 `Board.tsx` 里已有的关注接口封装，名字以文件里为准。）

  非根任务（缺陷，有 `rootId`）没有自己的 `session.name`，走卡片；卡片里「在需求的会话里改」由 Task 10 的弹窗和列表行表达。

- [ ] **Step 5: `Focus` 瘦身** —— 给 `Focus` 加 `embedded?: boolean` 参数；`embedded` 时不渲染它自己的头部（`fx__meta` 状态行和标题，已由 `TaskHeader` 负责）。并**删除**以下块（按文中标记搜索）：
  - 两处 `<span className="k">PROGRESS</span>` 所在的 section
  - `<div className="fx__doing">` 整块（「终端在做」）及其 5 秒轮询 `jobActivity` 的 effect
  - `<div className="fx__foot" ref={footRef}>` 整块（底部操作条）及 `footRef` 相关 effect；「通过并执行 / 打回 / 忽略」等动作在 Task 10 进「···」、在 Task 11 进会话
  - `fx__talk`（卡片中段「和 Friday 聊这条任务」）整块
  - 「这条任务的账」折叠块，换成一行 `<a className="fx__ledger" onClick={() => onAct(null, async () => nav("ledger", t.id))}>操作记录 · N 条 →</a>`（`nav` 为 Board 已有的视图切换，以文件里的签名为准）
  - 「重开终端 / 打开终端」按钮（约 1579、1583 行）
  - `TaskBody` 里的 `SCHEDULE` 块（约 256–261 行）
  自主任务卡片的段落顺序调成设计稿 Card.dc.html：交付报告 + 截图 → 等你点头的动作（琥珀边框）→ 通过前请确认 `n / N` → 改动（用 `t.session.delivery` 的 `files / insertions / deletions` 画一行「N 个文件 · +a −b · 相对 main」，逐文件列表用 `report.changes`）→ 阶段条 + Meegle；右列资料、Slack 讨论、操作记录链接。

- [ ] **Step 6: 列表行** —— 右侧 `anchors` 列表每行（约 814–828 行）：
  - 点：`<span className={`sdot sdot--${t.session?.state ?? "none"}`} />` 替换 `dot dot--${t.attention ?? t.status}`；缺陷行（有 `rootId` 或被 `nested` 判定）用小一号灰点 `sdot sdot--none` 并加 `an--child` 缩进。
  - 灰字 `anchorSub` 改为：

```ts
function anchorLine(t: Task): string {
  const s = t.session;
  if (t.source.rootId || t.source.linkedStoryId) return [`缺陷 #${t.source.meegleId ?? t.id.slice(0, 6)}`, t.stage ? STAGE_LABEL[t.stage] : "", t.source.rootId ? "在需求的会话里改" : ""].filter(Boolean).join(" · ");
  if (t.source.autonomous && t.report) {
    const d = s?.delivery;
    return ["交付了", d?.files !== undefined ? `${d.files} 个文件` : "", t.report.testResult.slice(0, 12), d?.costUsd !== undefined ? `$${d.costUsd.toFixed(2)}` : ""].filter(Boolean).join(" · ");
  }
  return [stateLabel(t), s?.lastStopAt ? `最近一轮 ${new Date(s.lastStopAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}` : "", t.source.feDue ? `排期 ${t.source.feDue.slice(5)}` : ""].filter(Boolean).join(" · ") || anchorSub(t, 0, 0);
}
```

  - 灰字颜色：`asking` 红、`deciding` / `awaiting` 琥珀，其余 `--fg-3`。
  - 列表底部加一行 `<button className="anchors__done">已完成 {n} ›</button>`，点开把 done 分组展开（沿用现有「最近完成」分组的数据）。

- [ ] **Step 7: 类型检查**

Run: `pnpm --filter @friday/desktop typecheck`
Expected: 通过

- [ ] **Step 8: 浏览器验收**

```bash
FRIDAY_PORT=7791 FRIDAY_DATA_DIR=$(mktemp -d) FRIDAY_NO_SCHEDULER=1 pnpm --filter @friday/core dev &
VITE_FRIDAY_PORT=7791 pnpm --filter @friday/desktop exec vite --port 1421 &
```

  用 agent-browser 打开 `http://127.0.0.1:1421`：建一条口头任务、项目选一个真实仓库、点「开始做」，等准备段建出 worktree。然后：
  - 执行 Task 8 Step 6 的全部手动项。
  - 按 spec §12「Main.dc.html」逐条对图，截图存 `<dataDir>/runs/design-check/task9-main-*.png`；再把一条任务设成 `autonomous` 带报告（在临时库里直接改 `tasks` 行），对「Card.dc.html」里头部与左列顺序那几条。
  - 刷新页面（前端重连）与重启 core（`kill` 再起）各一次：终端重新接上、历史还在（滚轮进 copy-mode 能翻）、状态位正确。

- [ ] **Step 9: 提交**

```bash
git add -A apps/desktop
git commit -m "$(cat <<'EOF'
任务详情翻转：你在做的详情就是终端，Friday 自主的是交付卡；状态位与列表行按设计稿

删掉页头统计卡、翻页提示、终端在做、PROGRESS、SCHEDULE、底部操作条、重开终端按钮；搜索改 ⌘P，⌘↑↓ 切任务。
§12 Main 小节 5/5 条已对，Card 头部与左列顺序已对。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: 详情弹窗

**Files:**
- Create: `apps/desktop/src/views/TaskDialog.tsx`
- Modify: `apps/desktop/src/views/Board.tsx`（抽出 `StageChips`、`SlackConvs`；挂弹窗）
- Modify: `apps/desktop/src/styles.css`

**Interfaces:**
- Consumes: Task 9 `dialogFor` state；`Board.tsx` 里已有的阶段拨动、Slack 讨论渲染、`TaskMenu` 动作
- Produces: `<TaskDialog t={Task} all={Task[]} onClose={() => void} onAct={…} chat={ReactNode} />`

- [ ] **Step 1: 抽组件** —— 从 `TaskBody` / `Focus` 里把两段渲染原样抽成导出函数，行为不变：
  - `StageChips({ t, onAct })`：五个阶段 chip + 「Friday 推的，原来在「…」」那行（搜 `STAGE_ORDER.map` 定位）。
  - `SlackConvs({ t, onAct })`：「Slack 里的讨论」整块（搜 `Slack 里的讨论` 定位），含「不是这条」「把 #频道 都归到这条」。
  原位置改为调用这两个组件。

- [ ] **Step 2: 弹窗** `apps/desktop/src/views/TaskDialog.tsx`（对应设计稿 Drawer.dc.html）

```tsx
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Task } from "@friday/shared";
import { STAGE_LABEL } from "@friday/shared";

export interface DialogAction { label: string; run: () => void }

export function TaskDialog({ t, defects, stage, meegle, resources, slack, chat, actions, onClose, onAdopt, onReject }: {
  t: Task;
  defects: Task[];
  stage: ReactNode;
  meegle: ReactNode;
  resources: ReactNode;
  slack: ReactNode;
  chat: ReactNode;
  actions: DialogAction[];
  onClose: () => void;
  onAdopt: (d: Task) => void;
  onReject: (d: Task) => void;
}) {
  const [menu, setMenu] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); menu ? setMenu(false) : onClose(); } };
    window.addEventListener("keydown", onKey);
    box.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [menu, onClose]);
  return (
    <div className="tdlg__veil" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="tdlg" role="dialog" aria-modal="true" aria-label="任务详情" tabIndex={-1} ref={box}>
        <div className="tdlg__head">
          <span className="tdlg__title">{t.title}</span>
          <span className="tdlg__sub">详情</span>
          <span className="th__sp" />
          <div className="tdlg__menuwrap">
            <button className="tdlg__icon" aria-label="更多操作" aria-expanded={menu} onClick={() => setMenu((v) => !v)}>···</button>
            {menu && (
              <div className="tdlg__menu" role="menu">
                {actions.map((a) => <button key={a.label} role="menuitem" onClick={() => { setMenu(false); a.run(); }}>{a.label}</button>)}
              </div>
            )}
          </div>
          <button className="tdlg__icon" aria-label="关闭" onClick={onClose}>×</button>
        </div>
        <div className="tdlg__cols">
          <div className="tdlg__left">
            {stage}
            {meegle}
            {defects.length > 0 && (
              <section className="tdlg__sec">
                <div className="tdlg__k">名下的缺陷</div>
                {defects.map((d) => {
                  const guess = d.source.rootGuess;
                  return (
                    <div key={d.id} className={`tdlg__defect ${guess ? "is-guess" : ""}`}>
                      <span className={`sdot sdot--${d.stage === "testing" ? "none" : "idle"}`} />
                      <span className="tdlg__dt">{guess && <span className="tdlg__guess">Friday 推断</span>}{d.title}</span>
                      {guess ? (
                        <>
                          <button className="tdlg__link" onClick={() => onAdopt(d)}>是它，进会话</button>
                          <button className="tdlg__link tdlg__link--dim" onClick={() => onReject(d)}>不是这条</button>
                        </>
                      ) : (
                        <span className="tdlg__dm">{[`#${d.source.meegleId ?? d.id.slice(0, 6)}`, d.stage ? STAGE_LABEL[d.stage] : "", d.source.rootId ? "已在这个终端里改" : ""].filter(Boolean).join(" · ")}</span>
                      )}
                    </div>
                  );
                })}
              </section>
            )}
            {t.understanding && (
              <section className="tdlg__sec">
                <div className="tdlg__k">理解</div>
                <div className="tdlg__text">{t.understanding}</div>
              </section>
            )}
          </div>
          <div className="tdlg__right">
            {resources}
            {slack}
          </div>
        </div>
        <div className="tdlg__chat">{chat}</div>
      </div>
    </div>
  );
}
```

  `TaskSource` 加 `rootGuess?: boolean`（shared）：Slack 挂靶为 `guess` 边建出的任务带上它；本轮只有显示，「是它，进会话」= 去掉 `rootGuess` 并调 `POST /tasks/:id/start`（会走 `joinRootSession`），「不是这条」= 现有 unlink 接口 + 去掉 `rootId`。core 侧加一个 `POST /tasks/:id/root {adopt: boolean}` 路由完成这两件事（在 `api/tasks.ts`，逻辑：`adopt` 时 `updateTask(id, { source: { rootGuess: undefined } })` 后复用 start 的实现；否则 `updateTask(id, { source: { rootId: undefined, rootGuess: undefined } })`）并各记一条账（`root_adopted` / `root_rejected`）。

- [ ] **Step 3: 样式**（值取自 Drawer.dc.html）

```css
.tdlg__veil { position: fixed; inset: 0; z-index: 50; display: flex; align-items: center; justify-content: center; background: rgba(5, 8, 12, 0.45); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); }
.tdlg { width: min(1040px, calc(100vw - 64px)); max-height: calc(100vh - 80px); overflow: auto; display: flex; flex-direction: column; gap: 16px; padding: 22px 26px 20px; border-radius: 12px; border: 1px solid rgba(56,214,255,0.28); background: rgba(10,16,24,0.98); box-shadow: 0 24px 60px rgba(0,0,0,0.6); font-size: 12.5px; outline: none; }
.tdlg__head { display: flex; align-items: center; gap: 10px; }
.tdlg__title { font-size: 13px; font-weight: 600; color: var(--fg-1); }
.tdlg__sub { font-size: 11.5px; color: var(--fg-4); }
.tdlg__icon { width: 26px; height: 26px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.10); background: transparent; color: var(--fg-3); font-size: 13px; cursor: default; }
.tdlg__menuwrap { position: relative; }
.tdlg__menu { position: absolute; right: 0; top: 30px; min-width: 160px; display: flex; flex-direction: column; padding: 4px; border-radius: 8px; border: 1px solid rgba(56,214,255,0.22); background: rgba(10,16,24,0.98); box-shadow: var(--shadow-pop); z-index: 1; }
.tdlg__menu button { text-align: left; padding: 7px 10px; border-radius: 6px; border: none; background: none; color: var(--fg-2); font: inherit; cursor: default; }
.tdlg__menu button:hover, .tdlg__menu button:focus-visible { background: rgba(56,214,255,0.10); color: var(--fg-1); }
.tdlg__cols { display: flex; gap: 28px; }
.tdlg__left { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 16px; }
.tdlg__right { width: 360px; flex-shrink: 0; display: flex; flex-direction: column; gap: 16px; }
.tdlg__sec { display: flex; flex-direction: column; gap: 8px; }
.tdlg__k { font-size: 11px; letter-spacing: 0.1em; color: var(--fg-4); }
.tdlg__text { color: var(--fg-2); line-height: 1.7; }
.tdlg__defect { display: flex; align-items: center; gap: 10px; padding: 6px 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.08); }
.tdlg__defect.is-guess { border-style: dashed; border-color: rgba(255,255,255,0.14); }
.tdlg__dt { flex: 1; min-width: 0; color: var(--fg-2); }
.tdlg__guess { color: var(--fg-3); margin-right: 6px; }
.tdlg__dm { color: var(--fg-3); font-size: 11.5px; }
.tdlg__link { background: none; border: none; color: #38d6ff; font: inherit; font-size: 11.5px; cursor: default; }
.tdlg__link--dim { color: var(--fg-4); }
.tdlg__chat { padding-top: 14px; border-top: 1px solid rgba(255,255,255,0.08); }
```

- [ ] **Step 4: 挂到 Board** —— `Board` 渲染末尾（`menu && <TaskMenu …>` 旁边）加：

```tsx
      {dialogTask && (
        <TaskDialog
          t={dialogTask}
          defects={board!.tasks.filter((x) => x.source.rootId === dialogTask.id || (dialogTask.source.meegleId && x.source.linkedStoryId === dialogTask.source.meegleId))}
          stage={<StageChips t={dialogTask} onAct={act} />}
          meegle={<MeegleChips t={dialogTask} />}
          resources={<Resources t={dialogTask} onAct={act} />}
          slack={<SlackConvs t={dialogTask} onAct={act} />}
          chat={<TaskChat t={dialogTask} />}
          actions={[
            { label: "标记完成", run: () => void act(dialogTask, () => taskDone(dialogTask.id)) },
            ...(dialogTask.source.nodeKey ? [{ label: "完成当前节点", run: () => void act(dialogTask, () => meegleFinishNode(dialogTask.id)) }] : []),
            { label: "忽略", run: () => void act(dialogTask, () => taskIgnore(dialogTask.id)) },
            { label: "归到项目…", run: () => setEditing(dialogTask) },
            { label: "操作记录", run: () => { setDialogFor(null); nav("ledger", dialogTask.id); } },
          ]}
          onClose={() => setDialogFor(null)}
          onAdopt={(d) => void act(d, () => taskRoot(d.id, true))}
          onReject={(d) => void act(d, () => taskRoot(d.id, false))}
        />
      )}
```

  其中 `const dialogTask = dialogFor ? board?.tasks.find((x) => x.id === dialogFor) : undefined;`；`taskDone` / `taskIgnore` / `meegleFinishNode` / `nav` 用 `Board.tsx` 与 `lib/core.ts` 里现有的同义函数（名字以文件为准，原来底部操作条上三个按钮调的就是它们）；`taskRoot` 在 `lib/core.ts` 新增 `POST /tasks/:id/root`。`Resources` 在 Task 12 之前先放 `<></>`，`TaskChat` 在 Task 11 之前先放 `<></>`，**这两处占位在各自 Task 里必须替换**。

- [ ] **Step 5: 类型检查与浏览器验收**

Run: `pnpm --filter @friday/desktop typecheck`

  浏览器里点「详情」：按 spec §12「Drawer.dc.html」逐条对图（会话栏那条等 Task 11 再勾），截图存 `design-check/task10-*.png`。键盘：`Esc` 先关菜单再关弹窗、Tab 在弹窗内循环不漏到后面。

- [ ] **Step 6: 提交**

```bash
git add -A apps/desktop apps/core packages/shared
git commit -m "$(cat <<'EOF'
详情弹窗：整页居中毛玻璃，阶段 / Meegle / 名下缺陷 / 理解 / 资料 / Slack，操作收进 ···

§12 Drawer 小节 5/6 条已对（会话栏随会话组件一起）。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: 每条任务一段会话、会话组件统一、@ 引入、会话里改状态

**Files:**
- Modify: `apps/core/src/memory/tasks.ts`（`createTask` 建会话）、`apps/core/src/memory/db.ts`（迁移）
- Modify: `apps/core/src/api/tasks.ts`（删 `/tasks/:id/conversation`；加 `GET /tasks/:id/mentions`、`POST /tasks/:id/mention`）
- Modify: `apps/core/src/agent/pipeline.ts`（抽 `rejectTask`）
- Modify: `apps/core/src/agent/tools.ts`（`task_approve`、`task_reject`）
- Create: `apps/core/src/api/mentions.test.ts`
- Modify: `apps/desktop/src/views/Thread.tsx`（紧凑样式统一、`@` 弹层）
- Modify: `apps/desktop/src/views/Board.tsx`（`TaskChat`）

**Interfaces:**
- Consumes: 现有 `createConversation`、`executePending`、`attachments` 存储
- Produces:
  - `rejectTask(id: string, reason?: string): Task | undefined`
  - `GET /tasks/:id/mentions?q=` → `Array<{ kind: "file" | "doc" | "shot"; label: string; ref: string }>`
  - `POST /tasks/:id/mention {kind, ref}` → `{ attachmentId?: string; text?: string }`
  - 工具 `task_approve({ actionId?: string, text?: string })`、`task_reject({ reason: string })`
  - `<Thread … mentionsFor?: string />`（任务 id；有它时输入框支持 `@`）

- [ ] **Step 1: 写失败的测试** `apps/core/src/api/mentions.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { app } from "./index.js";
import { createTask, getTask } from "../memory/tasks.js";
import { conversationExists } from "../memory/conversations.js";

describe("任务会话与 @ 引入", () => {
  it("建任务就有且只有一段会话", () => {
    const t = createTask({ title: "有会话", kind: "verbal", source: {} });
    expect(t.source.conversationId).toBeTruthy();
    expect(conversationExists(t.source.conversationId!)).toBe(true);
  });

  it("@ 列出 worktree 里的文件、资料、截图；选文件变成附件", async () => {
    const wt = mkdtempSync(join(tmpdir(), "app-feat-mention-"));
    execFileSync("git", ["init", "-q", wt]);
    writeFileSync(join(wt, "useExportJob.ts"), "export const x = 1;\n");
    execFileSync("git", ["-C", wt, "add", "."]);
    const t = createTask({ title: "引入", kind: "verbal", source: { worktree: wt } });
    const list = (await (await app.request(`/tasks/${t.id}/mentions?q=export`)).json()) as Array<{ kind: string; label: string; ref: string }>;
    expect(list).toContainEqual({ kind: "file", label: "useExportJob.ts", ref: "useExportJob.ts" });
    const r = (await (await app.request(`/tasks/${t.id}/mention`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "file", ref: "useExportJob.ts" }) })).json()) as { attachmentId?: string };
    expect(r.attachmentId).toBeTruthy();
  });

  it("引入的文件不能逃出 worktree", async () => {
    const wt = mkdtempSync(join(tmpdir(), "app-feat-escape-"));
    const t = createTask({ title: "越界", kind: "verbal", source: { worktree: wt } });
    const res = await app.request(`/tasks/${t.id}/mention`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "file", ref: "../../etc/passwd" }) });
    expect(res.status).toBe(400);
    expect(getTask(t.id)).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @friday/core exec vitest run src/api/mentions.test.ts`
Expected: FAIL

- [ ] **Step 3: 建任务即建会话** —— `memory/tasks.ts` `createTask`：插入前

```ts
  const conversationId = input.source.conversationId ?? createConversation().id;
  const source = { ...input.source, conversationId };
```

  INSERT 里用 `JSON.stringify(source)`；import `createConversation`（若 `conversations.ts` 反向依赖 `tasks.ts` 造成环，用 `await import` 不可行——`createTask` 是同步的；此时把 `createConversation` 的 SQL 两行直接内联进 `createTask`：`INSERT INTO conversations (id, created_at, updated_at) VALUES (?, ?, ?)`）。
  `db.ts` `migrate()` 末尾加：给 `status NOT IN ('done','ignored')` 且 `json_extract(source,'$.conversationId') IS NULL` 的任务各建一段会话并写回（用 `randomUUID()` + 两条 SQL，逐行处理）。
  `api/tasks.ts` 删 `/tasks/:id/conversation` 路由；前端 `taskBindConversation` 调用处（`Board.tsx`）一并删，会话永远在 `t.source.conversationId`。

- [ ] **Step 4: @ 接口** —— `api/tasks.ts` 加：

```ts
  .get("/tasks/:id/mentions", (c) => {
    const t = getTask(c.req.param("id"));
    if (!t) return c.json({ error: "任务不存在" }, 404);
    const q = (c.req.query("q") ?? "").toLowerCase();
    const wt = t.source.worktree ?? (t.source.rootId ? getTask(t.source.rootId)?.source.worktree : undefined);
    let files: string[] = [];
    if (wt) {
      try {
        files = execFileSync("git", ["-C", wt, "ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8", timeout: 5_000, maxBuffer: 16 * 1024 * 1024 }).split("\n").filter(Boolean);
      } catch {}
    }
    const hit = (s: string) => !q || s.toLowerCase().includes(q);
    return c.json([
      ...files.filter(hit).slice(0, 20).map((f) => ({ kind: "file" as const, label: f.split("/").pop() ?? f, ref: f })),
      ...docList(t).filter((d) => hit(d.title ?? d.url)).map((d) => ({ kind: "doc" as const, label: d.title ?? d.url, ref: d.url })),
      ...(t.report?.screenshots ?? []).filter((s) => hit(s.name)).map((s) => ({ kind: "shot" as const, label: s.name, ref: s.id })),
    ]);
  })
  .post("/tasks/:id/mention", async (c) => {
    const p = z.object({ kind: z.enum(["file", "doc", "shot"]), ref: z.string().min(1).max(1000) }).safeParse(await c.req.json().catch(() => null));
    const t = getTask(c.req.param("id"));
    if (!p.success || !t) return c.json({ error: "kind / ref 必填" }, 400);
    if (p.data.kind === "shot") return c.json({ attachmentId: p.data.ref });
    if (p.data.kind === "doc") return c.json({ text: p.data.ref });
    const wt = t.source.worktree ?? (t.source.rootId ? getTask(t.source.rootId)?.source.worktree : undefined);
    const abs = wt ? resolve(wt, p.data.ref) : "";
    if (!wt || !abs.startsWith(resolve(wt) + sep) || !existsSync(abs)) return c.json({ error: "文件不在这条任务的 worktree 里" }, 400);
    const a = saveAttachment({ name: basename(abs), mime: "text/plain", data: readFileSync(abs) });
    return c.json({ attachmentId: a.id });
  })
```

  `docList(t)` 在 Task 12 之前写成 `Object.values(t.source.docs ?? {}).filter(Boolean).map((url) => ({ url: url as string, title: undefined as string | undefined }))`，Task 12 换成数组直读。`saveAttachment` 用 `memory/attachments.ts` 里现有的写入函数（名字以文件为准；`POST /attachments` 的实现调的就是它）。import `execFileSync`、`resolve`、`sep`、`basename`、`existsSync`、`readFileSync`。

- [ ] **Step 5: 会话里改状态** —— `pipeline.ts` 把 `/tasks/:id/reject` 的实现抽成：

```ts
export function rejectTask(id: string, reason?: string): Task | undefined {
  const t = getTask(id);
  if (!t) return undefined;
  record({ taskId: t.id, action: "review_rejected", why: reason ?? "你打回了", how: "任务退回处理中，待审核动作作废", evidence: { reason: reason ?? null, dropped: (t.pending ?? []).map((p) => p.label) }, risk: "read" });
  for (const r of pendingRunsForTask(t.id)) setRunOutcome(r.id, "rejected", reason ?? "无说明");
  return updateTask(t.id, { status: "processing", pending: [], progress: `被打回：${reason ?? "无说明"}` });
}
```

  `api/tasks.ts` 的 `/reject` 改为调用它。`tools.ts` 在 `task_update` 之后加两个工具：

```ts
    tool(
      "task_approve",
      "用户在会话里明确说「合并吧 / 就这么发 / 通过」时，执行这条任务上等他点头的动作。有多个待审动作时用 actionId 指定（先用 task_get 看）；是 Slack 回复时必须先把要发的原文贴给用户、他说「发」之后才调，text 填最终原文。没得到明确同意不要调。",
      { actionId: z.string().max(80).optional(), text: z.string().max(4000).optional() },
      async ({ actionId, text: override }) => {
        const t = conversationId ? findTaskBySource((s) => s.conversationId === conversationId) : undefined;
        if (!t) return text("这条会话没有绑定任务。");
        const action = actionId ? t.pending?.find((p) => p.id.startsWith(actionId)) : t.pending?.[0];
        if (!action) return text("这条任务上没有等你点头的动作。");
        if (!decide("irreversible").allowed) return text("操作被拒绝");
        const creds = await loadSlackCreds();
        const call = creds ? slackCaller(creds) : undefined;
        const done = await executePending(t.id, action.id, { slackPost: async (ch, body, ts) => { if (!call) throw new Error("Slack 未接入"); return postMessage(call, ch, body, ts); } }, override ? { text: override } : undefined);
        return text(`已执行「${action.label}」。任务现在是 ${STATUS_LABEL[done.status]}。`);
      },
    ),
    tool(
      "task_reject",
      "用户在会话里说「打回，原因是…」时，把这条任务打回：作废待审动作，退回处理中，原因记下来（会进 Friday 的学习）。reason 用用户的原话。",
      { reason: z.string().min(1).max(500) },
      async ({ reason }) => {
        const t = conversationId ? findTaskBySource((s) => s.conversationId === conversationId) : undefined;
        if (!t) return text("这条会话没有绑定任务。");
        rejectTask(t.id, reason);
        return text(`已打回：${reason}`);
      },
    ),
```

  import `executePending`、`rejectTask`（pipeline）、`loadSlackCreds` / `slackCaller` / `postMessage`（与 `api/tasks.ts` 同源）。

- [ ] **Step 6: 跑 core 测试**

Run: `pnpm --filter @friday/core test && pnpm --filter @friday/core typecheck`
Expected: 全过（断言「任务没有 conversationId」的旧测试按新口径改）

- [ ] **Step 7: 会话组件** —— `Thread.tsx`：
  - `Props` 加 `mentionsFor?: string`。
  - 消息渲染在 `compact` 时统一为两列：`<div className="tm"><span className={`tm__who ${m.role === "user" ? "" : "is-friday"}`}>{m.role === "user" ? "你" : "Friday"}</span><div className="tm__body">…原来的正文渲染…</div></div>`。
  - 输入框在 `compact` 时：左侧 `›`、右侧灰字「@ 引入文件」；输入 `@` 后弹层：调 `GET /tasks/:id/mentions?q=<@ 之后的字>`（150ms 防抖），`↑↓` 选、回车 / 点击选中 → `POST /tasks/:id/mention`：返回 `attachmentId` 就走现有附件列表（和 📎 选文件同一条路），返回 `text` 就把链接插进输入框；输入框里的 `@xxx` 保留原样作为高亮文本。弹层分组标签「文件 / 资料 / 截图」。
  - 组合输入期间（`useImeGuard`）回车不触发 `@` 选择。

  样式（取自 Drawer / Card 画板的会话栏）：

```css
.tm { display: flex; gap: 10px; font-size: 12.5px; line-height: 1.6; }
.tm__who { flex-shrink: 0; width: 44px; color: var(--fg-3); }
.tm__who.is-friday { color: #38d6ff; }
.tm__body { color: var(--fg-2); min-width: 0; }
.tm__body .mention { color: #38d6ff; }
.thread--compact .composer { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-radius: 8px; border: 1px solid rgba(56,214,255,0.18); background: rgba(5,8,12,0.7); }
.thread--compact .composer__hint { font-size: 11px; color: var(--fg-4); }
.mention-pop { position: absolute; left: 12px; bottom: 44px; width: 420px; border-radius: 8px; border: 1px solid rgba(56,214,255,0.22); background: rgba(10,16,24,0.98); box-shadow: 0 12px 30px rgba(0,0,0,0.5); padding: 6px; display: flex; flex-direction: column; gap: 2px; font-size: 12px; }
.mention-pop__k { padding: 4px 8px; font-size: 10.5px; letter-spacing: 0.08em; color: var(--fg-4); }
.mention-pop__item { display: flex; gap: 8px; padding: 6px 8px; border-radius: 6px; color: var(--fg-2); }
.mention-pop__item[aria-selected="true"] { background: rgba(56,214,255,0.10); color: var(--fg-1); }
```

- [ ] **Step 8: `TaskChat`** —— `Board.tsx` 新增：

```tsx
function TaskChat({ t }: { t: Task }) {
  return (
    <div className="taskchat">
      <div className="tdlg__k">和 Friday 聊这条任务</div>
      <Thread conversationId={t.source.conversationId ?? null} emptyTitle="" emptyHint="" placeholder="标记完成 / 这条不用管了 / 把拂晓那条挂进来…" compact mentionsFor={t.id} />
    </div>
  );
}
```

  替换 Task 10 弹窗里的 `chat={<></>}` 占位；自主任务卡片（`Focus` embedded 且 `t.source.autonomous`）底部同样放 `<TaskChat t={t} />`（placeholder 换成「合并吧 / 打回，… / 完成，不执行」）。顶栏「会话」视图里的 `Thread` 保持非 compact，但消息两列与输入框样式用同一套 class。

- [ ] **Step 9: 类型检查与浏览器验收**

Run: `pnpm --filter @friday/desktop typecheck`

  浏览器：弹窗底部会话、自主卡底部会话、顶栏「会话」三处截图并排对比，消息列和输入框同一样式；在弹窗会话里说「标记完成」→ 任务真的变 done 且账本有 `task_update`；在自主卡会话里说「打回，中途关页面进度接不上」→ 任务回 processing、pending 清空；敲 `@export` → 弹层出现 worktree 里的文件，选中后作为附件发出，Friday 回答里引用了文件内容。按 spec §12 Drawer 最后两条、Card 最后两条对图。

- [ ] **Step 10: 提交**

```bash
git add -A apps/core apps/desktop packages/shared
git commit -m "$(cat <<'EOF'
每条任务建立即有一段会话；会话组件三处统一，支持 @ 引入 worktree 文件 / 资料 / 截图；会话里能批准和打回

§12 Drawer 6/6、Card 5/5 条已对。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: 资料：无类型链接列表

**Files:**
- Modify: `packages/shared/src/index.ts`（`TaskDoc`，`TaskSource.docs` 改数组，`merged[].docs` 同改）
- Create: `apps/core/src/agent/docTitle.ts`、`apps/core/src/agent/docTitle.test.ts`
- Modify: `apps/core/src/connectors/meegle.ts`（`pickDocs` 返回数组）、`connectors/meegle.test.ts`
- Modify: `apps/core/src/agent/meegle.ts`（同步合并 docs）、`agent/meegle.test.ts`
- Modify: `apps/core/src/api/tasks.ts`（`PUT /tasks/:id/docs` 换成 `POST` / `DELETE`；merge 合并 docs；`docList`）
- Modify: `apps/core/src/agent/tools.ts`、`agent/summon/slack.ts`、`agent/bridge.ts`（读 docs 的地方）
- Modify: `apps/core/src/memory/db.ts`（迁移）
- Create: `apps/desktop/src/views/Resources.tsx`
- Modify: `apps/desktop/src/views/Board.tsx`（删 `DocsEditor` / `DOC_LABELS` / DOCS 块）

**Interfaces:**
- Produces:
  - shared：`interface TaskDoc { url: string; title?: string; from: "meegle" | "user"; kind?: "link" }`；`TaskSource.docs?: TaskDoc[]`
  - `normUrl(url: string): string`、`mergeDocs(a: TaskDoc[], b: TaskDoc[]): TaskDoc[]`、`docTitle(url: string): Promise<string | undefined>`、`fallbackTitle(url: string): string`
  - HTTP：`POST /tasks/:id/docs {url}` → Task（异步补标题，完成后 `publish tasks`）；`DELETE /tasks/:id/docs?url=` → Task
  - `<Resources t={Task} onAct={…} />`

- [ ] **Step 1: 写失败的测试** `apps/core/src/agent/docTitle.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { fallbackTitle, mergeDocs, normUrl } from "./docTitle.js";
import { migrateDocs } from "../memory/db.js";

describe("资料链接", () => {
  it("归一化：去掉 hash、跟踪参数和末尾斜杠，host 小写", () => {
    expect(normUrl("https://Longbridge.feishu.cn/docx/AbC/?from=from_copylink#part")).toBe("https://longbridge.feishu.cn/docx/AbC");
  });
  it("合并去重，用户加的不被同步覆盖，已有标题保留", () => {
    const a = [{ url: "https://x.feishu.cn/docx/A", title: "PRD", from: "user" as const }];
    const b = [{ url: "https://x.feishu.cn/docx/A/", from: "meegle" as const }, { url: "https://figma.com/file/B", from: "meegle" as const }];
    expect(mergeDocs(a, b)).toEqual([a[0], b[1]]);
  });
  it("取不到标题时显示域名 + 末段路径", () => {
    expect(fallbackTitle("https://www.figma.com/file/B123/Export-Center")).toBe("figma.com / Export-Center");
  });
  it("旧的四槽 docs 迁成数组", () => {
    expect(migrateDocs({ req: "https://a/1", design: "https://b/2" })).toEqual([{ url: "https://a/1", from: "meegle" }, { url: "https://b/2", from: "meegle" }]);
    expect(migrateDocs({ meegle: "https://c/3" })).toEqual([{ url: "https://c/3", from: "user" }]);
    expect(migrateDocs([{ url: "https://d/4", from: "user" }])).toEqual([{ url: "https://d/4", from: "user" }]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @friday/core exec vitest run src/agent/docTitle.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现** `apps/core/src/agent/docTitle.ts`

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TaskDoc } from "@friday/shared";

const execFileP = promisify(execFile);
const TRACKING = /^(from|utm_[a-z]+|spm|share_token|sharer)$/i;

export function normUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    u.hostname = u.hostname.toLowerCase();
    return u.toString().replace(/\/(\?|$)/, "$1").replace(/\?$/, "");
  } catch {
    return url.trim();
  }
}

export function mergeDocs(a: TaskDoc[], b: TaskDoc[]): TaskDoc[] {
  const out = new Map<string, TaskDoc>();
  for (const d of [...a, ...b]) {
    const k = normUrl(d.url);
    const cur = out.get(k);
    if (!cur) out.set(k, d);
    else if (!cur.title && d.title) out.set(k, { ...cur, title: d.title });
  }
  return [...out.values()];
}

export function fallbackTitle(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop() ?? "";
    return `${u.hostname.replace(/^www\./, "")}${last ? ` / ${decodeURIComponent(last)}` : ""}`;
  } catch {
    return url;
  }
}

const LARK = /(^|\.)(feishu\.cn|larksuite\.com|larkoffice\.com)$/;

export async function docTitle(url: string): Promise<string | undefined> {
  let host = "";
  try { host = new URL(url).hostname; } catch { return undefined; }
  if (LARK.test(host)) {
    try {
      const { stdout } = await execFileP("lark-cli", ["docs", "+fetch", "--doc", url, "--jq", ".title"], { timeout: 10_000 });
      const t = stdout.trim().replace(/^"|"$/g, "");
      if (t && t !== "null") return t;
    } catch {}
    return undefined;
  }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000), redirect: "follow" });
    const html = (await res.text()).slice(0, 200_000);
    const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1];
    const title = og ?? html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1];
    return title?.trim() || undefined;
  } catch {
    return undefined;
  }
}
```

  实现前先跑 `lark-cli docs +fetch --help`，确认拿标题的参数写法（`--jq .title` 或 `--scope` 之类），按实际输出改上面那一行；在 `docTitle.test.ts` 里不测网络和 CLI。

- [ ] **Step 4: 迁移** —— `db.ts` 导出：

```ts
export function migrateDocs(raw: unknown): TaskDoc[] {
  if (Array.isArray(raw)) return raw as TaskDoc[];
  if (!raw || typeof raw !== "object") return [];
  return Object.entries(raw as Record<string, string>)
    .filter(([, v]) => typeof v === "string" && v.trim())
    .map(([k, v]) => ({ url: v.trim(), from: k === "meegle" ? ("user" as const) : ("meegle" as const) }));
}
```

  `migrate()` 末尾：遍历 `SELECT id, source FROM tasks WHERE json_type(source, '$.docs') = 'object'`，`source.docs = migrateDocs(source.docs)`，`merged[].docs` 同样处理，写回。

- [ ] **Step 5: 读写点改数组**（`rtk grep -rn "docs" apps/core/src packages/shared/src` 逐个过）：
  - `connectors/meegle.ts` `pickDocs(fields): TaskDoc[]`：每个命中字段产出 `{ url, from: "meegle" }`；`DOC_FIELDS` 的槽位名删掉，只留 `[key, nameRegex]`。
  - `agent/meegle.ts` 同步更新已有任务时：`docs: mergeDocs(existing.source.docs ?? [], fresh.docs)`。
  - `api/tasks.ts`：删 `PUT /tasks/:id/docs`（`docs_set`），加：

```ts
  .post("/tasks/:id/docs", async (c) => {
    const p = z.object({ url: z.string().url().max(2000) }).safeParse(await c.req.json().catch(() => null));
    const t = getTask(c.req.param("id"));
    if (!p.success || !t) return c.json({ error: "url 必须是链接" }, 400);
    const next = updateTask(t.id, { source: { docs: mergeDocs(t.source.docs ?? [], [{ url: p.data.url, from: "user" }]) } })!;
    record({ taskId: t.id, action: "doc_added", why: "你贴了一份资料", how: p.data.url, evidence: { url: p.data.url }, risk: "reversible" });
    void docTitle(p.data.url).then((title) => {
      if (!title) return;
      const cur = getTask(t.id);
      if (cur) updateTask(t.id, { source: { docs: (cur.source.docs ?? []).map((d) => (normUrl(d.url) === normUrl(p.data.url) ? { ...d, title } : d)) } });
    });
    return c.json(next);
  })
  .delete("/tasks/:id/docs", (c) => {
    const url = c.req.query("url") ?? "";
    const t = getTask(c.req.param("id"));
    if (!t || !url) return c.json({ error: "url 必填" }, 400);
    const next = updateTask(t.id, { source: { docs: (t.source.docs ?? []).filter((d) => normUrl(d.url) !== normUrl(url)) } })!;
    record({ taskId: t.id, action: "doc_removed", why: "你删了一份资料", how: url, evidence: { url }, risk: "reversible" });
    return c.json(next);
  })
```

    `/tasks/:id/merge` 里被并入任务的 docs 用 `mergeDocs(into.docs, from.docs)` 并进 `into`。Task 11 的 `docList(t)` 改为 `t.source.docs ?? []`。
  - `agent/bridge.ts` `contextFor`：加一行 `task.source.docs?.length ? \`资料：\n${task.source.docs.map((d) => \`- ${d.title ?? d.url}：${d.url}\`).join("\n")}\` : ""`。
  - `tools.ts`、`summon/slack.ts` 里读 `docs.req` 这类槽位的，改成遍历数组。
  - Meegle 同步时对没有 `title` 的 docs 异步补标题：在 `agent/meegle.ts` 同步一条任务之后调一个 `fillDocTitles(taskId)`（逻辑同上 `POST` 里的 `.then`，抽成函数放 `docTitle.ts` 旁边的 `api/tasks.ts` 不合适——放 `agent/docTitle.ts` 并从那里 import `getTask/updateTask`）。

- [ ] **Step 6: 跑 core 测试**

Run: `pnpm --filter @friday/core test && pnpm --filter @friday/core typecheck`
Expected: 全过（`meegle.test.ts`、`connectors/meegle.test.ts` 里断言 `{ req, tech, design }` 的改成数组断言）

- [ ] **Step 7: 前端** `apps/desktop/src/views/Resources.tsx`

```tsx
import { useState } from "react";
import type { Task } from "@friday/shared";
import { openUrl } from "@tauri-apps/plugin-opener";
import { taskDocAdd, taskDocRemove } from "../lib/core";

const SOURCE: Array<[RegExp, string]> = [[/feishu\.cn|larksuite|larkoffice/, "飞书"], [/figma\.com/, "Figma"], [/gitlab|github/, "GitLab"], [/meegle|feishu\.cn\/.*project/, "Meegle"]];
const sourceOf = (url: string) => SOURCE.find(([re]) => re.test(url))?.[1] ?? "";
const fallback = (url: string) => { try { const u = new URL(url); const last = u.pathname.split("/").filter(Boolean).pop(); return `${u.hostname.replace(/^www\./, "")}${last ? ` / ${decodeURIComponent(last)}` : ""}`; } catch { return url; } };

export function Resources({ t, onAct }: { t: Task; onAct: (t: Task, fn: () => Promise<unknown>) => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const docs = t.source.docs ?? [];
  return (
    <section className="tdlg__sec">
      <div className="res__head"><span className="tdlg__k">资料</span><span className="th__sp" /><button className="res__add" onClick={() => setAdding(true)}>＋ 贴一个链接</button></div>
      {adding && (
        <form onSubmit={(e) => { e.preventDefault(); const v = url.trim(); if (v) void onAct(t, () => taskDocAdd(t.id, v)); setUrl(""); setAdding(false); }}>
          <input className="res__input" autoFocus value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setAdding(false); }} placeholder="粘贴链接，回车加上" aria-label="资料链接" />
        </form>
      )}
      {docs.map((d) => (
        <div key={d.url} className="res__row">
          <span className="res__src">{sourceOf(d.url)}</span>
          <a href={d.url} title={d.url} className="res__t" onClick={(e) => { e.preventDefault(); void openUrl(d.url); }}>{d.title ?? fallback(d.url)}</a>
          <button className="res__del" aria-label={`删除 ${d.title ?? d.url}`} onClick={() => void onAct(t, () => taskDocRemove(t.id, d.url))}>×</button>
        </div>
      ))}
    </section>
  );
}
```

  `lib/core.ts` 加 `taskDocAdd(id, url)`（POST）、`taskDocRemove(id, url)`（DELETE `?url=`），写法照同文件其他任务接口。样式：

```css
.res__head { display: flex; align-items: center; }
.res__add { background: none; border: none; color: var(--fg-3); font: inherit; font-size: 11.5px; cursor: default; }
.res__row { display: flex; align-items: baseline; gap: 8px; }
.res__src { width: 44px; flex-shrink: 0; font-size: 11px; color: var(--fg-4); }
.res__t { flex: 1; min-width: 0; color: var(--fg-2); text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.res__del { opacity: 0; background: none; border: none; color: var(--fg-4); cursor: default; }
.res__row:hover .res__del, .res__del:focus-visible { opacity: 1; }
.res__input { width: 100%; padding: 6px 8px; border-radius: 6px; border: 1px solid rgba(56,214,255,0.22); background: rgba(5,8,12,0.7); color: var(--fg-1); font: inherit; }
```

  `Board.tsx`：删 `DocsEditor`、`DOC_LABELS`、`TaskBody` 里 DOCS 块和 `fx__docs--merged` 块；Task 10 弹窗的 `resources={<></>}` 占位换成 `<Resources t={dialogTask} onAct={act} />`；自主卡右列也放 `<Resources />`；`Detail` 的 `counts.docs` 改为 `(t.source.docs ?? []).length`。

- [ ] **Step 8: 类型检查与浏览器验收**

Run: `pnpm --filter @friday/desktop typecheck`

  弹窗里贴一个飞书文档链接 → 先显示「域名 / 末段」，几秒后变成真实标题；贴 GitHub 链接 → 显示页面 `<title>`；hover 看到完整 URL；右键出「打开链接 / 复制链接」；删掉一条。对 §12 Drawer「资料」那条。

- [ ] **Step 9: 提交**

```bash
git add -A apps/core apps/desktop packages/shared
git commit -m "$(cat <<'EOF'
资料改成无类型链接列表：标题自动取（飞书走 lark-cli），Meegle 同步只增不删，旧四槽迁成数组

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: 删 Ghostty 层、迁移旧 job、设置页、文档

**Files:**
- Delete: `apps/core/src/agent/ghostty.ts`
- Modify: `apps/core/src/agent/runner.ts`（删 `launchClaude`、`reopenTerminal`、`focusTerminal`、`buildScript`、`LaunchRequest`；只留两段脚本相关）
- Modify: `apps/core/src/api/jobs.ts`（`/jobs/:id/reopen` → `resumeInSession`；删 `/jobs/:id/focus`）
- Modify: `apps/core/src/api/run.ts`、`agent/tools.ts`（`run_claude` / `close_terminals`）、`agent/summon/index.ts`、`api/summon.ts`、`api/settings.ts`、`settings.ts`
- Modify: `apps/core/src/memory/db.ts`（一次性收掉旧 job）
- Modify: `packages/shared/src/index.ts`（删 `TerminalState`、`Task.terminal`、`Job.ghosttyId`）
- Modify: `apps/desktop/src/views/Settings.tsx`（「终端」一节）
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: 全部前序任务
- Produces: 无新接口

- [ ] **Step 1: 删除与替换**

```bash
git rm apps/core/src/agent/ghostty.ts
rtk grep -rn "ghostty\|launchClaude\|reopenTerminal\|focusTerminal\|TerminalState\|ghosttyId\|buildScript\b" apps/core/src apps/desktop/src packages/shared/src
```

  逐个处理：
  - `/jobs/:id/reopen`：`const sid = getJob(id)?.sessionId; const ok = sid ? await resumeInSession(sid) : false; return ok ? c.json({ status: "reopened", id }) : c.json({ error: "会话已不在，重新开工" }, 404);`
  - `/jobs/:id/focus` 删；前端调用处（若还有）删。
  - `api/run.ts`（`/run` 与 `跑 <项目>`）：换成 `openSession(t, t, { kind: "interactive", … })`，没有任务的 `/run` 先 `createTask({ title: task ?? \`在 ${project} 上开个终端\`, kind: "code", source: {}, project, status: "processing" })` 再开。
  - `tools.ts` 的 `run_claude` 同上；`close_terminals` 改用 `closeJobTerminal`（已是 tmux 版）。
  - `summon/index.ts`、`api/summon.ts` 里引用 `launchClaude` 的，同 `run.ts` 换法。
  - `settings.ts` 的 `terminal` 字段保留（只用于设置页示例命令的措辞），`api/settings.ts` 里与 Ghostty 专属的校验删掉。
  - shared 删 `TerminalState`、`Task.terminal`、`Job.ghosttyId`；`jobs.ts` 的 `ghostty_id` 读写删除（列留在库里，不做 DROP）。

- [ ] **Step 2: 旧 job 一次性收掉** —— `db.ts` `migrate()` 末尾：

```ts
  const legacy = d.prepare("SELECT id, task_id FROM jobs WHERE status = 'running' AND session_id IS NULL").all() as Array<{ id: string; task_id: string | null }>;
  if (legacy.length) {
    const at = new Date().toISOString();
    d.prepare("UPDATE jobs SET status = 'done', exit_code = -1, finished_at = ? WHERE status = 'running' AND session_id IS NULL").run(at);
    const note = d.prepare("UPDATE tasks SET progress = ?, updated_at = ? WHERE id = ? AND status = 'processing'");
    for (const j of legacy) if (j.task_id) note.run("旧版终端已不可接回，需重新开工", at, j.task_id);
  }
```

  在 `db.test.ts` 加一条：插一个 `status = running`、`session_id` 为空的 job 与对应 processing 任务，跑 `migrate`，断言 job 变 done、任务 progress 为「旧版终端已不可接回，需重新开工」。

- [ ] **Step 3: 设置页「终端」一节** —— `Settings.tsx`：
  - 显示 `/health` 的 `tmux`：有版本就写「tmux 3.x · 已就绪」，`null` 就写「没装 tmux，内嵌终端不可用：在终端里跑 brew install tmux」。
  - 写明从外部终端接回同一个会话的命令（可复制）：`tmux -L friday attach -t <会话名>`，下面一行「会话名在任务详情的分支那行」。
  - 快捷键说明表：`⌘T 新窗口 · ⌘W 关窗口 · ⌘1…9 切窗口 · ⌘D / ⌘⇧D 分屏 · ⌘F 搜历史 · ⌘K 清屏 · ⌘+ / ⌘- / ⌘0 字号 · 按住 Option 拖选`。
  - 「遗留的 worktree」列表：`GET /worktrees/leftover`，每行路径、分支、「有未提交改动」标记、所属任务标题，按钮「删掉」→ `POST /worktrees/remove`，结果文案用接口返回（分支没合并就说「目录删了，分支 x 没合并留着」）。有未提交改动的行按钮文案「删掉（会丢改动）」并二次确认，确认框标题写后果不写「确认」。
  - 删掉原来「终端：Ghostty / Terminal」的切换控件。

- [ ] **Step 4: CLAUDE.md** —— 按现状改写：
  - 「终端：外部 Ghostty（2026-09-20 改）」一节整体替换为「终端：tmux 持有进程、详情就是终端（2026-09-29）」，内容取 spec §1、§3、§4、§5、§6 的要点，保留「Ghostty `command` 按 shell 规则拆词」这类已不适用的坑一句话说明已删。
  - 「工作台」相关几节补一句现状：列表在右、详情一次一条、页头无统计卡、搜索 `⌘P`、⌘↑↓ 切任务、「详情」弹窗、每条任务一段会话。
  - 「自主任务在 worktree 里跑（2026-09-15）」一节里「`git worktree add --detach <项目>/.claude/worktrees/friday-<id8>`」一条标注已被准备段取代。

- [ ] **Step 5: 全量验证**

Run: `pnpm typecheck && pnpm test`
Expected: 全过

- [ ] **Step 6: 打包冒烟**

```bash
APPLE_SIGNING_IDENTITY=- pnpm --filter @friday/desktop tauri build
```

  打开产物 `Friday.app`：点一条任务「开始做」→ 终端出现、准备段跑完、干活段起来；退出 Friday 再打开 → 终端接回、状态正确。**打开 .app 前先跟用户说一声**（会替换正在用的 Friday）。

- [ ] **Step 7: 最终对图** —— spec §12 四个小节全部重走一遍（这次在打包版里），截图存 `design-check/final-*.png`；有一条对不上就回到对应 Task 修，不在这里凑合。

- [ ] **Step 8: 提交**

```bash
git add -A
git commit -m "$(cat <<'EOF'
删掉 Ghostty 层：开窗 / 聚焦 / 重开都走 tmux 会话；旧 job 一次性收掉；设置页终端一节与遗留 worktree；CLAUDE.md 按现状改写

§12 四个小节打包版复核全部已对。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec 覆盖：** §1 决策表 → Task 1–13；§2.1 `sessions` 表 → Task 2（改名 `term_sessions`，见 Global Constraints）；`rootId` → Task 4；`PendingAction.at` → Task 6；建任务即建会话 → Task 11；docs 数组 → Task 12。§2.2 状态位 → Task 6（多一个 `idle` 档：会话活着、看过了、没事——spec 表里「（无）」只写了没会话的待办）。§3 tmux 层 → Task 1、5、7。§4 两段脚本 → Task 3、4。§5 worktree → Task 3、5、13。§6 内嵌终端 → Task 7、8（`capture-pane` 与 `addon-search` 按 Global Constraints 修正）。§7 界面 → Task 9–12。§8 归属 → Task 4（`joinRootSession`）、Task 10（Friday 推断的采纳 / 否决）。§9 迁移 → Task 2、11、12、13。§10 顺序 → 本计划 13 个 Task 的顺序与之一致。§11 测试 → 各 Task 的测试 + Task 9 Step 8、Task 13 Step 6。§12 对照清单 → Task 9、10、11、12、13 的验收步骤。

**占位扫描：** Task 10 的 `resources` / `chat` 两处 `<></>` 是有意的中间态，已在 Task 11 Step 8、Task 12 Step 7 明确要求替换。Task 9 Step 4 的 `counts.docs` 在 Task 12 前后写法不同，已写明。

**类型一致：** `openSession(root, owner, o)` 在 Task 4 定义，Task 5、7、13 同签名调用；`sayToSession` 返回 `"sent" | "queued" | "no-terminal"`，`terminal.say` 同类型；`TaskSession.state` 取值与 `SESSION_STATE_LABEL`、CSS `sdot--*`、`th__state--*` 一致；`TaskDoc` 在 Task 12 定义，Task 11 的 `docList` 已注明 Task 12 前后两种写法。

**Review Focus：** 五条都有归属——tmux 没装（Task 4 测试）、对账误收（Task 5 测试）、缺陷收工（Task 5 测试）、准备段失败（Task 4 测试）、中文输入法（Task 8 Step 6 / Task 9 Step 8 手动）。
