# 呼出模式（Summon HUD）M1 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 `⌘⇧Space` 弹出一张不抢焦点的 HUD 小卡，显示 Friday 此刻「看到了什么」、对上工作台里的哪条任务、以及 1–3 个可直接执行的下一步动作。

**Architecture:** 壳（Rust）在显示 HUD 之前先抓一份环境快照（前台 app、浏览器 URL、选中文字、兜底截图），HUD 是一个预建隐藏的 `NSPanel` 窗口，加载 `index.html?view=hud`；前端取到快照后 `POST /summon`，core 先跑纯函数规则匹配给出候选任务与默认动作（几十毫秒、零 token），再按需调 Sonnet 补判断与草稿，两段都通过同一条 SSE 流回前端；动作按钮全部映射到已有的任务接口。

**Tech Stack:** Tauri 2 + objc2（壳）、Node + hono + vitest（core）、React + TS（HUD 前端）、Claude Agent SDK（Sonnet，label `summon`）。

**Spec:** `docs/superpowers/specs/2026-09-16-summon-hud-design.md`

## Global Constraints

- 本计划只做 spec 的 **M1**。`activity` 表、zsh hook、Slack/Meegle 状态回流、轨迹注入全部属于 M2，**本计划不实现**，但 `/summon` 的入参结构要给轨迹留位（`recent?: string`，M1 恒为 undefined）。
- 分支 `feat/summon`，工作目录 `~/hr-lys/friday-feat-summon`。提交信息用中文，每个 Task 至少一次提交，**不要**用 `-c user.name=…` 覆盖 git author。
- 代码风格：默认不写注释，只在 WHY 不明显时写一行。不加「以防万一」的兜底和不必要的抽象。不新建 `*.md` 文档（本计划与 spec 除外）。
- 外部文本（选中文字、窗口标题、URL、Slack 消息）进任何 prompt 前必须过 `untrusted(source, text)`（`apps/core/src/agent/fence.ts`）。
- 模型：卡片用 Sonnet，常量 `SUMMON_MODEL = "claude-sonnet-5"`，`askStream` 的 `label` 传 `"summon"`（用量面板按它分组）。
- **无文字不调模型**：快照里既没有 `selection` 也没有 Slack 消息也没有页面标题时，卡片完全由规则生成，`summonCard` 不得调用 `askStream`。
- HUD 窗口 label 固定 `"hud"`，宽 560，屏幕顶部居中。
- 测试命令：`pnpm test`（vitest，全仓）、`pnpm typecheck`。单文件：`pnpm --filter @friday/core exec vitest run src/agent/summon/match.test.ts`。
- Rust 改动不写自动化测试，靠 Task 8 的真机验收清单；每次改完至少 `pnpm --filter @friday/desktop tauri dev` 能起来。

---

## 文件结构

**新建（core）**
- `apps/core/src/agent/summon/match.ts` — 纯函数规则匹配：快照 → 候选任务 + 默认动作。无 IO，入参全部显式传入。
- `apps/core/src/agent/summon/match.test.ts`
- `apps/core/src/agent/summon/card.ts` — 模型那一层：组 prompt、调 Sonnet、解析并钳制 JSON。
- `apps/core/src/agent/summon/card.test.ts`
- `apps/core/src/agent/summon/index.ts` — 编排：补全快照上下文（项目 / Meegle / 线程）→ match → card，产出 SSE 事件序列。
- `apps/core/src/agent/summon/index.test.ts`
- `apps/core/src/api/summon.ts` — `POST /summon`（SSE）、`POST /summon/act`。
- `apps/core/src/api/summon.test.ts`

**新建（前端）**
- `apps/desktop/src/views/Hud.tsx` — HUD 主视图。
- `apps/desktop/src/lib/summon.ts` — 调 `/summon` 的 SSE 客户端与动作执行。

**新建（壳）**
- `apps/desktop/src-tauri/src/snapshot.rs` — 抓快照（前台 app、AppleScript 问 URL、AX 选中文字、兜底截图）。
- `apps/desktop/src-tauri/src/permissions.rs` — 三项权限状态查询与打开系统设置面板。
- `apps/desktop/src-tauri/src/hud.rs` — HUD 窗口预建、显示/隐藏、NSPanel 转换与兜底。

**修改**
- `packages/shared/src/index.ts` — 新增 `Snapshot` / `SummonCard` / `SummonAction` / `SummonRules` / `PermissionStatus`，`SettingsResponse`/`SettingsUpdate` 加 `summon` 字段。
- `apps/core/src/api/index.ts` — 挂 `summon` 路由。
- `apps/core/src/api/settings.ts` — 读写 `settings.summon`。
- `apps/desktop/src/App.tsx` — `view === "hud"` 时渲染 `Hud`。
- `apps/desktop/src/views/Settings.tsx` — 权限区三行 + 呼出模式设置。
- `apps/desktop/src-tauri/src/lib.rs` — 注册新命令与模块，热键改指 HUD。
- `apps/desktop/src-tauri/src/window.rs` — 保留工作台逻辑，热键不再 toggle 工作台。
- `apps/desktop/src-tauri/Cargo.toml` — 加 `objc2-app-kit`、`tauri-plugin-clipboard-manager`、`tauri-nspanel`。
- `apps/desktop/src-tauri/capabilities/default.json` — 加 `hud` 窗口与剪贴板权限。
- `apps/desktop/src/styles.css` — `.hud__*` 样式。

**任务顺序的理由**：1–4 是 core 的纯逻辑与接口，不依赖壳，可以先全部测通；5–7 是壳；8 是前端 HUD；9 串起来做真机验收。core 先行意味着壳那边一旦跑通就能立刻看到内容。

---

### Task 1: 共享类型与 settings 字段

**Files:**
- Modify: `packages/shared/src/index.ts`
- Modify: `apps/core/src/api/settings.ts`
- Test: `apps/core/src/api/settings.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `Snapshot`、`SummonAction`、`SummonCard`、`SummonRules`、`SummonEvent`、`PermissionStatus`、`SummonSettings`、`DEFAULT_SUMMON_SETTINGS`；`SettingsResponse.summon`、`SettingsUpdate.summon`、`TaskSource.summon`

- [ ] **Step 1: 在 shared 里加类型**

在 `packages/shared/src/index.ts` 末尾追加（放在文件最后即可，该文件按主题分段，新增一段 `/* ---------- 呼出模式 ---------- */`）：

```ts
/* ---------- 呼出模式（Summon HUD） ---------- */

/** 壳在显示 HUD 之前抓的一份环境快照 */
export interface Snapshot {
  at: number;
  app: { bundleId: string; name: string; title: string };
  /** 浏览器当前 tab，AppleScript 拿的 */
  browser?: { url: string; title: string };
  /** 选中文字，最多 8000 字 */
  selection?: string;
  /** 兜底截图的本地绝对路径，前端用 convertFileSrc 显示 */
  screenshotPath?: string;
  permissions: PermissionStatus;
}

export interface PermissionStatus {
  accessibility: boolean;
  automation: boolean;
  screen: boolean;
}

export type SummonAction =
  | { kind: "open_task"; label: string; taskId: string }
  | { kind: "approve_pending"; label: string; taskId: string; actionId: string }
  | { kind: "start_work"; label: string; project: string; prompt: string }
  | { kind: "create_task"; label: string; title: string }
  | { kind: "mark_done"; label: string; taskId: string }
  | { kind: "note"; label: string; text: string }
  | { kind: "copy"; label: string; text: string };

/** 规则层的产出：不调模型也能渲染的那部分 */
export interface SummonRules {
  saw: string;
  match?: { taskId: string; title: string; status: TaskStatus; why: string; strength: "sure" | "maybe" };
  actions: SummonAction[];
  /** 这次会不会调模型，前端据此决定要不要显示「正在判断」 */
  willThink: boolean;
}

/** 模型层的产出 */
export interface SummonCard {
  verdict: string;
  reply?: string;
  actions: SummonAction[];
  matchTaskId?: string;
}

export type SummonEvent =
  | { type: "rules"; rules: SummonRules }
  | { type: "card"; card: SummonCard }
  | { type: "error"; message: string }
  | { type: "done" };

