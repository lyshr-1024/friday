# 理解卡（第三块）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 需求进来后 Friday 在后台读 PRD、仓库和知识库，写出一张理解卡（要做什么 / 别人要给什么 / 怎么验收含用例 / 怎么发 / 方案），按项目规则送你审；审过且依赖齐了，需求也能自主开工。

**Architecture:** 理解卡存在 `source.brief`（同 `source.intake` 的先例，不加表列）。建卡复用知识库冷启动的模式：每条需求一张隐藏锚点卡（`kind: "project"`、`source.briefFor`），起后台只读 `claude -p` 会话，经只对它列出的桥接工具 `friday_brief` 回报、`friday_web_read` 读网页。纯逻辑（解析、送审档位、渲染、队列挑选、门禁）放 `agent/brief.ts`，会话与收尾放 `agent/briefJob.ts`，审核流程接进现有的待审动作。门禁在 `autostart.ts` 加一条需求分支，缺陷那条不动。

**Tech Stack:** Node + TypeScript，`node:sqlite`，hono，vitest；React（`apps/desktop`）。

**Spec:** `docs/superpowers/specs/2026-10-21-story-pipeline-and-knowledge-base-design.md` 第「二、理解卡（Brief）」节（稿子里编号为三）。知识库（第一块）已在 `main`；缺陷归属、等依赖与催办、发布单不在本计划。

## Global Constraints