export interface SummonSettings {
  /** 没有 URL / 选中文字时兜底截前台窗口 */
  screenshotFallback: boolean;
  /** 只有这些域名前缀的 URL 会被记录与使用 */
  urlAllowlist: string[];
}

export const DEFAULT_SUMMON_SETTINGS: SummonSettings = {
  screenshotFallback: true,
  urlAllowlist: ["meegle.com", "project.feishu.cn", "longbridge.sg", "longbridge-inc.com"],
};
```

在 `TaskSource`（`packages/shared/src/index.ts:299`）里补一个字段，放在 `reporter` 之前：

```ts
  /** 从呼出模式建的任务 */
  summon?: boolean;
```

然后修改已有的两个接口（`packages/shared/src/index.ts:105` 与 `:117` 附近）：

```ts
export interface SettingsResponse {
  terminal: TerminalApp;
  model: ModelId;
  skills: boolean;
  name: string;
  theme: ThemeId;
  learn: boolean;
  learnHistory: boolean;
  summon: SummonSettings;
  dataDir: string;
  projects: string[];
}

export interface SettingsUpdate {
  terminal?: TerminalApp;
  model?: ModelId;
  skills?: boolean;
  name?: string;
  theme?: ThemeId;
  learn?: boolean;
  learnHistory?: boolean;
  summon?: Partial<SummonSettings>;
}
```

- [ ] **Step 2: 写 settings 的失败测试**

在 `apps/core/src/api/settings.test.ts` 里追加：

```ts
it("summon 设置有默认值，PUT 只合并传进来的字段", async () => {
  const before = await app.request("/settings");
  expect(((await before.json()) as SettingsResponse).summon).toEqual(DEFAULT_SUMMON_SETTINGS);

  const res = await app.request("/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ summon: { screenshotFallback: false } }),
  });
  const after = (await res.json()) as SettingsResponse;
  expect(after.summon.screenshotFallback).toBe(false);
  expect(after.summon.urlAllowlist).toEqual(DEFAULT_SUMMON_SETTINGS.urlAllowlist);
});
```

文件顶部的 import 补上 `DEFAULT_SUMMON_SETTINGS` 与 `SettingsResponse`（从 `@friday/shared`）。

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm --filter @friday/core exec vitest run src/api/settings.test.ts`
Expected: FAIL，`summon` 是 undefined

- [ ] **Step 4: 让 settings 读写 summon**

`apps/core/src/api/settings.ts`：读取时用 `DEFAULT_SUMMON_SETTINGS` 兜底，写入时浅合并。照该文件已有的读写 `settings.json` 的方式补两处：GET 的响应体加 `summon: { ...DEFAULT_SUMMON_SETTINGS, ...(current.summon ?? {}) }`；PUT 的合并逻辑里，若 `body.summon` 存在则写回 `{ ...DEFAULT_SUMMON_SETTINGS, ...(current.summon ?? {}), ...body.summon }`。其余键保持原样（该文件已有「保留其他键」的写法，照抄）。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @friday/core exec vitest run src/api/settings.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add packages/shared/src/index.ts apps/core/src/api/settings.ts apps/core/src/api/settings.test.ts
git commit -m "呼出模式：共享类型与 summon 设置项"
```

---

### Task 2: 规则匹配 `match.ts`

**Files:**
- Create: `apps/core/src/agent/summon/match.ts`
- Test: `apps/core/src/agent/summon/match.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `Snapshot` / `SummonRules` / `SummonAction`；已有的 `Project`（`apps/core/src/memory/projects.ts`）、`Task`（`@friday/shared`）
- Produces:
  ```ts
  export interface MatchInput {
    snapshot: Snapshot;
    tasks: Task[];        // 未关闭的任务，调用方查好传进来
    projects: Project[];
    /** 快照里的 Slack 频道名（从窗口标题解析出来的），没有就 undefined */
    channel?: string;
  }
  export interface Candidate { task: Task; why: string; strength: "sure" | "maybe" }
  export function parseSlackTitle(title: string): { channel?: string; person?: string }
  export function meegleIdFromUrl(url: string): string | undefined
  export function projectByCwd(cwd: string, projects: Project[]): Project | undefined
  export function candidates(input: MatchInput): Candidate[]
  export function defaultActions(task: Task | undefined, project: Project | undefined, snapshot: Snapshot): SummonAction[]
  export function buildRules(input: MatchInput): SummonRules
  ```

**注意**：`Snapshot` 本身没有 cwd（M1 壳不抓终端 cwd），`projectByCwd` 供 M2 与测试直接调用；`candidates` 在 M1 只走 URL / 频道 / 选中文字三条。

- [ ] **Step 1: 写失败测试**

创建 `apps/core/src/agent/summon/match.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { Snapshot, Task } from "@friday/shared";
import type { Project } from "../../memory/projects.js";
import { buildRules, candidates, defaultActions, meegleIdFromUrl, parseSlackTitle, projectByCwd } from "./match.js";

const projects: Project[] = [
  { name: "whale-console", dir: "/Users/me/work/whale-console", aliases: ["鲸鱼后台"], channels: ["#wealth-fe"], urls: [] },
  { name: "fe-wealth-admin", dir: "/Users/me/work/fe-wealth-admin", aliases: [], channels: [], urls: [] },
];

function task(over: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "提现规则 tab 错位",
    kind: "meegle",
    source: { meegleId: "1234" },
    project: "whale-console",
    status: "understood",
    priority: "normal",
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
    ...over,
  };
}

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    at: Date.now(),
    app: { bundleId: "com.google.Chrome", name: "Chrome", title: "Meegle" },
    permissions: { accessibility: true, automation: true, screen: true },
    ...over,
  };
}

describe("parseSlackTitle", () => {
  it("从窗口标题里取频道", () => {
    expect(parseSlackTitle("#wealth-fe (3 new items) - Longbridge - Slack")).toEqual({ channel: "#wealth-fe" });
  });

  it("私聊标题取人名", () => {
    expect(parseSlackTitle("拂晓 - Longbridge - Slack")).toEqual({ person: "拂晓" });
  });
});

describe("meegleIdFromUrl", () => {
  it("认出工单 id", () => {
    expect(meegleIdFromUrl("https://project.feishu.cn/xx/issue/detail/1234")).toBe("1234");
  });

  it("不是工单页返回 undefined", () => {
    expect(meegleIdFromUrl("https://project.feishu.cn/xx/dashboard")).toBeUndefined();
  });
});

describe("projectByCwd", () => {
  it("按目录前缀命中，取最深的", () => {
    expect(projectByCwd("/Users/me/work/whale-console/apps/web", projects)?.name).toBe("whale-console");
  });

  it("不在任何项目下返回 undefined", () => {
    expect(projectByCwd("/tmp", projects)).toBeUndefined();
  });
});

describe("candidates", () => {
  it("URL 里的工单 id 精确命中算 sure", () => {
    const got = candidates({
      snapshot: snap({ browser: { url: "https://project.feishu.cn/x/issue/detail/1234", title: "提现规则" } }),
      tasks: [task()],
      projects,
    });
    expect(got).toHaveLength(1);
    expect(got[0]!.strength).toBe("sure");
  });

  it("频道命中项目下的任务算 maybe", () => {
    const got = candidates({ snapshot: snap(), tasks: [task({ status: "processing" })], projects, channel: "#wealth-fe" });
    expect(got[0]!.strength).toBe("maybe");
  });

  it("什么都对不上返回空", () => {
    const got = candidates({ snapshot: snap(), tasks: [task()], projects });
    expect(got).toEqual([]);
  });
});

describe("defaultActions", () => {
  it("有待审动作时第一个是通过并执行", () => {
    const t = task({ status: "review", pending: [{ id: "a1", type: "slack_reply", label: "回复拂晓", detail: "草稿", payload: {} }] });
    const [first] = defaultActions(t, undefined, snap());
    expect(first).toMatchObject({ kind: "approve_pending", taskId: "t1", actionId: "a1" });
  });

  it("understood 的任务给开工", () => {
    const [first] = defaultActions(task(), projects[0], snap());
    expect(first!.kind).toBe("start_work");
  });

  it("没对上任务时给建成任务", () => {
    const [first] = defaultActions(undefined, undefined, snap({ selection: "帮我把导出中心加个筛选" }));
    expect(first!.kind).toBe("create_task");
  });
});

describe("buildRules", () => {
  it("有选中文字时 willThink 为 true", () => {
    const rules = buildRules({ snapshot: snap({ selection: "这段报错" }), tasks: [], projects });
    expect(rules.willThink).toBe(true);
  });

  it("只有 URL 没有文字时不调模型", () => {
    const rules = buildRules({
      snapshot: snap({ browser: { url: "https://project.feishu.cn/x/issue/detail/1234", title: "" } }),
      tasks: [task()],
      projects,
    });
    expect(rules.willThink).toBe(false);
    expect(rules.match?.taskId).toBe("t1");
  });

  it("saw 里写清看到的是什么", () => {
    const rules = buildRules({ snapshot: snap({ browser: { url: "https://project.feishu.cn/x/issue/detail/1234", title: "提现规则" } }), tasks: [], projects });
    expect(rules.saw).toContain("Chrome");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @friday/core exec vitest run src/agent/summon/match.test.ts`
Expected: FAIL，`Cannot find module './match.js'`

- [ ] **Step 3: 实现 `match.ts`**

创建 `apps/core/src/agent/summon/match.ts`：

```ts
import type { Project } from "../../memory/projects.js";
import type { Snapshot, SummonAction, SummonRules, Task } from "@friday/shared";

export interface MatchInput {
  snapshot: Snapshot;
  tasks: Task[];
  projects: Project[];
  channel?: string;
}

export interface Candidate {
  task: Task;
  why: string;
  strength: "sure" | "maybe";
}

const SLACK_SUFFIX = /\s*-\s*[^-]*-\s*Slack\s*$/;

export function parseSlackTitle(title: string): { channel?: string; person?: string } {
  const head = title.replace(SLACK_SUFFIX, "").replace(/\s*\(\d+\s+new items?\)\s*/i, "").trim();
  if (!head) return {};
  return head.startsWith("#") ? { channel: head } : { person: head };
}

export function meegleIdFromUrl(url: string): string | undefined {
  return /\/(?:issue|story|detail)\/(?:detail\/)?(\d{3,})/.exec(url)?.[1];
}

export function projectByCwd(cwd: string, projects: Project[]): Project | undefined {
  let best: Project | undefined;
  for (const p of projects) {
    if (!p.dir) continue;
    if (cwd === p.dir || cwd.startsWith(`${p.dir}/`)) {
      if (!best || p.dir.length > best.dir.length) best = p;
    }
  }
  return best;
}

function projectByChannel(channel: string, projects: Project[]): Project | undefined {
  return projects.find((p) => p.channels.includes(channel));
}

export function candidates(input: MatchInput): Candidate[] {
  const { snapshot, tasks, projects, channel } = input;
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const push = (task: Task, why: string, strength: Candidate["strength"]) => {
    if (seen.has(task.id)) return;
    seen.add(task.id);
    out.push({ task, why, strength });
  };

  const meegleId = snapshot.browser ? meegleIdFromUrl(snapshot.browser.url) : undefined;
  if (meegleId) for (const t of tasks) if (t.source.meegleId === meegleId) push(t, `你正开着这条工单 #${meegleId}`, "sure");

  if (snapshot.selection) {
    const id = /\b(\d{4,})\b/.exec(snapshot.selection)?.[1];
    if (id) for (const t of tasks) if (t.source.meegleId === id) push(t, `选中的文字里有工单号 #${id}`, "sure");
  }

  if (channel) {
    const project = projectByChannel(channel, projects);
    if (project) for (const t of tasks) if (t.project === project.name) push(t, `${channel} 是 ${project.name} 的频道`, "maybe");
  }

  return out;
}

export function defaultActions(task: Task | undefined, project: Project | undefined, snapshot: Snapshot): SummonAction[] {
  if (!task) {
    const title = (snapshot.selection ?? snapshot.browser?.title ?? snapshot.app.title).slice(0, 60);
    return title ? [{ kind: "create_task", label: "建成任务", title }] : [];
  }
  const pending = task.pending?.[0];
  if (pending) {
    return [
      { kind: "approve_pending", label: pending.type === "slack_reply" ? "看一眼再发…" : "通过并执行", taskId: task.id, actionId: pending.id },
      { kind: "open_task", label: "打开任务", taskId: task.id },
    ];
  }
  if (task.status === "processing") {
    return [
      { kind: "open_task", label: "看进展", taskId: task.id },
      { kind: "mark_done", label: "标记完成", taskId: task.id },
    ];
  }
  const dir = project?.name ?? task.project;
  return dir
    ? [
        { kind: "start_work", label: "开工", project: dir, prompt: task.title },
        { kind: "open_task", label: "打开任务", taskId: task.id },
      ]
    : [{ kind: "open_task", label: "打开任务", taskId: task.id }];
}

function describe(snapshot: Snapshot, channel?: string): string {
  const bits = [snapshot.app.name];
  if (channel) bits.push(channel);
  else if (snapshot.browser?.title) bits.push(snapshot.browser.title.slice(0, 60));
  else if (snapshot.app.title) bits.push(snapshot.app.title.slice(0, 60));
  if (snapshot.selection) bits.push(`选中了 ${snapshot.selection.length} 个字`);
  if (snapshot.screenshotPath) bits.push("截了一张图");
  return bits.join(" · ");
}