- 理解卡结构照设计稿：`todo` / `deps[]`（`what` / `from?` / `status: pending|ready` / `evidence?`）/ `acceptance`（`source: cases|prd|own`、`cases[]`、`note?`）/ `release` / `plan` / `size: small|large` / `sizeWhy` / `review: none|pending|approved|rejected` / `reviewNote?` / `stale?` / `at` / `features[]`。
- 用例清单至少 1 条，`friday_brief` 收到空清单就回错让它补（用户定：没有现成用例就自己写，非常重要）。
- `size` 判据写死在提示词里：新路由 / 新页面、接新接口、动公共组件（`components/` / `packages/` 这类目录）、预计改动文件 ≥ 5，任一命中就 `large`；把握不足也 `large`。
- 项目级键 `方案送审`：`全部` / `大的` / `不用`，缺省 `全部`；`全部` → 一律 `pending`，`大的` → `large` 才 `pending`，`不用` → `none`。从 `Project.extra["方案送审"]` 读，认不出的值按 `全部`。
- 项目级键 `用例`：原样进建卡提示词，缺省「没有，按 PRD 自己推」。
- 建卡一次一条，队列按 `due` → `priority`（high/normal/low）→ `createdAt`。
- 打回：带原因自动重建一次；第二次打回就停，等用户在会话里说。
- 建卡会话用 headless 默认模型（`HEADLESS_MODEL`）。
- 外部文本（标题、正文、Slack 原文、资料链接、知识库条目、网页正文）进提示词一律过 `untrusted()`。
- 待审动作类型 `brief_approve`，按钮文案「方案看过，开工」；会话里整句同意的词：`方案可以`、`按这个做`、`可以`、`通过`、`开工`。
- 用量 label：`brief`（`USAGE_LABELS.brief = "建理解卡"`）。
- 提交信息用中文，结尾带 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`；不覆盖仓库的 git author。
- 测试命令：`pnpm --filter @friday/core exec vitest run <文件>`；测试不起 tmux、不调真模型（`./sessions.js` 和 Agent SDK 都 mock）。

## 和设计稿不一样的地方（计划的决定）

- **存 `source.brief`，不加 `Task.brief` 列**：`source.intake` 已经是这么存判断结果的，免一次表迁移。
- **缺陷门禁本块不动**：设计稿要退役缺陷的把握分门禁，但那依赖第二块「缺陷挂需求、一组修」，先退役会让缺陷没路可走。本块只给需求加门禁。
- **哪些卡建理解卡**：没收工、`project` 已定、不是缺陷（`taskCategory !== "defect"`）、`kind` 是 `meegle` / `verbal` / `code` / `doc`、不是查询任务、不是 `source.storyContainer`（同步拉进来当缺陷容器的需求不是分派给你的）、`stage` 为空或 `todo`、没有 `jobId`。
- **自动建卡跟随「让 Friday 自己开工」总开关**（`settings.autonomous`，默认关）：每张卡要花几毛到一块钱。开关关着时卡上照样有「建理解卡」按钮，手动建。
- **`stale` 挡开工**：审过之后需求正文或资料变了，不让它照旧方案开工；卡上提示，点「重建」或在会话里说「按这个做」（重新批准）解除。
- **依赖手动标到了**：自动判定和催办是第四块；本块给卡上「到了」按钮和 `task_update.depReady`，否则有依赖的需求永远开不了工。
- **建卡失败**：记在 `source.briefFailed { at, why, log }`，不进送审，队列接着下一条；卡上写原因和日志路径。

## Review Focus

1. **建卡会话没调 `friday_brief` 就退出、或调了但字段不合法**：卡上落「理解没建成」和原因，锚点收工，队列下一轮接着处理别的卡，不卡死在这一条。→ Task 2 测试 `退出没报告记 briefFailed 并继续队列`、Task 1 测试 `parseBrief 拒绝空用例和越界字段`。
2. **同一条需求被并发建两次**（定时 tick 和手点「重建」撞上）：第二次回 409，不起第二个会话。→ Task 2 测试 `已在建的再点回 busy`。
3. **审核挂着时又重建 / 改档**：旧的 `brief_approve` 撤掉，不留两条；改成 `small` 且项目是「大的才审」时待审动作撤掉、`review` 变 `none`。→ Task 4 测试 `改档重算送审` 与 `重建撤掉旧的待审动作`。
4. **需求在 Meegle 里改了描述**：没审过的自动重建；审过的标 `stale`、不开工。→ Task 3 测试 `正文变了：未审重建、已审标 stale`、Task 5 测试 `stale 挡开工`。
5. **用户自己的交互式会话开着**：需求根会话是你开的交互式且没关，门禁跳过，不往里敲字。→ Task 5 测试 `交互式会话开着不开工`。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `packages/shared/src/index.ts` | `Brief` / `BriefDep` 类型、`TaskSource.brief / briefFor / briefFailed`、`PendingActionType` 加 `brief_approve`、`AutostartPlan` 加 `brief`、`USAGE_LABELS.brief` |
| `apps/core/src/agent/brief.ts`（新） | 纯逻辑：可建判断、队列挑选、解析、送审档位、指纹、渲染、开工交代 |
| `apps/core/src/agent/briefJob.ts`（新） | 锚点卡、起会话、收 `friday_brief`、退出收尾、`briefTick` |
| `apps/core/src/agent/bridge.ts`、`apps/core/src/api/mcp.ts` | `friday_brief` / `friday_web_read` 只对建卡 job 列出；锚点短路推广到建卡 job；`contextFor` 带理解卡 |
| `apps/core/src/agent/pipeline.ts` | `brief_approve` 执行分支；`rejectTask` 遇到 `brief_approve` 转 `rejectBrief`；`onJobExit` 交给 `finishBriefJob` |
| `apps/core/src/agent/autostart.ts` | 需求门禁、`AutostartPlan` 的 `brief`、tick 里的需求分支 |
| `apps/core/src/agent/tools.ts`、`apps/core/src/agent/taskUpdate.ts` | `APPROVAL.brief_approve`；`task_update` 加 `depReady` / `rebuildBrief` |
| `apps/core/src/api/brief.ts`（新）、`apps/core/src/api/index.ts` | 建 / 重建、改档、标依赖到了 |
| `apps/core/src/scheduler/index.ts` | Meegle 同步后跑 `briefTick` |
| `apps/desktop/src/views/Brief.tsx`（新）、`apps/desktop/src/views/Board.tsx`、`apps/desktop/src/lib/core.ts`、`apps/desktop/src/styles.css` | 理解卡界面 |
| `CLAUDE.md` | 文档 |

---

### Task 1: 类型与纯逻辑

**Files:**
- Modify: `packages/shared/src/index.ts`
- Create: `apps/core/src/agent/brief.ts`
- Test: `apps/core/src/agent/brief.test.ts`

**Interfaces:**
- Produces（shared）：
  ```ts
  export interface BriefDep { what: string; from?: string; status: "pending" | "ready"; evidence?: { url?: string; text?: string; at: string; source: "meegle" | "slack" | "user" } }
  export interface Brief {
    todo: string; deps: BriefDep[];
    acceptance: { source: "cases" | "prd" | "own"; cases: string[]; note?: string };
    release: string; plan: string; size: "small" | "large"; sizeWhy: string;
    review: "none" | "pending" | "approved" | "rejected"; reviewNote?: string; rejections?: number;
    stale?: boolean; basis: string; at: string; features: string[];
  }
  // TaskSource 加：brief?: Brief; briefFor?: string（建卡锚点，值是需求任务 id）; briefFailed?: { at: string; why: string; log?: string }
  // PendingActionType 加 "brief_approve"
  // AutostartPlan 加 { kind: "brief"; at: string; behind: number }
  // USAGE_LABELS.brief = "建理解卡"
  ```
- Produces（`agent/brief.ts`）：
  ```ts
  export type BriefPolicy = "全部" | "大的" | "不用";
  briefable(t: Task): boolean
  pickBriefQueue(tasks: Task[]): Task | undefined
  briefPolicy(p: Project | undefined): BriefPolicy
  reviewFor(size: Brief["size"], policy: BriefPolicy): "none" | "pending"
  briefBasis(t: Task): string                      // 标题 + description + docs url 的 sha1 前 12 位
  parseBrief(raw: unknown, ctx: { featureIds: Set<string>; basis: string; at?: string }): Brief | string   // 字符串 = 给 Claude 看的错误
  renderBrief(b: Brief): string                    // 卡上 plan 文本与待审动作 detail 用
  briefDetail(t: Task, b: Brief): string           // 自主开工交代给 startAutonomousJob 的 detail
  ```

- [ ] **Step 1: 写失败测试**

```ts
// brief.test.ts —— task(overrides) 帮手造最小 Task；project(extra) 帮手造 Project
it("briefable：缺陷、没项目、查询任务、容器、已开工、已收工、kind 不对都不建", () => {
  expect(briefable(task({ kind: "meegle", project: "p", source: { meegleType: "story" } }))).toBe(true);
  expect(briefable(task({ kind: "verbal", project: "p" }))).toBe(true);
  expect(briefable(task({ kind: "meegle", project: "p", source: { meegleType: "issue" } }))).toBe(false);
  expect(briefable(task({ kind: "verbal" }))).toBe(false);
  expect(briefable(task({ kind: "slack", project: "p", source: { headless: true, conversation: "c:1" } }))).toBe(false);
  expect(briefable(task({ kind: "meegle", project: "p", source: { meegleType: "story", storyContainer: true } }))).toBe(false);
  expect(briefable(task({ kind: "code", project: "p", source: { jobId: "j" } }))).toBe(false);
  expect(briefable(task({ kind: "code", project: "p", stage: "dev" }))).toBe(false);
  expect(briefable(task({ kind: "code", project: "p", status: "done" }))).toBe(false);
  expect(briefable(task({ kind: "project", project: "p" }))).toBe(false);
});
it("pickBriefQueue：跳过已有理解卡、建失败未重试、你说先别做的；按截止 → 优先级 → 进来先后", () => {
  const a = task({ id: "a", kind: "code", project: "p", due: "2026-11-05", priority: "normal", createdAt: "2026-10-01" });
  const b = task({ id: "b", kind: "code", project: "p", due: "2026-11-01", priority: "low", createdAt: "2026-10-02" });
  const c = task({ id: "c", kind: "code", project: "p", priority: "high", createdAt: "2026-09-01" });
  const done = task({ id: "d", kind: "code", project: "p", due: "2026-10-01", source: { brief: aBrief() } });
  const off = task({ id: "e", kind: "code", project: "p", due: "2026-10-01", source: { autostartOff: true } });
  const failed = task({ id: "f", kind: "code", project: "p", due: "2026-10-01", source: { briefFailed: { at: "x", why: "y" } } });
  expect(pickBriefQueue([a, b, c, done, off, failed])?.id).toBe("b");
});
it("briefPolicy 缺省和认不出的都按全部；reviewFor 三档", () => {
  expect(briefPolicy(undefined)).toBe("全部");
  expect(briefPolicy(project({ 方案送审: "大的" }))).toBe("大的");
  expect(briefPolicy(project({ 方案送审: "随便" }))).toBe("全部");
  expect(reviewFor("small", "全部")).toBe("pending");
  expect(reviewFor("small", "大的")).toBe("none");
  expect(reviewFor("large", "大的")).toBe("pending");
  expect(reviewFor("large", "不用")).toBe("none");
});
it("briefBasis：正文或资料变了指纹就变，顺序无关的字段不影响", () => {
  const t = task({ title: "T", source: { description: "d", docs: [{ url: "u1", from: "meegle" }] } });
  expect(briefBasis(t)).toBe(briefBasis({ ...t }));
  expect(briefBasis({ ...t, source: { ...t.source, description: "d2" } })).not.toBe(briefBasis(t));
  expect(briefBasis({ ...t, source: { ...t.source, docs: [] } })).not.toBe(briefBasis(t));
});
it("parseBrief 拒绝空用例和越界字段", () => {
  const ok = { todo: "做 A", deps: [{ what: "接口", status: "ready" }], acceptance: { source: "own", cases: ["打开页面看到 A"] }, release: "按 harua-deploy", plan: "改 src/a.tsx", size: "small", sizeWhy: "一个文件", features: ["f-11111111", "f-deadbeef"] };
  const r = parseBrief(ok, { featureIds: new Set(["f-11111111"]), basis: "b" });
  expect(typeof r).toBe("object");
  expect((r as Brief).features).toEqual(["f-11111111"]);
  expect((r as Brief).review).toBe("none");
  expect(parseBrief({ ...ok, acceptance: { source: "own", cases: [] } }, { featureIds: new Set(), basis: "b" })).toMatch(/用例/);
  expect(parseBrief({ ...ok, size: "huge" }, { featureIds: new Set(), basis: "b" })).toMatch(/size/);
  expect(parseBrief({ ...ok, todo: "" }, { featureIds: new Set(), basis: "b" })).toMatch(/todo/);
  expect((parseBrief({ ...ok, deps: [{ what: "x", status: "weird" }] }, { featureIds: new Set(), basis: "b" }) as Brief).deps[0]!.status).toBe("pending");
});
it("briefDetail 带上用例清单和「偏离方案要写明」", () => {
  const d = briefDetail(task({ title: "加筛选" }), aBrief({ acceptance: { source: "own", cases: ["选高风险只剩高风险"] } }));
  expect(d).toContain("选高风险只剩高风险");
  expect(d).toContain("偏离");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @friday/core exec vitest run src/agent/brief.test.ts`
Expected: FAIL，`brief.js` 不存在。

- [ ] **Step 3: 实现**

- `parseBrief`：字段长度钳到 `todo` / `plan` 各 4000 字、`release` 1000 字、单条用例 300 字、最多 30 条用例、最多 20 条依赖；`size` 不是两档之一、`todo` 为空、`cases` 为空、`acceptance.source` 不认识都返回错误字符串（写明哪个字段，Claude 拿到要能照着改）；依赖 `status` 不认识就当 `pending`；`features` 只留 `ctx.featureIds` 里有的；`review` 先填 `"none"`，由调用方按档位改。
- `renderBrief`：`## 要做什么` / `## 要别人给的`（每条「✓/… what — from」）/ `## 怎么验收`（来源一行 + 用例逐条编号）/ `## 怎么发` / `## 方案` / `规模：小/大（sizeWhy）`。
- `briefDetail`：开头一句「这条需求的理解卡已经审过（或不用审），照它做」，然后 `renderBrief`，再加三条规矩：「用例清单就是你自测的清单，交付报告的『请验证』逐条对应用例」「方案是起点，偏离了在报告里写明为什么」「依赖的证据（接口文档、设计稿链接）在上面，没写的去问 friday_context」。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @friday/core exec vitest run src/agent/brief.test.ts && pnpm typecheck`
Expected: PASS（`pnpm typecheck` 里 `main` 原有的 10 个 `protected` 缺失错误除外，不新增）。

- [ ] **Step 5: 提交**

```bash
git add packages/shared/src/index.ts apps/core/src/agent/brief.ts apps/core/src/agent/brief.test.ts
git commit -m "理解卡：类型与纯逻辑——可建判断、建卡队列、送审档位、正文指纹、解析校验、渲染与开工交代"
```

---

### Task 2: 建卡会话

**Files:**
- Create: `apps/core/src/agent/briefJob.ts`
- Test: `apps/core/src/agent/briefJob.test.ts`
- Modify: `apps/core/src/agent/bridge.ts`（`BRIDGE_TOOLS` 附近加两个工具；`bridgeToolsFor`；`callBridge` 开头分流；锚点短路）
- Modify: `apps/core/src/agent/pipeline.ts`（`onJobExit` 开头，知识库冷启动分支旁边）

**Interfaces:**
- Consumes: Task 1 全部；`openSession`（`agent/sessions.ts`，`kind: "query"`）；`matchFeatures` / `getFeature`（`memory/features.ts`）；`readChunk`（`agent/web.ts`）；`untrusted`；`contextFor` 不用——提示词自己拼；`closeJobTerminal`；冷启动的锚点写法见 `agent/knowledgeBootstrap.ts` 的 `startKnowledgeBootstrap` / `finishBootstrap`（锚点在会话开起来之后才标 processing、收尾 `.catch` 打日志、`onJobExit` 返回 `undefined`）。
- Produces：
  ```ts
  briefPrompt(t: Task, p: Project, rejected?: string): string
  startBriefJob(taskId: string): Promise<{ jobId: string } | { error: string; status: 404 | 409 }>
  storeBrief(taskId: string, raw: unknown): { ok: true; review: Brief["review"] } | { ok: false; error: string }
  finishBriefJob(anchor: Task, jobId: string, exitCode: number): Promise<void>
  // bridge.ts
  export const BRIEF_TOOL: BridgeTool;     // "friday_brief"，参数即 Brief 去掉 review/stale/basis/at/rejections
  export const WEB_TOOL: BridgeTool;       // "friday_web_read" { url, offset? }
  ```

- [ ] **Step 1: 写失败测试**

```ts
// briefJob.test.ts —— vi.mock("./sessions.js", () => ({ openSession: vi.fn(async () => "job-1") })); vi.mock("./web.js") 返回固定 chunk
it("startBriefJob：开锚点卡、起只读会话，锚点会话开起来才标处理中", async () => { /* 断言 openSession 收到 kind "query"、锚点 source.briefFor = 任务 id、status processing、source.jobId */ });
it("已在建的再点回 busy", async () => { /* 第一次后插一条 running 的 job-1，第二次回 status 409 */ });
it("不能建的卡回 404 并写明原因", async () => { /* 缺陷卡 → { status: 404, error 含「缺陷」 } */ });
it("storeBrief：方案送审 全部 → pending 并挂 brief_approve；不用 → none 不挂", () => { /* 两个项目各写 projects.md；断言 source.brief.review 与 pending 类型 */ });
it("storeBrief：重建时撤掉旧的 brief_approve、清掉 briefFailed、plan 换成渲染文本", () => { /* 先挂一条 brief_approve，再 store；pending 里只剩新的一条 */ });
it("storeBrief：字段不合法回错误，卡不动", () => { /* cases 空 → ok false，source.brief 仍为空 */ });
it("callBridge friday_brief：建卡 job 能调、别的 job 回错；friday_done 对建卡 job 只回一句", async () => { /* 同冷启动的短路测试写法 */ });
it("bridgeToolsFor：建卡 job 多 friday_brief 和 friday_web_read", () => { /* … */ });
it("friday_web_read 返回正文并过围栏；读到登录页回提示", async () => { /* mock readChunk 两种返回 */ });
it("退出没报告记 briefFailed 并继续队列", async () => {
  // 锚点 job 退出，任务没有 source.brief → source.briefFailed.why 含「没调 friday_brief」、log 指向 runs/<jobId>.log；锚点 done；onJobExit 返回 undefined
});
it("briefPrompt：内联命中的知识库条目、项目的「用例」键、上一轮打回原因，外部文本都过围栏", () => { /* … */ });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @friday/core exec vitest run src/agent/briefJob.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

- `briefPrompt`：只读任务，不改文件不建分支。给：标题、正文（`source.description`）、`source.docs`、挂靠的 Slack 对话（`linksFor` 现有读法，同 `contextFor`）、`matchFeatures(project, 标题 + 正文)` 命中条目全文、项目说明（`projectDetail`）、项目「用例」键（缺省「没有，按 PRD 自己推」）、上一轮打回原因（有就放最前）。写明：PRD 是飞书文档就用 lark-doc skill 读，其他网页用 `friday_web_read`；读不到写进 `plan` 的「要你拍板」；在仓库里 grep 定位改哪里；按项目「用例」键导出用例，没有就自己写 golden path / 边界 / 回归，至少一条；`size` 判据（Global Constraints 原文）；依赖只列确定要别人给的，给了的写 `ready` 和证据；最后调一次 `friday_brief`，被回错就照错误改了再调，成功后直接退出，不写报告、不调 `friday_done`。
- `startBriefJob`：卡 `briefable` 为假 → 404（原因写清：缺陷 / 没项目 / 已开工…）；锚点 `findTaskBySource(s => s.briefFor === id, true)`，没有就建 `kind: "project"`、`source: { briefFor, repoDir, headless: true }`；锚点 `source.jobId` 的 job 在跑 → 409；`openSession(anchor, anchor, { kind: "query", project, repoDir, task: briefPrompt(...) })` 成功后锚点标 processing 写 `jobId`；需求卡清 `briefFailed`，`progress` 写「Friday 在读需求、写理解卡」；记账 `brief_build_start`。
- `storeBrief`：找需求卡（锚点的 `briefFor`）；`parseBrief`（`featureIds` = 该项目全部功能 id，`basis` = `briefBasis(task)`）；失败原样回错；成功按 `reviewFor(size, briefPolicy(project))` 定 `review`，`rejections` 沿用旧卡的；撤掉旧的 `brief_approve`；`pending` 时挂 `{ type: "brief_approve", label: "方案看过，开工", detail: renderBrief(b) }`；`plan` = `renderBrief(b)`；记账 `brief_built`（`how`：规模、送审档位、用例数）；`review === "pending"` 发通知「理解卡写好了，等你看 · 项目」。
- `finishBriefJob`：需求卡没有比本次 job 开始时间新的 `source.brief`（按 `brief.at` 与 job `startedAt` 比）→ 写 `briefFailed { at, why: 退出码非 0 ? "会话异常退出" : "没调 friday_brief 就退出了", log: <runsDir>/<jobId>.log }`、`progress` 写同样一句；锚点关终端、标 done；记账 `brief_build_done`。
- `onJobExit`：`job.task.source.briefFor` 为真 → `finishBriefJob(...).catch(打日志)`，返回 `undefined`。
- `bridge.ts`：`bridgeToolsFor` 对 `briefFor` 锚点返回 `[...BRIDGE_TOOLS, BRIEF_TOOL, WEB_TOOL]`；`callBridge` 里 `friday_brief` / `friday_web_read` 只认 `briefFor` 锚点；冷启动那行短路条件改成「`knowledgeBootstrap` 或 `briefFor`」，文案不变。`friday_web_read` 回 `untrusted("web", text)` + 「下一段 offset=N」提示，登录页回「读不到，要登录：<url>，写进 plan 的要你拍板」。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @friday/core exec vitest run src/agent/briefJob.test.ts src/agent/bridge.test.ts src/agent/knowledgeBootstrap.test.ts src/agent/pipeline.test.ts && pnpm typecheck`
Expected: PASS（不新增类型错误）。

- [ ] **Step 5: 提交**

```bash
git add apps/core/src/agent/briefJob.ts apps/core/src/agent/briefJob.test.ts apps/core/src/agent/bridge.ts apps/core/src/agent/pipeline.ts
git commit -m "理解卡建卡会话：每条需求一张隐藏锚点卡起只读 claude -p，读 PRD、仓库和知识库，经 friday_brief 回报，按项目档位挂「方案看过，开工」"
```

---

### Task 3: 建卡队列与手动入口

**Files:**
- Modify: `apps/core/src/agent/briefJob.ts`（加 `briefTick`）
- Modify: `apps/core/src/scheduler/index.ts:165-168`
- Create: `apps/core/src/api/brief.ts`；Modify: `apps/core/src/api/index.ts`
- Test: `apps/core/src/agent/briefJob.test.ts`（续）、`apps/core/src/api/brief.test.ts`

**Interfaces:**
- Consumes: Task 1 `pickBriefQueue` / `briefBasis`；Task 2 `startBriefJob`。
- Produces：
  ```ts
  briefTick(now?: number): Promise<"started" | "busy" | "idle">
  // HTTP：POST /tasks/:id/brief → startBriefJob（重建同一入口，已有理解卡也重建）
  ```

- [ ] **Step 1: 写失败测试**

```ts
it("briefTick：开关关着什么都不做", async () => { /* settings.autonomous false → "idle"，openSession 没调 */ });
it("briefTick：已有建卡会话在跑就不起新的（一次一条）", async () => { /* 一个锚点 job running → "busy" */ });
it("briefTick：挑队首起会话", async () => { /* 两条可建，due 早的那条起 */ });
it("正文变了：未审重建、已审标 stale", async () => {
  // A：brief.review pending、basis 与当前不符 → 撤掉 brief 和 brief_approve，进队列重建
  // B：brief.review approved、basis 不符 → brief.stale = true，不重建
  // C：basis 相符 → 不动
});
it("POST /tasks/:id/brief：可建 → 200，已在建 → 409，不能建 → 404，起会话抛错 → 500 带原文", async () => { /* hono app.request */ });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @friday/core exec vitest run src/agent/briefJob.test.ts src/api/brief.test.ts`
Expected: 新用例 FAIL。

- [ ] **Step 3: 实现**

- `briefTick`：先扫一遍开着的、有 `source.brief` 的卡做指纹比对（未审 → 清 `brief`、撤 `brief_approve`、记账 `brief_stale_rebuild`；已审 → `stale: true`、记账 `brief_stale`，同一条只记一次）；`settings.autonomous` 关着到此为止返回 `"idle"`；有 `briefFor` 锚点的 job 在跑 → `"busy"`；`pickBriefQueue(listTasks(["collected","understood"]))` 有就 `startBriefJob`。起会话抛 `TmuxMissingError` 打日志返回 `"idle"`。
- 调度：`meegleTick` 里 `autostartTick` 之前 `await briefTick().catch(打日志)`。
- `api/brief.ts`：`POST /tasks/:id/brief`；`{ error, status }` 原样回；抛错 500 带原文。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @friday/core exec vitest run src/agent/briefJob.test.ts src/api/brief.test.ts && pnpm typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/core/src/agent/briefJob.ts apps/core/src/agent/briefJob.test.ts apps/core/src/scheduler/index.ts apps/core/src/api/brief.ts apps/core/src/api/brief.test.ts apps/core/src/api/index.ts
git commit -m "理解卡队列：自主开工开着时每轮同步后建一条，需求正文变了没审的重建、审过的标过期；卡上可手动建 / 重建"
```

---

### Task 4: 审核、打回、改档、依赖

**Files:**
- Modify: `apps/core/src/agent/pipeline.ts`（`executePending` 加 `brief_approve` 分支；`rejectTask` 开头转 `rejectBrief`）
- Modify: `apps/core/src/agent/briefJob.ts`（`rejectBrief` / `setBriefSize` / `markDepReady`）
- Modify: `apps/core/src/agent/tools.ts:641`（`APPROVAL`）、`apps/core/src/agent/taskUpdate.ts`（`depReady` / `rebuildBrief`）
- Modify: `apps/core/src/api/brief.ts`
- Modify: `apps/core/src/agent/bridge.ts`（`contextFor` 带理解卡）
- Test: `apps/core/src/agent/briefJob.test.ts`（续）、`apps/core/src/agent/taskUpdate.test.ts`、`apps/core/src/api/brief.test.ts`

**Interfaces:**
- Consumes: Task 2 `storeBrief` / `startBriefJob`；Task 1 `reviewFor` / `briefPolicy` / `renderBrief`。
- Produces：
  ```ts
  rejectBrief(taskId: string, reason: string): Task | undefined
  setBriefSize(taskId: string, size: Brief["size"]): Task | string
  markDepReady(taskId: string, match: string | number): Task | string   // number = 下标；string = what 里包含
  // HTTP：PATCH /tasks/:id/brief { size }；POST /tasks/:id/brief/deps/:index/ready
  // task_update 加：depReady?: string（依赖名里的关键词）；rebuildBrief?: boolean
  ```

- [ ] **Step 1: 写失败测试**

```ts
it("brief_approve 执行：review approved、stale 清掉、任务不收工、记账", async () => { /* executePending 后 status 仍 understood，source.brief.review approved */ });
it("打回第一次：rejected + 原因，自动重建一次（提示词带原因）", async () => { /* rejectTask(id, "接口不对") → rejections 1，startBriefJob 被调，briefPrompt 含「接口不对」 */ });
it("打回第二次：停下不重建", async () => { /* rejections 已 1 → 2，不起会话，progress 写「等你在会话里说怎么改」 */ });
it("rejectTask 对没有 brief_approve 的卡照旧", () => { /* 原有行为不变 */ });
it("改档重算送审", () => {
  // 项目「大的」：large pending → small：review none、brief_approve 撤掉；small none → large：pending、挂上
  // 已 approved 的改档：保持 approved
});
it("重建撤掉旧的待审动作", async () => { /* 有 brief_approve 时 POST /tasks/:id/brief → pending 里没有 brief_approve */ });
it("标依赖到了：按下标、按关键词；关键词没对上回错", () => { /* evidence.source user */ });
it("task_update depReady / rebuildBrief", async () => { /* … */ });
it("会话里「按这个做」批准 brief_approve", async () => { /* APPROVAL 映射：consents("按这个做") */ });
it("contextFor 带理解卡要点（要做什么、用例、方案），过围栏", () => { /* … */ });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @friday/core exec vitest run src/agent/briefJob.test.ts src/agent/taskUpdate.test.ts src/api/brief.test.ts src/agent/bridge.test.ts`
Expected: 新用例 FAIL。

- [ ] **Step 3: 实现**

- `executePending`：`brief_approve` → `source.brief` 改 `review: "approved"`、`stale: undefined`，记账 `brief_approved`（`status: "approved"`），**直接返回**（同 `start_job`，不走下面的收工）。
- `rejectTask`：卡上挂着 `brief_approve` 时 `return rejectBrief(id, reason ?? "无说明")`。
- `rejectBrief`：撤 `brief_approve`、`review: "rejected"`、`reviewNote`、`rejections + 1`，记账 `brief_rejected`；`rejections === 1` → `void startBriefJob(id).catch(写 briefFailed)`（提示词带原因）；否则 `progress`「方案被打回两次，等你在会话里说怎么改，说完点「重建」」。
- `setBriefSize`：没有理解卡回错；`approved` 的只改 `size` 不动审核；否则按新档位重算，`pending` ↔ `none` 时挂上 / 撤掉 `brief_approve`；记账 `brief_resized`。
- `markDepReady`：`evidence { source: "user", at, text: "你标的到了" }`；记账 `brief_dep_ready`。
- `APPROVAL.brief_approve = ["方案可以", "按这个做", "可以", "通过", "开工"]`。
- `task_update`：`depReady` 调 `markDepReady`；`rebuildBrief` 调 `startBriefJob`（返回原因给模型）。工具描述补这两个参数。
- `contextFor`：有 `source.brief` 时加 `untrusted("brief", renderBrief(b))`，放在「这件事是什么」之后。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @friday/core exec vitest run src/agent/briefJob.test.ts src/agent/taskUpdate.test.ts src/api/brief.test.ts src/agent/bridge.test.ts src/agent/pipeline.test.ts src/agent/tools.test.ts && pnpm typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/core/src/agent/pipeline.ts apps/core/src/agent/briefJob.ts apps/core/src/agent/briefJob.test.ts apps/core/src/agent/tools.ts apps/core/src/agent/taskUpdate.ts apps/core/src/agent/taskUpdate.test.ts apps/core/src/api/brief.ts apps/core/src/api/brief.test.ts apps/core/src/agent/bridge.ts apps/core/src/agent/bridge.test.ts
git commit -m "理解卡审核：「方案看过，开工」批准、打回带原因自动重建一次、改档重算送审、手动标依赖到了，终端和会话都能看到理解卡"
```

---

### Task 5: 需求的开工门禁

**Files:**
- Modify: `apps/core/src/agent/autostart.ts`
- Test: `apps/core/src/agent/autostart.test.ts`

**Interfaces:**
- Consumes: Task 1 `briefable` / `briefDetail`；`startAutonomousJob`。
- Produces：
  ```ts
  storyEligible(t: Task, env: AutostartEnv): string | undefined    // undefined = 可以开
  // autostartPlan 对满足 storyEligible（忽略并发）的需求回 { kind: "brief", at: now, behind: running }
  // pickAutostart 把需求和缺陷放一起按优先级 → 先后排，共用并发 1
  ```

- [ ] **Step 1: 写失败测试**

```ts
it("storyEligible：没理解卡 / 待审 / 打回 / 过期 / 依赖没齐 / 没项目 / 已开工 / 挂着问题 / 你说先别做，各自拒绝并写明", () => { /* 每条一个断言，原因字符串含关键字 */ });
it("storyEligible：审过或不用审、依赖齐、未开始 → 放行，不看 intake、不等 15 分钟", () => { /* createdAt 是 now，仍放行 */ });
it("缺陷门禁不变", () => { /* 现有 eligible 用例照过 */ });
it("autostartPlan 对能开的需求给 brief 计划", () => { /* kind "brief" */ });
it("stale 挡开工", () => { /* brief.stale true → 拒绝，原因含「需求变了」 */ });
it("交互式会话开着不开工", async () => { /* 根会话 interactive 未关 → autostartTick 不调 startAutonomousJob */ });
it("autostartTick 对需求用 briefDetail 开工、trigger autostart、记账 why 写「理解卡审过」", async () => { /* mock startAutonomousJob 断言 detail 含用例 */ });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @friday/core exec vitest run src/agent/autostart.test.ts`
Expected: 新用例 FAIL。

- [ ] **Step 3: 实现**

- `storyEligible`：`status === "understood"`（或 `collected`）、`briefable(t)`、有 `source.brief`、`review` 是 `none` / `approved`、`!stale`、`deps.every(ready)`、`!attention`、`!autostartOff`。拒绝原因用卡上能直接显示的话：「还没有理解卡」「理解卡等你审」「方案被打回了」「需求变了，理解卡要重看」「等 X 给 Y」（第一条没到的依赖）。
- `pickAutostart`：候选 = `!eligible(t) || !storyEligible(t)`，原排序与并发不变。
- `autostartPlan`：缺陷那条之后，`storyEligible(t, { ...env, now: MAX })` 通过就回 `{ kind: "brief", at: now, behind: running }`。
- `autostartTick`：循环里按卡分流——有 `source.brief` 的走需求分支：`resolveProject(t.project)`、根会话交互式开着就跳过（同缺陷）、`startAutonomousJob(task, name, dir, briefDetail(t, brief), "autostart")`，记账 `autostart`（`why`：「理解卡${review === "approved" ? "你审过" : "按项目规则不用审"}、依赖齐了」），通知同缺陷。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @friday/core exec vitest run src/agent/autostart.test.ts && pnpm --filter @friday/core exec vitest run && pnpm typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/core/src/agent/autostart.ts apps/core/src/agent/autostart.test.ts
git commit -m "需求也能自己开工：理解卡审过或按项目不用审、依赖齐、需求没变，就按理解卡交代自主开工，跟缺陷共用并发 1"
```

---

### Task 6: 任务卡上的理解卡

**Files:**
- Create: `apps/desktop/src/views/Brief.tsx`
- Modify: `apps/desktop/src/views/Board.tsx`（`IdleState` 里挂理解卡；`FridayTop` 的排队文案加 `brief`；`SAY` 加 `brief_approve: "按这个做"`；`chatHint` 有 `brief_approve` 时写「按这个做 / 打回：原因」）
- Modify: `apps/desktop/src/lib/core.ts`、`apps/desktop/src/styles.css`

**Interfaces:**
- Consumes: shared `Brief` / `BriefDep`；HTTP：`POST /tasks/:id/brief`、`PATCH /tasks/:id/brief { size }`、`POST /tasks/:id/brief/deps/:index/ready`；现有 `/tasks/:id/approve/:actionId`、`/tasks/:id/reject`。

- [ ] **Step 1: 实现 `BriefCard({ t })`**

- 没有理解卡、`briefable` 的卡：一行「还没有理解卡」+ 按钮「建理解卡」；`briefFailed` 时写「理解没建成：why」+ 日志路径（等宽、可选中）+「重建」。
- 在建（`progress` 是「Friday 在读需求…」且没有 `brief`）：转圈 +「Friday 在读需求、写理解卡」，5 秒拉一次任务直到有结果。
- 有理解卡：头部「理解卡 · 规模 小/大 · 待你审 / 审过 / 不用审 / 被打回」+「重建」+ 改档切换；`stale` 时一条提示「需求变了，这张卡写在变之前，重建或在会话里说「按这个做」」。四段：要做什么（正文）/ 要别人给的（每条状态点 + what + from + 证据链接；`pending` 的有「到了」按钮）/ 怎么验收（来源 + 编号用例）/ 怎么发。方案默认折叠，展开看全文。命中的知识库条目一行（名字列表）。
- 待审时底部两个按钮：主按钮「方案看过，开工」（调 approve）、次按钮「打回…」（弹输入原因，调 reject）；后果预览一行：「通过后，依赖齐了 Friday 就会自己开工（自主开工开着时）」。
- 只用现有 token；`--live` 只给「在建」转圈。

- [ ] **Step 2: 接进 Board**

`IdleState` 的 `idle__box` 之前渲染 `<BriefCard t={t} />`（`briefable(t) || t.source.brief || t.source.briefFailed` 时）；`briefable` 在前端用同一套判断——从 `@friday/shared` 导出 `briefableKinds`，或在 `Brief.tsx` 里按同样条件写一份（选后者时在 Task 6 报告里写明两处要一起改）。`FridayTop` 对 `a.kind === "brief"` 写「理解卡${审过 / 不用审}、依赖齐了，轮到就开。」。

- [ ] **Step 3: 类型检查**

Run: `pnpm typecheck`
Expected: 不新增错误。

- [ ] **Step 4: 浏览器里走一遍**

按 CLAUDE.md「验收方式」起临时 core（`FRIDAY_PORT=7791 FRIDAY_DATA_DIR=<临时目录> FRIDAY_NO_SCHEDULER=1 FRIDAY_TMUX_SOCKET=friday-verify FRIDAY_CLAUDE_BIN=<假脚本>`）和 vite（`VITE_FRIDAY_PORT=7791 vite --port 1421`）；一次性脚本建一条 `kind: code` 的需求卡并直接 `storeBrief` 塞一张理解卡（一条 pending 依赖、三条用例、`review: pending`）。agent-browser 截图：没有理解卡的空态、理解卡全貌、方案展开、点「到了」后依赖变绿、点「方案看过，开工」后变「审过」、打回弹框、`stale` 提示。只 `kill` 自己 `$!` 记下的 PID，前后各看一次 `lsof -nP 2>/dev/null | grep -c /dev/ptmx`，结束 `tmux -L friday-verify kill-server`。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/views/Brief.tsx apps/desktop/src/views/Board.tsx apps/desktop/src/lib/core.ts apps/desktop/src/styles.css
git commit -m "任务卡上的理解卡：四段 + 用例 + 折叠的方案，依赖点「到了」，「方案看过，开工」/ 打回，需求变了提示重看"
```

---

### Task 7: 文档

**Files:**
- Modify: `CLAUDE.md`（「知识库（2026-10-21）」之后加「理解卡（2026-10-22）」一节；「Friday 自己开自主任务」一节里「需求一律不接」那句改成指向新一节）

- [ ] **Step 1: 写 CLAUDE.md 一节**

按现有各节写法：为什么（需求没有现场、门禁原来一律不接需求）→ 要点：存在 `source.brief`、哪些卡建、建卡会话（锚点、只读、两个桥接工具、短路）、队列与总开关、指纹与过期、送审档位、打回自动重建一次、改档、依赖手动标、门禁条件、开工交代、本块没做的（缺陷挂需求、依赖自动判定与催办、发布单）。

- [ ] **Step 2: 全量检查**

Run: `pnpm typecheck && pnpm test`
Expected: 测试全过；类型检查只剩 `main` 原有的 10 个 `protected` 缺失错误。

- [ ] **Step 3: 提交**

```bash
git add CLAUDE.md
git commit -m "文档：理解卡一节"
```