export function buildRules(input: MatchInput): SummonRules {
  const hits = candidates(input);
  const top = hits[0];
  const project = top?.task.project ? input.projects.find((p) => p.name === top.task.project) : undefined;
  const hasText = Boolean(input.snapshot.selection || input.snapshot.browser?.title || input.channel);
  return {
    saw: describe(input.snapshot, input.channel),
    match: top ? { taskId: top.task.id, title: top.task.title, status: top.task.status, why: top.why, strength: top.strength } : undefined,
    actions: defaultActions(top?.task, project, input.snapshot),
    willThink: hasText,
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @friday/core exec vitest run src/agent/summon/match.test.ts`
Expected: PASS（10 个用例）

- [ ] **Step 5: 提交**

```bash
git add apps/core/src/agent/summon/match.ts apps/core/src/agent/summon/match.test.ts
git commit -m "呼出模式：规则匹配层"
```

---

### Task 3: 模型卡片 `card.ts`

**Files:**
- Create: `apps/core/src/agent/summon/card.ts`
- Test: `apps/core/src/agent/summon/card.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `Candidate`；已有的 `askStream`（`../claude.js`）、`untrusted`（`../fence.js`）、`contextFor`（`../../memory/tasks.js` 附近，若不存在则用任务的 `understanding` / `plan` / `progress` 拼）
- Produces:
  ```ts
  export const SUMMON_MODEL = "claude-sonnet-5";
  export function cardPrompt(input: CardInput): { system: string; prompt: string }
  export function parseCard(text: string, allowed: AllowedIds): SummonCard
  export async function summonCard(input: CardInput): Promise<SummonCard>
  export interface CardInput { snapshot: Snapshot; rules: SummonRules; candidates: Candidate[]; recent?: string }
  export interface AllowedIds { taskIds: string[]; actionIds: string[]; projects: string[] }
  ```

- [ ] **Step 1: 写失败测试**

创建 `apps/core/src/agent/summon/card.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { Snapshot, SummonRules } from "@friday/shared";
import { cardPrompt, parseCard } from "./card.js";

const allowed = { taskIds: ["t1"], actionIds: ["a1"], projects: ["whale-console"] };

const snapshot: Snapshot = {
  at: 0,
  app: { bundleId: "com.tinyspeck.slackmacgap", name: "Slack", title: "#wealth-fe - Slack" },
  selection: "养牛活动验收问题抽空改一改",
  permissions: { accessibility: true, automation: true, screen: true },
};

const rules: SummonRules = { saw: "Slack · #wealth-fe", actions: [], willThink: true };

describe("parseCard", () => {
  it("解析正常输出", () => {
    const card = parseCard('{"verdict":"拂晓在催验收","reply":"我下午改","actions":[{"kind":"open_task","label":"打开","taskId":"t1"}],"matchTaskId":"t1"}', allowed);
    expect(card.verdict).toBe("拂晓在催验收");
    expect(card.actions).toHaveLength(1);
    expect(card.matchTaskId).toBe("t1");
  });

  it("钳掉不存在的 taskId", () => {
    const card = parseCard('{"verdict":"x","actions":[{"kind":"open_task","label":"打开","taskId":"bogus"}]}', allowed);
    expect(card.actions).toEqual([]);
    expect(card.matchTaskId).toBeUndefined();
  });

  it("钳掉模型自己发明的动作类型", () => {
    const card = parseCard('{"verdict":"x","actions":[{"kind":"send_email","label":"发邮件"}]}', allowed);
    expect(card.actions).toEqual([]);
  });

  it("start_work 的项目必须在白名单里", () => {
    const ok = parseCard('{"verdict":"x","actions":[{"kind":"start_work","label":"开工","project":"whale-console","prompt":"改 tab"}]}', allowed);
    expect(ok.actions).toHaveLength(1);
    const bad = parseCard('{"verdict":"x","actions":[{"kind":"start_work","label":"开工","project":"别的项目","prompt":"x"}]}', allowed);
    expect(bad.actions).toEqual([]);
  });

  it("最多留 3 个动作", () => {
    const four = Array.from({ length: 4 }, () => '{"kind":"open_task","label":"打开","taskId":"t1"}').join(",");
    expect(parseCard(`{"verdict":"x","actions":[${four}]}`, allowed).actions).toHaveLength(3);
  });

  it("不是 JSON 时返回空判断而不是抛", () => {
    expect(parseCard("模型今天不想说话", allowed)).toEqual({ verdict: "", actions: [] });
  });
});

describe("cardPrompt", () => {
  it("外部文字被定界符包住", () => {
    const { prompt } = cardPrompt({ snapshot, rules, candidates: [] });
    expect(prompt).toContain("养牛活动验收问题抽空改一改");
    expect(prompt).toContain('<untrusted source="用户选中的文字">');
  });

  it("system 里写明只能用给定的动作类型", () => {
    const { system } = cardPrompt({ snapshot, rules, candidates: [] });
    expect(system).toContain("open_task");
    expect(system).toContain("start_work");
  });
});
```

`parseCard` 的第 6 个用例断言的是 `{ verdict: "", actions: [] }`，实现必须正好返回这个形状（没有多余的键）。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @friday/core exec vitest run src/agent/summon/card.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现 `card.ts`**

创建 `apps/core/src/agent/summon/card.ts`。`untrusted(source, text)` 的输出形如 `<untrusted source="用户选中的文字">\n…\n</untrusted>`（`apps/core/src/agent/fence.ts`），system 里还要带上 `UNTRUSTED_NOTE`。

```ts
import type { Snapshot, SummonAction, SummonCard, SummonRules } from "@friday/shared";
import { askStream } from "../claude.js";
import { untrusted, UNTRUSTED_NOTE } from "../fence.js";
import { config } from "../../config.js";
import type { Candidate } from "./match.js";

export const SUMMON_MODEL = "claude-sonnet-5";

export interface CardInput {
  snapshot: Snapshot;
  rules: SummonRules;
  candidates: Candidate[];
  /** M2 的活动轨迹，M1 恒为 undefined */
  recent?: string;
}

export interface AllowedIds {
  taskIds: string[];
  actionIds: string[];
  projects: string[];
}

const KINDS = ["open_task", "approve_pending", "start_work", "create_task", "mark_done", "note", "copy"] as const;

export function cardPrompt(input: CardInput): { system: string; prompt: string } {
  const { snapshot, candidates, recent } = input;
  const system = [
    "你是 Friday 的呼出判断。用户此刻正在某个 app 里工作，按了热键叫你。你要说清这是什么事、和他哪条任务有关、下一步做什么。",
    "用户照旧在 Slack / Meegle / 终端里干活，你不替他决定回不回消息，只告诉他这件事对应哪条任务、进展到哪、可以做什么。",
    "判断要短：verdict 一到两句中文，不要复述你看到的内容，直接给结论。",
    `只能用这几种动作：${KINDS.join(" / ")}。taskId、actionId、project 只能用下面给出的值，不能自己编。最多 3 个动作。`,
    UNTRUSTED_NOTE,
    'Slack 场景可以给 reply 草稿（用户身份，中文，不要承诺工期和人力）。只输出一个 JSON 对象：{"verdict":"","reply":"","actions":[],"matchTaskId":""}。',
  ].join("\n");

  const prompt = [
    `他此刻在：${snapshot.app.name}${snapshot.app.title ? `（${snapshot.app.title}）` : ""}`,
    snapshot.browser ? `网址：${snapshot.browser.url}` : "",
    snapshot.selection ? untrusted("用户选中的文字", snapshot.selection.slice(0, 4000)) : "",
    recent ? `最近的活动：\n${recent}` : "",
    candidates.length ? "可能相关的任务：" : "没有对上任何任务。",
    ...candidates.slice(0, 5).map((c) => {
      const t = c.task;
      const pending = t.pending?.map((p) => `待审动作 ${p.id}：${p.label}`).join("；") ?? "";
      return [
        `- 任务 ${t.id}：${t.title}（${t.status}${t.project ? ` · ${t.project}` : ""}）理由：${c.why}`,
        t.progress ? `  进展：${t.progress.slice(0, 200)}` : "",
        pending ? `  ${pending}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    }),
  ]
    .filter(Boolean)
    .join("\n");

  return { system, prompt };
}

function clampAction(raw: unknown, allowed: AllowedIds): SummonAction | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const a = raw as Record<string, unknown>;
  const kind = a.kind;
  const label = typeof a.label === "string" ? a.label.slice(0, 20) : "";
  if (!label || typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) return undefined;
  const taskId = typeof a.taskId === "string" ? a.taskId : "";
  const text = typeof a.text === "string" ? a.text.slice(0, 2000) : "";
  switch (kind) {
    case "open_task":
    case "mark_done":
      return allowed.taskIds.includes(taskId) ? ({ kind, label, taskId } as SummonAction) : undefined;
    case "approve_pending": {
      const actionId = typeof a.actionId === "string" ? a.actionId : "";
      return allowed.taskIds.includes(taskId) && allowed.actionIds.includes(actionId) ? { kind, label, taskId, actionId } : undefined;
    }
    case "start_work": {
      const project = typeof a.project === "string" ? a.project : "";
      const p = typeof a.prompt === "string" ? a.prompt.slice(0, 2000) : "";
      return allowed.projects.includes(project) && p ? { kind, label, project, prompt: p } : undefined;
    }
    case "create_task": {
      const title = typeof a.title === "string" ? a.title.slice(0, 200) : "";
      return title ? { kind, label, title } : undefined;
    }
    case "note":
      return text ? { kind, label, text } : undefined;
    case "copy":
      return text ? { kind, label, text } : undefined;
    default:
      return undefined;
  }
}

export function parseCard(text: string, allowed: AllowedIds): SummonCard {
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  if (!json) return { verdict: "", actions: [] };
  try {
    const row = JSON.parse(json) as Record<string, unknown>;
    const actions = Array.isArray(row.actions) ? row.actions.map((a) => clampAction(a, allowed)).filter((a): a is SummonAction => Boolean(a)).slice(0, 3) : [];
    const matchTaskId = typeof row.matchTaskId === "string" && allowed.taskIds.includes(row.matchTaskId) ? row.matchTaskId : undefined;
    const reply = typeof row.reply === "string" && row.reply.trim() ? row.reply.slice(0, 2000) : undefined;
    return {
      verdict: typeof row.verdict === "string" ? row.verdict.slice(0, 400) : "",
      actions,
      ...(reply ? { reply } : {}),
      ...(matchTaskId ? { matchTaskId } : {}),
    };
  } catch {
    return { verdict: "", actions: [] };
  }
}

export async function summonCard(input: CardInput): Promise<SummonCard> {
  const allowed: AllowedIds = {
    taskIds: input.candidates.map((c) => c.task.id),
    actionIds: input.candidates.flatMap((c) => c.task.pending?.map((p) => p.id) ?? []),
    projects: [...new Set(input.candidates.map((c) => c.task.project).filter((p): p is string => Boolean(p)))],
  };
  const { system, prompt } = cardPrompt(input);
  let out = "";
  for await (const ev of askStream(prompt, { systemPrompt: system, cwd: config.dataDir, model: SUMMON_MODEL, label: "summon" })) {
    if (ev.type === "delta") out += ev.text;
    if (ev.type === "reset") out = "";
  }
  return parseCard(out, allowed);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @friday/core exec vitest run src/agent/summon/card.test.ts`
Expected: PASS（8 个用例）

- [ ] **Step 5: 提交**

```bash
git add apps/core/src/agent/summon/card.ts apps/core/src/agent/summon/card.test.ts
git commit -m "呼出模式：模型卡片层，动作枚举越界一律钳掉"
```

---

### Task 4: 编排与 `POST /summon`

**Files:**
- Create: `apps/core/src/agent/summon/index.ts`
- Create: `apps/core/src/agent/summon/index.test.ts`
- Create: `apps/core/src/api/summon.ts`
- Create: `apps/core/src/api/summon.test.ts`
- Modify: `apps/core/src/api/index.ts`

**Interfaces:**
- Consumes: Task 2 的 `buildRules` / `candidates` / `parseSlackTitle`；Task 3 的 `summonCard`；已有 `listTasks`、`loadProjects`、`createTask`/`addNoteTask`、`takePending`
- Produces:
  ```ts
  export async function* summon(snapshot: Snapshot): AsyncGenerator<SummonEvent>
  ```
  接口：`POST /summon`（body `{ snapshot }`，SSE：先 `rules` 再 `card` 再 `done`）、`POST /summon/act`（body `{ action: SummonAction }` → `{ ok: true, taskId?, message }`）

- [ ] **Step 1: 写编排的失败测试**

创建 `apps/core/src/agent/summon/index.test.ts`：

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "@friday/shared";

const cardMock = vi.fn();
vi.mock("./card.js", () => ({ summonCard: cardMock, SUMMON_MODEL: "claude-sonnet-5" }));
vi.mock("../../memory/tasks.js", () => ({ listTasks: () => [] }));
vi.mock("../../memory/projects.js", () => ({ loadProjects: () => [] }));

const { summon } = await import("./index.js");

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    at: Date.now(),
    app: { bundleId: "com.apple.finder", name: "Finder", title: "下载" },
    permissions: { accessibility: true, automation: true, screen: true },
    ...over,
  };
}

describe("summon", () => {
  beforeEach(() => cardMock.mockReset());

  it("先发 rules 再发 done", async () => {
    const events = [];
    for await (const ev of summon(snap())) events.push(ev);
    expect(events[0]!.type).toBe("rules");
    expect(events.at(-1)!.type).toBe("done");
  });

  it("没有任何文字时不调模型", async () => {
    for await (const _ of summon(snap())) void _;
    expect(cardMock).not.toHaveBeenCalled();
  });

  it("有选中文字时调模型并发 card", async () => {
    cardMock.mockResolvedValue({ verdict: "这是一段报错", actions: [] });
    const events = [];
    for await (const ev of summon(snap({ selection: "TypeError: x is not a function" }))) events.push(ev);
    expect(cardMock).toHaveBeenCalledOnce();
    expect(events.map((e) => e.type)).toContain("card");
  });

  it("模型抛错时发 error 但仍然 done", async () => {
    cardMock.mockRejectedValue(new Error("超时"));
    const events = [];
    for await (const ev of summon(snap({ selection: "x" }))) events.push(ev);
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(events.at(-1)!.type).toBe("done");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @friday/core exec vitest run src/agent/summon/index.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现 `index.ts`**

```ts
import type { Snapshot, SummonEvent } from "@friday/shared";
import { listTasks } from "../../memory/tasks.js";
import { loadProjects } from "../../memory/projects.js";
import { buildRules, candidates, parseSlackTitle } from "./match.js";
import { summonCard } from "./card.js";

const SLACK_BUNDLE = "com.tinyspeck.slackmacgap";

export async function* summon(snapshot: Snapshot): AsyncGenerator<SummonEvent> {
  const tasks = listTasks(["collected", "understood", "processing", "review", "blocked"], 300);
  const projects = loadProjects();
  const { channel } = snapshot.app.bundleId === SLACK_BUNDLE ? parseSlackTitle(snapshot.app.title) : {};
  const input = { snapshot, tasks, projects, channel };
  const rules = buildRules(input);
  yield { type: "rules", rules };

  if (!rules.willThink) {
    yield { type: "done" };
    return;
  }

  try {
    const card = await summonCard({ snapshot, rules, candidates: candidates(input) });
    yield { type: "card", card };
  } catch (e) {
    yield { type: "error", message: e instanceof Error ? e.message : String(e) };
  }
  yield { type: "done" };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @friday/core exec vitest run src/agent/summon/index.test.ts`
Expected: PASS（4 个用例）

- [ ] **Step 5: 写接口的失败测试**

创建 `apps/core/src/api/summon.test.ts`。照 `apps/core/src/api/tasks.test.ts` 的现有写法准备临时 `FRIDAY_DATA_DIR` 与 `initMemory()`：

```ts
import { describe, expect, it } from "vitest";
import { app } from "./index.js";

const snapshot = {
  at: Date.now(),
  app: { bundleId: "com.apple.finder", name: "Finder", title: "下载" },
  permissions: { accessibility: false, automation: false, screen: false },
};

describe("POST /summon", () => {
  it("返回 SSE，首帧是 rules", async () => {
    const res = await app.request("/summon", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ snapshot }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await res.text();
    expect(body).toContain('"type":"rules"');
    expect(body).toContain('"type":"done"');
  });

  it("缺 snapshot 返回 400", async () => {
    const res = await app.request("/summon", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(400);
  });
});

describe("POST /summon/act", () => {
  it("create_task 建出任务并返回 id", async () => {
    const res = await app.request("/summon/act", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: { kind: "create_task", label: "建成任务", title: "呼出模式冒烟" } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; taskId?: string };
    expect(body.ok).toBe(true);
    expect(body.taskId).toBeTruthy();
  });

  it("不认识的动作返回 400", async () => {
    const res = await app.request("/summon/act", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: { kind: "launch_missile", label: "x" } }),
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 6: 运行测试确认失败**

Run: `pnpm --filter @friday/core exec vitest run src/api/summon.test.ts`
Expected: FAIL，404（路由还没挂）

- [ ] **Step 7: 实现 `api/summon.ts` 并挂上路由**

创建 `apps/core/src/api/summon.ts`。SSE 的写法照 `apps/core/src/api/events.ts` 或 `ask.ts` 里已有的 `streamSSE`：

```ts
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Snapshot, SummonAction } from "@friday/shared";
import { summon } from "../agent/summon/index.js";
import { addNoteTask } from "../memory/noteTask.js";
import { getTask, updateTask } from "../memory/tasks.js";

export const summonApi = new Hono()
  .post("/summon", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { snapshot?: Snapshot };
    if (!body.snapshot?.app) return c.json({ error: "缺 snapshot" }, 400);
    return streamSSE(c, async (stream) => {
      for await (const ev of summon(body.snapshot!)) await stream.writeSSE({ data: JSON.stringify(ev) });
    });
  })
  .post("/summon/act", async (c) => {
    const { action } = (await c.req.json().catch(() => ({}))) as { action?: SummonAction };
    if (!action?.kind) return c.json({ error: "缺 action" }, 400);
    switch (action.kind) {
      case "create_task": {
        const task = addNoteTask({ text: action.title, source: { summon: true } });
        return c.json({ ok: true, taskId: task.id, message: "已建成任务" });
      }
      case "mark_done": {
        if (!getTask(action.taskId)) return c.json({ error: "任务不存在" }, 404);
        updateTask(action.taskId, { status: "done", attention: undefined, pending: [] });
        return c.json({ ok: true, taskId: action.taskId, message: "已标完成" });
      }
      case "note": {
        appendMemory("decisions", action.text);
        return c.json({ ok: true, message: "已记进记忆库" });
      }
      default:
        return c.json({ error: `不支持的动作 ${action.kind}` }, 400);
    }
  });
```

`appendMemory` 按 `apps/core/src/memory/memory.ts` 里已有的追加写法实现（读全文 + 追加一行 + 写回），函数名以该文件实际导出为准；没有现成的就在 `api/summon.ts` 里就地写五行。

`open_task` / `approve_pending` / `start_work` / `copy` 由前端直接打各自已有的接口（`/tasks/:id/approve/:actionId`、`/run`、剪贴板），不走 `/summon/act`；`/summon/act` 只兜这两个没有现成入口的。

`addNoteTask` 的签名是 `addNoteTask(input: { text: string; due?: string; source?: TaskSource; kind?: "verbal" | "slack" }): Task`（`apps/core/src/memory/noteTask.ts:13`）。`source.summon` 是新字段，需要在 Task 1 的 `TaskSource` 里补一行 `/** 从呼出模式建的 */ summon?: boolean;`。

在 `apps/core/src/api/index.ts` 的 import 与 `.route("/", …)` 链上加 `summonApi`（放在 `usage` 后面）。

- [ ] **Step 8: 运行测试确认通过**

Run: `pnpm --filter @friday/core exec vitest run src/api/summon.test.ts && pnpm test && pnpm typecheck`
Expected: 全绿

- [ ] **Step 9: 提交**

```bash
git add apps/core/src/agent/summon apps/core/src/api/summon.ts apps/core/src/api/summon.test.ts apps/core/src/api/index.ts
git commit -m "呼出模式：编排与 POST /summon 接口"
```

---

### Task 5: 壳 · 权限查询

**Files:**
- Create: `apps/desktop/src-tauri/src/permissions.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/Cargo.toml`

**Interfaces:**
- Produces: Tauri 命令 `permission_status() -> PermissionStatus`（字段 `accessibility` / `automation` / `screen`）、`open_permission_pane(kind: String)`

- [ ] **Step 1: 加依赖**

`apps/desktop/src-tauri/Cargo.toml` 的 `[dependencies]` 追加：

```toml
objc2-app-kit = { version = "0.3.2", features = ["NSWorkspace", "NSRunningApplication", "NSPanel", "NSWindow", "NSApplication"] }
objc2-application-services = { version = "0.3", features = ["AXUIElement", "HIServices"] }
objc2-core-graphics = { version = "0.3", features = ["CGWindow"] }
tauri-plugin-clipboard-manager = "2"
```

若某个 crate 的 feature 名对不上，用 `cargo add <crate> --features ...` 让 cargo 自己解析，不要硬猜。

- [ ] **Step 2: 实现 `permissions.rs`**

```rust
use serde::Serialize;

#[derive(Serialize, Default)]
pub struct PermissionStatus {
    pub accessibility: bool,
    pub automation: bool,
    pub screen: bool,
}

pub fn status() -> PermissionStatus {
    PermissionStatus {
        accessibility: accessibility_trusted(),
        automation: automation_ok(),
        screen: screen_ok(),
    }
}

fn accessibility_trusted() -> bool {
    // AXIsProcessTrusted()，不带提示，不弹窗
    unsafe { objc2_application_services::AXIsProcessTrusted() }
}

fn screen_ok() -> bool {
    unsafe { objc2_core_graphics::CGPreflightScreenCaptureAccess() }
}

/// 自动化权限查不到状态，只能试调一次最轻的脚本看成功与否。
fn automation_ok() -> bool {
    std::process::Command::new("osascript")
        .args(["-e", "tell application \"System Events\" to return name of first process"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub fn open_pane(kind: &str) {
    let anchor = match kind {
        "accessibility" => "Privacy_Accessibility",
        "automation" => "Privacy_Automation",
        "screen" => "Privacy_ScreenCapture",
        _ => return,
    };
    let _ = std::process::Command::new("open")
        .arg(format!("x-apple.systempreferences:com.apple.preference.security?{anchor}"))
        .spawn();
}
```

`AXIsProcessTrusted` / `CGPreflightScreenCaptureAccess` 的实际路径以 crate 文档为准；找不到绑定时用 `extern "C"` 直接声明这两个 C 函数并链接 `ApplicationServices` / `CoreGraphics` 框架。

- [ ] **Step 3: 注册命令**

`lib.rs`：`mod permissions;`，加两个命令并写进 `generate_handler!`：

```rust
#[tauri::command]
fn permission_status() -> permissions::PermissionStatus {
    permissions::status()
}

#[tauri::command]
fn open_permission_pane(kind: String) {
    permissions::open_pane(&kind);
}
```

- [ ] **Step 4: 编译验证**

Run: `source ~/.cargo/env && cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: 编译通过（warning 可接受）

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src-tauri
git commit -m "呼出模式：壳侧三项权限状态查询"
```

---

### Task 6: 壳 · 环境快照

**Files:**
- Create: `apps/desktop/src-tauri/src/snapshot.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: Task 5 的 `permissions::status()`
- Produces: `pub fn capture(screenshot_fallback: bool) -> serde_json::Value`，形状与 Task 1 的 `Snapshot` 完全一致

- [ ] **Step 1: 实现 `snapshot.rs`**

四段，按顺序做，每段失败都只是让对应字段缺席，不 panic：

```rust
use serde_json::json;

const BROWSERS: &[&str] = &["com.google.Chrome", "com.apple.Safari", "company.thebrowser.Browser", "com.microsoft.edgemac"];

pub fn capture(screenshot_fallback: bool) -> serde_json::Value {
    let perms = crate::permissions::status();
    let (bundle_id, name) = front_app();
    let title = front_window_title();
    let browser = if BROWSERS.contains(&bundle_id.as_str()) { browser_tab(&bundle_id) } else { None };
    let selection = if perms.accessibility { selected_text() } else { None };
    let screenshot_path = if screenshot_fallback && browser.is_none() && selection.is_none() && perms.screen {
        capture_window()
    } else {
        None
    };
    json!({
        "at": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64,
        "app": { "bundleId": bundle_id, "name": name, "title": title },
        "browser": browser,
        "selection": selection,
        "screenshotPath": screenshot_path,
        "permissions": perms,
    })
}
```

- `front_app()`：`NSWorkspace::sharedWorkspace().frontmostApplication()`，取 `bundleIdentifier` 与 `localizedName`，拿不到返回 `("".into(), "".into())`。
- `front_window_title()`：走 AX —— `AXUIElementCreateApplication(pid)` → `AXFocusedWindow` → `AXTitle`。没有辅助功能权限时返回空串。
- `browser_tab(bundle_id)`：`osascript -e 'tell application "Google Chrome" to return URL of active tab of front window & "\n" & title of active tab of front window'`，Safari 用 `URL of front document` / `name of front document`，Arc 与 Edge 按 Chrome 的语法。输出按第一个换行拆成 url 与 title。超时用 `--max-time` 不可用（osascript 没有），改成子进程加 2 秒看门狗：起线程 `wait_timeout` 拿不到就 kill。
- `selected_text()`：`AXUIElementCreateSystemWide()` → `AXFocusedUIElement` → `AXSelectedText`，截断到 8000 字。**不要模拟 ⌘C。**
- `capture_window()`：先用 `CGWindowListCopyWindowInfo` 找前台 app 的 window id，再 `screencapture -x -o -l <id> <path>`，`path` 为 `<dataDir>/summon-shots/<uuid>.png`（目录不存在就建）；`dataDir` 从环境变量 `FRIDAY_DATA_DIR` 读，缺省 `~/Library/Application Support/Friday`。**返回文件的绝对路径**（不是 id，M1 不入 attachments 表）。写不成功返回 `None`。同目录下超过 20 张时删最旧的，避免无限堆积。

**注意**：`capture()` 必须在毫秒级返回，osascript 那段是唯一可能慢的，务必带看门狗。

- [ ] **Step 2: 加命令并手动验证**

`lib.rs` 加 `mod snapshot;` 与：

```rust
#[tauri::command]
fn capture_snapshot(screenshot_fallback: bool) -> serde_json::Value {
    snapshot::capture(screenshot_fallback)
}
```

Run: `source ~/.cargo/env && cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`
然后 `pnpm --filter @friday/desktop tauri dev`，在工作台的浏览器 devtools 里执行：

```js
await window.__TAURI_INTERNALS__.invoke("capture_snapshot", { screenshotFallback: true })
```

Expected: 返回对象里 `app.name` 是当前前台 app；切到 Chrome 再调一次能看到 `browser.url`。

- [ ] **Step 3: 提交**

```bash
git add apps/desktop/src-tauri
git commit -m "呼出模式：壳侧环境快照（前台 app、浏览器 URL、选中文字、兜底截图）"
```

---

### Task 7: 壳 · HUD 窗口与热键

**Files:**
- Create: `apps/desktop/src-tauri/src/hud.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/src/window.rs`
- Modify: `apps/desktop/src-tauri/capabilities/default.json`

**Interfaces:**
- Consumes: Task 6 的 `snapshot::capture`
- Produces: Tauri 命令 `take_pending_summon() -> Option<serde_json::Value>`、`hide_hud(app)`；`hud::toggle(app)`

- [ ] **Step 1: 预建隐藏窗口**

`hud.rs`：

```rust
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub struct PendingSummon(pub std::sync::Mutex<Option<serde_json::Value>>);

const WIDTH: f64 = 560.0;
const HEIGHT: f64 = 420.0;

pub fn prebuild(app: &AppHandle) {
    if app.get_webview_window("hud").is_some() {
        return;
    }
    let built = WebviewWindowBuilder::new(app, "hud", WebviewUrl::App("index.html?view=hud".into()))
        .title("Friday")
        .inner_size(WIDTH, HEIGHT)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .build();
    if let Ok(win) = built {
        #[cfg(target_os = "macos")]
        to_panel(&win);
        position_top_center(&win);
    }
}
```

`to_panel`：先试 `tauri-nspanel`（`Cargo.toml` 加 `tauri-nspanel = { git = "https://github.com/ahkohd/tauri-nspanel", branch = "v2" }`），把窗口转成非激活 `NSPanel`（`NSWindowStyleMaskNonactivatingPanel`，`setLevel(NSFloatingWindowLevel)`，`setCollectionBehavior` 加 `CanJoinAllSpaces | FullScreenAuxiliary`）。

**兜底（限时 2 小时）**：nspanel 接不上就删掉这段，保留普通窗口 + `always_on_top`，显示时用 `win.show()`，隐藏时把之前记下的前台 app 用 `NSRunningApplication::activateWithOptions` 激活回去。功能不受影响（快照已在显示前抓完）。

`position_top_center`：取主屏 `NSScreen::visibleFrame`，x 居中，y 距顶部 120px。

- [ ] **Step 2: toggle 与快照暂存**

```rust
pub fn toggle(app: &AppHandle) {
    let Some(win) = app.get_webview_window("hud") else { return };
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
        return;
    }
    let fallback = crate::settings::screenshot_fallback();
    let snap = crate::snapshot::capture(fallback);
    if let Ok(mut pending) = app.state::<PendingSummon>().0.lock() {
        *pending = Some(snap.clone());
    }
    position_top_center(&win);
    let _ = win.show();
    let _ = win.emit("friday://summon", snap);
}
```

`settings::screenshot_fallback()`：在 `settings.rs` 里读记忆库 `settings.json` 的 `summon.screenshotFallback`，缺省 `true`（照该文件读 `hotkey` 的写法）。

`lib.rs` 里：`mod hud;`，`app.manage(hud::PendingSummon(Mutex::new(None)))`，`hud::prebuild(app.handle())` 放在 `window::open_chat(...)` 之后；热键处理从 `window::toggle_main(app)` 改成 `hud::toggle(app)`；新增命令 `take_pending_summon`、`hide_hud`，都写进 `generate_handler!`。

托盘「打开 Friday」与 Dock / Reopen 仍走 `window::show_main`，工作台行为不变。

- [ ] **Step 3: capabilities 放行**

`apps/desktop/src-tauri/capabilities/default.json`：`windows` 加 `"hud"`，`permissions` 加 `"clipboard-manager:allow-write-text"`。`lib.rs` 注册 `tauri_plugin_clipboard_manager::init()`。

- [ ] **Step 4: 手动验证**

Run: `pnpm --filter @friday/desktop tauri dev`
Expected: 按 `⌘⇧Space` 弹出一个 560 宽的空白浮窗（前端还没写，白屏或报错都正常），再按一次收起；**菜单栏上的 app 名不变**（说明没抢焦点）。若用了兜底方案，这条会不满足，记录下来在 Task 9 复核。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src-tauri
git commit -m "呼出模式：HUD 浮窗与热键改指 HUD"
```

---

### Task 8: HUD 前端

**Files:**
- Create: `apps/desktop/src/views/Hud.tsx`
- Create: `apps/desktop/src/lib/summon.ts`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/styles.css`
- Modify: `apps/desktop/src/views/Settings.tsx`

**Interfaces:**
- Consumes: Task 4 的 `/summon`、`/summon/act`；Task 5 的 `permission_status` / `open_permission_pane`；Task 7 的 `take_pending_summon` / `hide_hud` 与 `friday://summon` 事件
- Produces: 无（终端消费者）

- [ ] **Step 1: SSE 客户端**

`apps/desktop/src/lib/summon.ts`，照 `lib/core.ts` 里 `readSse` 的写法：

```ts
import { invoke } from "@tauri-apps/api/core";
import type { Snapshot, SummonAction, SummonEvent } from "@friday/shared";
import { coreBaseUrl } from "./core";

export async function* summonStream(snapshot: Snapshot, signal: AbortSignal): AsyncGenerator<SummonEvent> {
  const res = await fetch(`${await coreBaseUrl()}/summon`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ snapshot }),
    signal,
  });
  if (!res.ok || !res.body) {
    yield { type: "error", message: `core 返回 ${res.status}` };
    yield { type: "done" };
    return;
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
      if (data) yield JSON.parse(data) as SummonEvent;
    }
  }
}

/** 执行一个动作，返回给用户看的一句话。 */
export async function runAction(action: SummonAction): Promise<string> {
  const base = await coreBaseUrl();
  switch (action.kind) {
    case "open_task":
      // 工作台没有按 taskId 聚焦的现成入口，M1 只负责打开它，不新造事件
      await invoke("open_chat", { conversationId: null, initialPrompt: null });
      return "已打开工作台";
    case "approve_pending": {
      const res = await fetch(`${base}/tasks/${action.taskId}/approve/${action.actionId}`, { method: "POST" });
      if (!res.ok) throw new Error(`执行失败 ${res.status}`);
      return "已执行";
    }
    case "start_work": {
      const res = await fetch(`${base}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: action.project, task: action.prompt }),
      });
      if (!res.ok) throw new Error(`开工失败 ${res.status}`);
      return `已在 ${action.project} 开工`;
    }
    case "copy":
      await navigator.clipboard.writeText(action.text);
      return "已复制";
    default: {
      const res = await fetch(`${base}/summon/act`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const body = (await res.json()) as { ok?: boolean; message?: string; error?: string };
      if (!res.ok || !body.ok) throw new Error(body.error ?? "执行失败");
      return body.message ?? "已完成";
    }
  }
}
```

`RunRequest` 是 `{ project: string; task?: string; conversationId?: string }`（`packages/shared/src/index.ts:77`），上面的请求体已对齐。响应可能是 `{ status: "ambiguous", candidates }`，那时不要当成功——把 `已在 … 开工` 换成提示用户项目名有歧义。

- [ ] **Step 2: HUD 视图**

`apps/desktop/src/views/Hud.tsx`。要点：

- mount 时先 `invoke("take_pending_summon")` 拿快照（窗口刚建时 emit 会丢），同时监听 `friday://summon` 事件覆盖后续每次呼出；两条都调 `start(snapshot)`。
- `start` 里 `AbortController` 取消上一轮，`for await (const ev of summonStream(...))` 依次 setState：`rules` → 立刻渲染 saw / match / actions；`card` → 覆盖 verdict / reply，动作用卡片给的（非空时）否则保留规则的。
- 渲染结构：
  ```tsx
  <div className="hud">
    <button className="hud__saw" onClick={() => setOpen(!open)}>{rules?.saw ?? "看看你在做什么…"}</button>
    {open && <div className="hud__raw">{/* URL、选中文字原文、截图 <img src={convertFileSrc(snapshot.screenshotPath)} />（`convertFileSrc` 来自 `@tauri-apps/api/core`） */}</div>}
    {rules?.match && <div className="hud__match"><span className={`dot dot--${statusDot(rules.match.status)}`} />{rules.match.title}<span className="hud__why">{rules.match.why}</span></div>}
    {card?.verdict ? <p className="hud__verdict">{card.verdict}</p> : rules?.willThink && <p className="hud__verdict hud__verdict--think">正在判断…</p>}
    {card?.reply && <pre className="hud__reply">{card.reply}</pre>}
    <div className="hud__actions">{actions.map((a, i) => <button key={i} className={i === 0 ? "b b--primary" : "b"} onClick={() => act(a)}>{a.label}</button>)}</div>
    {note && <div className="hud__note">{note}</div>}
  </div>
  ```
- 键盘：`Escape` → `invoke("hide_hud")`；`Enter`（焦点不在可聚焦控件上时）→ 执行第一个动作；`⌘1/2/3` → 执行第 n 个；`⌘Enter` → `invoke("open_chat", { conversationId: null, initialPrompt: null })` 打开工作台。照 `Board.tsx` 里「焦点已在可聚焦控件上就不抢 Enter」的判断抄一份，**不能让 Enter 在按钮聚焦时误触发不可逆动作**。
- `act(a)`：`approve_pending` 且是 `slack_reply` 时先展开确认区（可编辑文本 + ⌘↵ 确认），其余直接执行；成功后 `setNote("已…")`，1.5 秒后 `invoke("hide_hud")`；失败把错误留在 `hud__note` 不自动收。
- **确认区打开时 `⌘Enter` 归确认区**（就这么发），不再是打开工作台。
- 窗口高度自适应：`useLayoutEffect` 里量 `.hud` 的 `scrollHeight`，`invoke` 一个 `resize_hud` 命令或用 `getCurrentWindow().setSize(new LogicalSize(560, h))`（`@tauri-apps/api/window`，capabilities 已放行 `allow-set-size`）。

- [ ] **Step 3: 路由与样式**

`App.tsx`：

```tsx
const view = new URLSearchParams(location.search).get("view");

export function App() {
  if (view === "settings") return <Settings />;
  if (view === "hud") return <Hud />;
  return <Chat />;
}
```

`styles.css` 末尾加 `.hud*` 一组：深色卡片（`--bg-2` 底、`--line-1` 边、`--r-lg` 圆角、`--shadow-pop`）、`padding: var(--s-5)`、字号用 `--t-body` / `--t-aux` / `--t-micro`、`.hud__verdict--think` 用 `--live` 做呼吸光环、按钮沿用 `.b` / `.b--primary`。`prefers-reduced-motion` 下去掉位移动画。**只用已有 token，不要新造颜色。**

- [ ] **Step 4: 设置页权限区**

`Settings.tsx` 新增「呼出模式」分组：三行权限（辅助功能 / 自动化 / 屏幕录制），每行 `permission_status` 的状态点 + 「去授权」按钮调 `open_permission_pane`；一个「没拿到内容时截图兜底」开关（`PUT /settings` 的 `summon.screenshotFallback`）。开关用已有的 `Row` 组件（带 `useId` + `aria-labelledby`）。

- [ ] **Step 5: 验证**

Run: `pnpm typecheck && pnpm --filter @friday/desktop tauri dev`
Expected: 按热键弹出 HUD，「我看到了」那行有内容；在 Finder 里选中一段文字再按，能看到「选中了 N 个字」并在几秒内出现判断。

- [ ] **Step 6: 提交**

```bash
git add apps/desktop/src
git commit -m "呼出模式：HUD 界面、动作执行与设置页权限区"
```

---

### Task 9: 真机验收与收尾

**Files:**
- Modify: 上述任何需要修的文件
- Modify: `CLAUDE.md`（在「窗口形态」一节后追加「呼出模式」小节，写清热键归属、快照来源、M2 未做的部分）

- [ ] **Step 1: 跑全量自动化**

Run: `pnpm test && pnpm typecheck && source ~/.cargo/env && cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: 全绿。有失败先修再往下。

- [ ] **Step 2: 逐条真机验收**

按 spec 7.2 逐条走，每条截图存到 `/tmp/summon-acceptance/`（不进仓库）：

1. Chrome 开一个 Meegle 工单页（该工单在 Friday 里有对应任务）→ `⌘⇧Space` → 卡片对上那条任务、`willThink` 为 false（用量面板「今天」不增加）→ 点「开工」→ 工作台里该任务进 processing。
2. Slack 停在一个已同步过的频道 → 呼出 → 「我看到了 Slack · #频道」→ 若该频道有关联任务则对上。
3. Finder 里选中一段文字 → 呼出 → 「选中了 N 个字」→ 展开能看到原文 → 出现判断。
4. 一个没选中文字、非浏览器的 app（如「系统设置」）→ 呼出 → 有截图 id，展开能看到图。
5. 在系统设置里临时关掉辅助功能权限 → 呼出 → HUD 仍出现，「我看到了」写明没拿到选中文字。
6. HUD 弹出时看菜单栏：app 名应保持为原前台 app（nspanel 生效）。若走了兜底方案，在这里如实记录「HUD 打字时会短暂抢焦点」。
7. 焦点停在「打开任务」按钮上按 Enter → 只触发该按钮，不触发主动作。

- [ ] **Step 3: 补 CLAUDE.md**

在「窗口形态（2026-09-07 晚重排）：只有工作台」一节之后追加一节，写明：`⌘⇧Space` 现在呼出 HUD（label `hud`，预建隐藏的 NSPanel），工作台改由托盘 / Dock / HUD 内 `⌘↵` 进入；快照在显示 HUD 之前抓（顺序不能反）；`/summon` 先规则后模型、无文字不调模型；三项权限缺任何一项都降级不报错；M2（activity 采集、zsh hook、Slack/Meegle 状态回流）未做。

- [ ] **Step 4: 提交并合并回 main**

```bash
git add -A
git commit -m "呼出模式：真机验收与文档"
cd /Users/jinghaoran/hr-lys/friday   # 合并必须在主仓做，worktree 里 merge 会合到自己
git merge --no-ff feat/summon -m "合并呼出模式 M1"
```

合并前先在主仓 `git status` 确认干净。合并后按需 `git worktree remove ../friday-feat-summon`（分支用 `git branch -d`，没合并 git 会拒绝，那是安全阀）。

---

## Self-Review

**Spec 覆盖**：spec 3.1 快照 → Task 6；3.2 HUD 窗口与 nspanel 兜底 → Task 7；3.3 热键分配 → Task 7；5.1/5.2 规则匹配 → Task 2；5.3 模型与动作枚举 → Task 3；5.4 默认动作 → Task 2 的 `defaultActions`；5.5 时序（先 rules 后 card）→ Task 4；6.1 动作映射 → Task 4 + Task 8 的 `runAction`；6.2 HUD 前端 → Task 8；6.3 权限与设置 → Task 5 + Task 8；7.1 自动化测试 → Task 2/3/4；7.2 真机验收 → Task 9。

**未覆盖且有意为之**：spec 5.6 的「HUD 输入框走 /ask」在 M1 里没排任务——HUD 第一版只有动作按钮，输入框留到 M1 验收后按真实手感再定（若届时要做，是一个独立的小任务：把 `Thread` 的 compact 版挂进 `Hud.tsx`）。spec 第 4 节 activity 全部属于 M2。

**类型一致性**：`SummonRules.match` 在 Task 2 产出、Task 8 消费，字段名一致；`SummonAction` 七种 kind 在 Task 1 定义、Task 2 生成、Task 3 钳制、Task 4/8 执行，四处的 `kind` 字面量相同；`Snapshot` 的 `screenshotPath` 在 Task 6 产出绝对路径、Task 8 用 `convertFileSrc` 显示。
