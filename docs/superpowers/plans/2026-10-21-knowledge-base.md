# 知识库（第一块）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给每个注册项目建一份功能级知识库：Friday 收工时自己记、首次冷启动扫一遍、派活时注入给终端里的 Claude，项目页能看能删。

**Architecture:** SQLite 两张表 `features` / `feature_history`（`memory/features.ts`），渲染成记忆库 `knowledge/<项目>.md`（同 `handbooks/` 的生成物模式）。收工写入是 `finishTask` 标 done 后的一次 Sonnet oneShot（`agent/knowledge.ts`）；冷启动复用后台只读查询会话，经新桥接工具 `friday_knowledge` 回报（`agent/knowledgeBootstrap.ts`）。注入走 `knowledgeBlock`，挂进 `autonomousPrompt` 和 `contextFor`。

**Tech Stack:** Node + TypeScript，`node:sqlite`，hono，vitest；前端 React（`apps/desktop`）。

**Spec:** `docs/superpowers/specs/2026-10-21-story-pipeline-and-knowledge-base-design.md` 第「一、知识库」节。其余四块（缺陷归属、理解卡、催办、发布单）各出一份计划，不在这里。

## Global Constraints

- 功能 id：`f-` + 8 位 hex。
- `origin` 只有 `bootstrap` / `task`。
- `owners` 字段只有 `backend` / `pm` / `design` / `qa`，值是人名字符串。
- 收工写入：一个任务最多 5 条；`match` 必须是候选里的 id；`paths` 必须在主仓里存在。
- 冷启动：一次 `friday_knowledge` 调用最多 200 条；结果直接入库，不走审核；`sync_state` 键 `knowledge:bootstrapped:<项目>`。
- `matchFeatures` 默认 `limit = 5`，名字 / 别名短于 2 字不参与命中，零模型调用。
- 注入块上限 1500 字、整行截，同 `handbookBlock`。
- `knowledge/<项目>.md` 文件名走 `handbookSlug`，每条带 `<!-- f-xxxxxxxx -->`，头部注明「Friday 生成，改这个文件会被覆盖」。
- 外部文本（任务标题 / 理解 / 报告、仓库里读到的功能描述）进提示词一律过 `untrusted()`。
- 用量 label：`knowledge`（`USAGE_LABELS.knowledge = "收工记知识库"`）。
- 项目级四个键（`用例` / `发布` / `方案送审` / `催办提前`）本块不加解析：`projectDetail` 已把 `extra` 原样带进 `contextFor` 和 intake，类型化读取留给第三块理解卡。
- 冷启动沿用 headless 默认模型（`HEADLESS_MODEL` = opus），不为它单开模型参数——跟稿子写的 sonnet 不同，一项目只跑一次，不值得给 `openSession` 加参数。
- 提交信息用中文，结尾带 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`；不覆盖仓库的 git author。
- 测试命令都在 `apps/core` 下跑：`pnpm --filter @friday/core exec vitest run <文件>`。

## Review Focus

1. **撤销一次收工写入之后，后来别的任务写进同一功能的历史不能丢**：快照只记这次插入的 history 行 id 和这次动过的功能前态，还原只删这些行、只回这些功能。→ Task 2 测试 `restore 不碰之后别的任务写的历史`。
2. **模型给的路径是绝对路径、带 `./`、或 `../` 越出主仓**：`./` 归一化后保留，绝对路径和越出主仓的丢掉。→ Task 2 测试 `parseLearn 归一化并丢掉越界路径`。
3. **名字只差空格 / 大小写的重复功能**：`findFeatureByName` 去空白、忽略大小写，并且查别名；冷启动重扫不重复建。→ Task 1 测试 `findFeatureByName 忽略空白大小写并认别名`、Task 3 测试 `重扫按名字合并不重复建`。
4. **冷启动还在跑时再点一次**：回 409，不起第二个会话。→ Task 3 测试 `已有运行中的冷启动回 busy`。
5. **分支和 worktree 都删了、或主仓不是 git 仓库时收工**：改动文件从交付报告的 `changes`（`路径 — 说明`）回退取，不抛。→ Task 2 测试 `changedFiles 没有 worktree 时用报告`。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `packages/shared/src/index.ts` | `Feature` 等类型、`TaskSource.knowledgeBootstrap`、`USAGE_LABELS.knowledge` |
| `apps/core/src/memory/schema.ts` | 两张表 |
| `apps/core/src/memory/features.ts`（新） | 功能表读写、命中、快照还原、渲染 `knowledge/<项目>.md` |
| `apps/core/src/agent/knowledge.ts`（新） | 收工写入：提示词、解析、落库、记账 |
| `apps/core/src/agent/knowledgeBootstrap.ts`（新） | 冷启动：锚点卡、开会话、收 `friday_knowledge`、收尾补历史 |
| `apps/core/src/agent/pipeline.ts` | `finishTask` 调收工写入；`onJobExit` 把冷启动会话交给 `finishBootstrap` |
| `apps/core/src/agent/bridge.ts`、`apps/core/src/api/mcp.ts` | `friday_knowledge` 只对冷启动 job 列出和放行 |
| `apps/core/src/memory/audit.ts`、`apps/core/src/api/tasks.ts` | `restore_features` 撤销 |
| `apps/core/src/agent/runner.ts`、`apps/core/src/agent/bridge.ts`（`contextFor`） | 注入 |
| `apps/core/src/agent/tools.ts` | `memory_read knowledge:<项目>`、`knowledge_search`、`knowledge_bootstrap` |
| `apps/core/src/api/knowledge.ts`（新）、`apps/core/src/api/index.ts` | 项目页接口 |
| `apps/desktop/src/views/Projects.tsx`、`apps/desktop/src/styles.css` | 项目页「知识库」一节 |
| `CLAUDE.md`、`memory-schema/README.md` | 文档 |

---

### Task 1: 功能表、命中与渲染

**Files:**
- Modify: `packages/shared/src/index.ts`（`Rule` 定义附近加类型；`TaskSource` 加字段；`USAGE_LABELS` 加一项）
- Modify: `apps/core/src/memory/schema.ts`（`rule_evidence` 之后）
- Create: `apps/core/src/memory/features.ts`
- Test: `apps/core/src/memory/features.test.ts`

**Interfaces:**
- Produces（shared）：
  ```ts
  export type FeatureOrigin = "bootstrap" | "task";
  export interface FeatureOwners { backend?: string; pm?: string; design?: string; qa?: string }
  export interface Feature { id: string; project: string; name: string; aliases: string[]; where: string; paths: string[]; routes: string[]; owners: FeatureOwners; summary: string; origin: FeatureOrigin; createdAt: string; updatedAt: string }
  export interface FeatureHistory { id: number; featureId: string; taskId?: string; at: string; what: string; files: string[] }
  export interface FeatureView extends Feature { history: FeatureHistory[] }
  export interface ProjectKnowledge { features: FeatureView[]; bootstrappedAt?: string; bootstrapping: boolean }
  // TaskSource 加：knowledgeBootstrap?: string  —— 冷启动锚点卡，值是项目名
  ```
- Produces（`memory/features.ts`）：
  ```ts
  export interface FeatureInput { name: string; aliases?: string[]; where?: string; paths?: string[]; routes?: string[]; owners?: FeatureOwners; summary?: string }
  export interface FeaturesSnapshot { features: FeatureRow[]; added: string[]; historyIds: number[] }
  createFeature(project: string, input: FeatureInput, origin: FeatureOrigin, at?: string): Feature
  mergeFeature(id: string, input: Partial<FeatureInput>, at?: string): Feature
  getFeature(id: string): Feature | undefined
  listFeatures(project: string): Feature[]            // 按 updatedAt 倒序
  findFeatureByName(project: string, name: string): Feature | undefined
  deleteFeature(id: string): boolean                  // 连 history 一起删
  addFeatureHistory(h: Omit<FeatureHistory, "id">): number   // 返回行 id
  featureHistory(featureId: string): FeatureHistory[] // 按 at 倒序
  hasHistoryFor(featureId: string, taskId: string): boolean
  snapshotFeatures(ids: string[]): FeaturesSnapshot   // added / historyIds 由调用方填
  restoreFeatures(s: FeaturesSnapshot): string[]      // 返回涉及的项目，调用方重渲染
  matchFeatures(project: string, text: string, limit?: number): Feature[]
  renderKnowledge(project: string): string
  writeKnowledge(project: string): void               // 写 <dataDir>/knowledge/<slug>.md，没有功能时删文件
  readKnowledge(project: string): string
  listKnowledge(): string[]                           // 有知识库文件的项目
  ```

- [ ] **Step 1: 写失败测试**

```ts
// features.test.ts —— 每个用例用独立的项目名，测试共用一个临时库
it("create 之后能按项目列出，id 形如 f-xxxxxxxx", () => {
  const f = createFeature("p-c", { name: "基金筛选", paths: ["src/funds"] }, "task", "2026-10-01T00:00:00Z");
  expect(f.id).toMatch(/^f-[0-9a-f]{8}$/);
  expect(listFeatures("p-c").map((x) => x.name)).toEqual(["基金筛选"]);
});
it("merge：aliases/paths/routes 取并集，owners 新值覆盖旧值，where/summary 非空才覆盖", () => {
  const f = createFeature("p-m", { name: "提现规则", aliases: ["提现"], paths: ["a"], owners: { backend: "甲", pm: "乙" }, summary: "旧" }, "bootstrap");
  const m = mergeFeature(f.id, { aliases: ["提现", "出金规则"], paths: ["b"], owners: { backend: "丙" }, summary: "" });
  expect(m.aliases).toEqual(["提现", "出金规则"]);
  expect(m.paths).toEqual(["a", "b"]);
  expect(m.owners).toEqual({ backend: "丙", pm: "乙" });
  expect(m.summary).toBe("旧");
});
it("findFeatureByName 忽略空白大小写并认别名", () => {
  createFeature("p-n", { name: "Fund Filter", aliases: ["基金 筛选"] }, "task");
  expect(findFeatureByName("p-n", "fundfilter")?.name).toBe("Fund Filter");
  expect(findFeatureByName("p-n", "基金筛选")?.name).toBe("Fund Filter");
  expect(findFeatureByName("p-other", "fundfilter")).toBeUndefined();
});
it("matchFeatures：名字命中排在别名命中前，短于 2 字的别名不参与，别的项目不出现", () => {
  createFeature("p-x", { name: "基金筛选", aliases: ["筛"] }, "task");
  createFeature("p-x", { name: "提现规则", aliases: ["基金"] }, "task");
  createFeature("p-y", { name: "基金筛选" }, "task");
  const hits = matchFeatures("p-x", "财富页基金筛选加一个入口");
  expect(hits.map((h) => h.name)).toEqual(["基金筛选", "提现规则"]);
  expect(matchFeatures("p-x", "筛一下")).toEqual([]);
});
it("deleteFeature 连历史一起删", () => {
  const f = createFeature("p-d", { name: "A 功能" }, "task");
  addFeatureHistory({ featureId: f.id, taskId: "t1", at: "2026-10-02T00:00:00Z", what: "改了 A", files: [] });
  expect(deleteFeature(f.id)).toBe(true);
  expect(featureHistory(f.id)).toEqual([]);
});
it("renderKnowledge 每条带 id 注释，writeKnowledge 落到 knowledge/<项目>.md", () => {
  const f = createFeature("p-r", { name: "订单列表", where: "后台 › 订单", paths: ["src/orders"] }, "task");
  expect(renderKnowledge("p-r")).toContain(`<!-- ${f.id} -->`);
  writeKnowledge("p-r");
  expect(listKnowledge()).toContain("p-r");
  expect(readKnowledge("p-r")).toContain("订单列表");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @friday/core exec vitest run src/memory/features.test.ts`
Expected: FAIL，`features.js` 不存在。

- [ ] **Step 3: shared 类型、schema、`features.ts` 实现**

表结构：`features(id TEXT PK, project, name, aliases TEXT JSON, where_ TEXT, paths TEXT JSON, routes TEXT JSON, owners TEXT JSON, summary, origin, created_at, updated_at)`（`where` 是 SQL 关键字，列名用 `where_`）+ 索引 `features_project(project)`；`feature_history(id INTEGER PK AUTOINCREMENT, feature_id, task_id, at, what, files TEXT JSON)` + 索引 `feature_history_feature(feature_id)`。`snapshotFeatures` / `restoreFeatures` 照 `rules.ts` 的 scoped 快照写法：事务里删 `added` 的功能和它们的历史、删 `historyIds` 指的行、把 `features` 前态 upsert 回去。

`matchFeatures` 打分（零模型）：

```ts
// 名字整串出现在 text 里 +10，任一别名出现 +8（名字 / 别名去空白后 < 2 字跳过）；
// 只有命中过名字或别名的才进结果，再按 where + summary 的二字片段在 text 里出现的个数 +1/个 微调；
// 同分按 updatedAt 倒序，取前 limit 条。
```

`renderKnowledge` 格式：`# <项目> 知识库`、生成说明注释，每条一个 `## <名字> <!-- f-… -->` 小节，下列 `- 别名 / 在哪 / 目录 / 路由 / 负责人 / 说明 / 动过 N 次（最近：<what>）`，空字段不写。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @friday/core exec vitest run src/memory/features.test.ts && pnpm typecheck`
Expected: PASS，类型检查无错。

- [ ] **Step 5: 提交**

```bash
git add packages/shared/src/index.ts apps/core/src/memory/schema.ts apps/core/src/memory/features.ts apps/core/src/memory/features.test.ts
git commit -m "知识库：功能表与历史表、按名字和别名命中、渲染成 knowledge/<项目>.md"
```

---

### Task 2: 收工时自己记

**Files:**
- Create: `apps/core/src/agent/knowledge.ts`
- Test: `apps/core/src/agent/knowledge.test.ts`
- Modify: `apps/core/src/agent/pipeline.ts:84-91`（`finishTask`）
- Modify: `apps/core/src/memory/audit.ts:20-34`（`Undo` 加一种）
- Modify: `apps/core/src/api/tasks.ts:606` 附近（撤销分支）

**Interfaces:**
- Consumes: Task 1 的 `listFeatures` / `createFeature` / `mergeFeature` / `addFeatureHistory` / `snapshotFeatures` / `restoreFeatures` / `writeKnowledge`；`diffStatSync`（`agent/git.ts`）；`askStream` + `SONNET_MODEL`（`agent/claude.ts`，oneShot 收文本的写法见 `agent/weekly/draft.ts:60`）；`record`（`memory/audit.ts`）；`loadProjects`。
- Produces：
  ```ts
  export interface LearnItem extends FeatureInput { match?: string; what: string }
  cleanInput(raw: unknown, repoDir: string): FeatureInput | undefined   // 名字与路径的清洗规则，Task 3 冷启动共用
  learnPrompt(task: Task, files: string[], candidates: Feature[]): { system: string; prompt: string }
  parseLearn(text: string, candidates: Feature[], repoDir: string): LearnItem[]
  changedFiles(task: Task, repoDir: string): string[]
  applyLearn(project: string, taskId: string, items: LearnItem[], files: string[], at?: string): FeaturesSnapshot
  learnFromTask(task: Task, ask?: (system: string, prompt: string) => Promise<string>): Promise<FeaturesSnapshot | undefined>
  // audit.ts Undo 加：{ kind: "restore_features"; snapshot: FeaturesSnapshot }
  ```

- [ ] **Step 1: 写失败测试**

```ts
// knowledge.test.ts —— repoDir 用 mkdtemp 建临时目录，里面 mkdir 出 src/funds、src/orders
it("parseLearn：match 不在候选里的整条丢掉，超过 5 条截断，name 为空的丢掉", () => {
  const c = [createFeature("p-pl", { name: "基金筛选" }, "task")];
  const raw = JSON.stringify({ features: [
    { match: "f-deadbeef", name: "X", what: "w" },
    { name: "", what: "w" },
    ...Array.from({ length: 7 }, (_, i) => ({ name: `功能${i}`, what: "w" })),
  ] });
  const items = parseLearn(raw, c, repo);
  expect(items).toHaveLength(5);
  expect(items.every((i) => i.match === undefined)).toBe(true);
});
it("parseLearn 归一化并丢掉越界路径", () => {
  const items = parseLearn(JSON.stringify({ features: [{ name: "A", what: "w", paths: ["./src/funds", "/etc/passwd", "../other", "src/nope"] }] }), [], repo);
  expect(items[0]!.paths).toEqual(["src/funds"]);
});
it("parseLearn：输出不是 JSON 时返回空数组", () => {
  expect(parseLearn("抱歉我做不到", [], repo)).toEqual([]);
});
it("applyLearn：命中的合并、没命中的新建，每条写一行历史", () => {
  const f = createFeature("p-ap", { name: "基金筛选", paths: ["src/funds"] }, "task");
  const snap = applyLearn("p-ap", "t-1", [
    { match: f.id, name: "基金筛选", aliases: ["筛选入口"], what: "加了筛选入口" },
    { name: "订单列表", paths: ["src/orders"], what: "改了列宽" },
  ], ["src/funds/index.tsx"], "2026-10-21T00:00:00Z");
  expect(getFeature(f.id)!.aliases).toEqual(["筛选入口"]);
  expect(listFeatures("p-ap").map((x) => x.name).sort()).toEqual(["基金筛选", "订单列表"]);
  expect(featureHistory(f.id)[0]).toMatchObject({ taskId: "t-1", what: "加了筛选入口", files: ["src/funds/index.tsx"] });
  expect(snap.added).toHaveLength(1);
  expect(snap.historyIds).toHaveLength(2);
});
it("restore 不碰之后别的任务写的历史", () => {
  const f = createFeature("p-rs", { name: "基金筛选", summary: "旧" }, "task");
  const snap = applyLearn("p-rs", "t-1", [{ match: f.id, name: "基金筛选", summary: "新", what: "第一次" }], []);
  addFeatureHistory({ featureId: f.id, taskId: "t-2", at: "2026-10-22T00:00:00Z", what: "第二次", files: [] });
  restoreFeatures(snap);
  expect(getFeature(f.id)!.summary).toBe("旧");
  expect(featureHistory(f.id).map((h) => h.what)).toEqual(["第二次"]);
});
it("changedFiles 没有 worktree 时用报告", () => {
  const t = { ...baseTask, source: {}, report: { ...emptyReport, changes: ["src/funds/a.tsx — 加入口", "src/orders/b.ts — 改列宽"] } };
  expect(changedFiles(t, "/not/a/repo")).toEqual(["src/funds/a.tsx", "src/orders/b.ts"]);
});
it("learnFromTask：项目不在注册表里、没有分支也没有报告，都不调模型", async () => {
  const ask = vi.fn();
  expect(await learnFromTask({ ...baseTask, project: "不存在", status: "done" }, ask)).toBeUndefined();
  expect(ask).not.toHaveBeenCalled();
});
it("learnFromTask：调一次模型、落库、记一条可撤销的账", async () => {
  // projects.md 写入 p-lt 指向 repo；任务有 report
  const ask = vi.fn(async () => JSON.stringify({ features: [{ name: "订单列表", paths: ["src/orders"], what: "改了列宽" }] }));
  const snap = await learnFromTask({ ...baseTask, project: "p-lt", status: "done", report: reportWith(["src/orders/b.ts — 改列宽"]) }, ask);
  expect(ask).toHaveBeenCalledTimes(1);
  expect(listFeatures("p-lt").map((f) => f.name)).toEqual(["订单列表"]);
  expect(snap?.added).toHaveLength(1);
  expect(listAudit({ action: "knowledge_updated" })[0]).toMatchObject({ reversible: true });
});
```

（`baseTask` / `emptyReport` / `reportWith` / 写 `projects.md` 的帮手在测试文件里自己定义；`listAudit` 用 `memory/audit.ts` 现有的读账函数，名字以那边为准。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @friday/core exec vitest run src/agent/knowledge.test.ts`
Expected: FAIL，`knowledge.js` 不存在。

- [ ] **Step 3: 实现 `agent/knowledge.ts`**

- `learnPrompt`：system 要求只输出 `{ "features": [ { match?, name, aliases, where, paths, routes, owners, summary, what } ] }`；说明「一个功能 = 用户在界面上能叫出名字的东西；`match` 只能填下面候选里的 id；`paths` 写相对主仓的目录或文件；`what` 一句话写这次改了它什么」。prompt 给：标题、理解、交付报告概要和改动（过 `untrusted("task", …)`）、改动文件列表、候选（`id · 名字 · 别名 · paths` 一行一条）。
- `cleanInput`：`name` trim 后 1–40 字，否则 `undefined`；路径去掉前导 `./`，`isAbsolute` 或 `normalize` 后以 `..` 开头的丢，`existsSync(join(repoDir, p))` 为假的丢；`aliases` / `routes` 只留非空字符串；`owners` 只留四个键里的字符串。
- `parseLearn`：取第一个 `{…}` 解析，失败返回 `[]`；每条过 `cleanInput`，`match` 不在候选 id 里的整条丢，`what` 为空的丢，截前 5 条。
- 稿子里「卡上 `featureId` 那条必在输出里」依赖第二块（缺陷归属）才有的 `featureId`，本块不做。
- `changedFiles`：`task.source.worktree` 存在且是目录 → `diffStatSync(worktree)?.diffFiles.map((f) => f.path)`；否则取 `report.changes` 每行 ` — ` 前那段 trim；都没有返回 `[]`。最多 50 个。
- `applyLearn`：先 `snapshotFeatures(命中的 id)`，逐条 `mergeFeature` / `createFeature(project, item, "task", at)`，每条 `addFeatureHistory({ featureId, taskId, at, what, files })`，把新建 id 填进 `added`、history 行 id 填进 `historyIds`，最后 `writeKnowledge(project)`，返回快照。
- `learnFromTask`：守卫——`status === "done"`、有 `project` 且在 `loadProjects()` 里、（有 `source.branch` 或 `report`）；不满足返回 `undefined`。默认 `ask` 用 `askStream(prompt, { systemPrompt, cwd: config.dataDir, model: SONNET_MODEL, oneShot: true, label: "knowledge" })` 收 `delta`。`parseLearn` 为空就不落库不记账。落库后 `record({ taskId, action: "knowledge_updated", why: "任务收工，记下这次动了哪些功能", how: "<N> 条：名字、名字…", evidence: { features: [...ids] }, risk: "reversible", undo: { kind: "restore_features", snapshot } })`。
- `finishTask`：`updateTask` 之后，`status === "done"` 时 `void learnFromTask(t).catch((e) => console.warn("[knowledge]", e))`——不 await，收工不能被模型调用拖住。
- `api/tasks.ts` 撤销：`plan.kind === "restore_features"` → `restoreFeatures(plan.snapshot)` 返回的项目逐个 `writeKnowledge`，`setEventStatus(…, "undone")`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @friday/core exec vitest run src/agent/knowledge.test.ts src/agent/pipeline.test.ts && pnpm typecheck`
Expected: PASS（`pipeline.test.ts` 里的收工用例不受影响：它们的项目不在测试注册表里，`learnFromTask` 直接返回）。

- [ ] **Step 5: 提交**

```bash
git add apps/core/src/agent/knowledge.ts apps/core/src/agent/knowledge.test.ts apps/core/src/agent/pipeline.ts apps/core/src/memory/audit.ts apps/core/src/api/tasks.ts
git commit -m "知识库：任务收工时 Friday 自己记动了哪些功能，一次 Sonnet、路径要在仓库里存在、整次可撤销"
```

---

### Task 3: 冷启动

**Files:**
- Create: `apps/core/src/agent/knowledgeBootstrap.ts`
- Test: `apps/core/src/agent/knowledgeBootstrap.test.ts`
- Modify: `apps/core/src/agent/bridge.ts`（`BRIDGE_TOOLS` 之后加 `KNOWLEDGE_TOOL` 与 `bridgeToolsFor`；`callBridge` 开头分流）
- Modify: `apps/core/src/api/mcp.ts:27-28`（`tools/list` 改用 `bridgeToolsFor(jobId)`）
- Modify: `apps/core/src/agent/pipeline.ts`（`onJobExit` 在 `settleHandedBugs` 之前分流）

**Interfaces:**
- Consumes: Task 1 全部；`openSession`（`agent/sessions.ts`，`kind: "query"` 即只读 + cwd 主仓 + headless）；`createTask` / `findTaskBySource` / `updateTask`；`getCursor` / `setCursor`（`memory/inbox.ts`）；`closeJobTerminal`（`agent/terminal.ts`）；`getJob`。
- Produces：
  ```ts
  export const BOOTSTRAP_KEY = (project: string) => `knowledge:bootstrapped:${project}`;
  bootstrapPrompt(project: Project, existing: Feature[]): string
  startKnowledgeBootstrap(name: string): Promise<{ taskId: string; jobId: string } | { error: string; status: 404 | 409 }>
  ingestBootstrap(project: string, repoDir: string, raw: unknown): { added: number; updated: number; dropped: number }
  finishBootstrap(task: Task, jobId: string, exitCode: number): Promise<void>
  bootstrapState(project: string): { bootstrappedAt?: string; bootstrapping: boolean }
  // bridge.ts
  export const KNOWLEDGE_TOOL: BridgeTool;            // name "friday_knowledge"
  bridgeToolsFor(jobId: string): BridgeTool[]          // 冷启动 job 才多一个 KNOWLEDGE_TOOL
  ```

- [ ] **Step 1: 写失败测试**

```ts
// knowledgeBootstrap.test.ts —— repo 同 Task 2 用 mkdtemp；会话层 mock 掉
vi.mock("./sessions.js", () => ({ openSession: vi.fn(async () => "job-1") }));
it("ingestBootstrap：校验名字和路径，超 200 条截断，统计新建 / 合并 / 丢弃", () => {
  const raw = { features: [{ name: "基金筛选", paths: ["src/funds", "nope"] }, { name: "" }, ...Array.from({ length: 205 }, (_, i) => ({ name: `F${i}` }))] };
  const r = ingestBootstrap("p-ib", repo, raw);
  expect(r.added).toBe(199);
  expect(r.dropped).toBe(1);
  expect(findFeatureByName("p-ib", "基金筛选")).toMatchObject({ origin: "bootstrap", paths: ["src/funds"] });
});
it("重扫按名字合并不重复建", () => {
  ingestBootstrap("p-re", repo, { features: [{ name: "订单列表", paths: ["src/orders"] }] });
  const r = ingestBootstrap("p-re", repo, { features: [{ name: "订单 列表", routes: ["/orders"] }] });
  expect(r).toMatchObject({ added: 0, updated: 1 });
  expect(listFeatures("p-re")).toHaveLength(1);
});
it("已有运行中的冷启动回 busy", async () => {
  // projects.md 写入 p-busy；第一次开起来、job 状态 running
  expect(await startKnowledgeBootstrap("p-busy")).toMatchObject({ jobId: "job-1" });
  expect(await startKnowledgeBootstrap("p-busy")).toMatchObject({ status: 409 });
});
it("注册表里没有的项目回 404", async () => {
  expect(await startKnowledgeBootstrap("nope")).toMatchObject({ status: 404 });
});
it("bridgeToolsFor：只有冷启动 job 看得到 friday_knowledge", () => {
  // 一个 job 的 owner 任务带 source.knowledgeBootstrap，另一个不带
  expect(bridgeToolsFor(bootJob).map((t) => t.name)).toContain("friday_knowledge");
  expect(bridgeToolsFor(otherJob).map((t) => t.name)).not.toContain("friday_knowledge");
});
it("callBridge friday_knowledge：非冷启动 job 调用回错", async () => {
  expect(await callBridge(otherJob, "friday_knowledge", { features: [] })).toMatchObject({ isError: true });
});
it("finishBootstrap：按标题把近一年收工的任务补进历史、记水位、锚点收工", async () => {
  ingestBootstrap("p-fb", repo, { features: [{ name: "基金筛选" }] });
  // 建一条 project=p-fb、status done、标题含「基金筛选」、updatedAt 在 300 天内的任务；再建一条 400 天前的
  await finishBootstrap(anchor, "job-1", 0);
  const f = findFeatureByName("p-fb", "基金筛选")!;
  expect(featureHistory(f.id)).toHaveLength(1);
  expect(bootstrapState("p-fb").bootstrappedAt).toBeTruthy();
  expect(getTask(anchor.id)!.status).toBe("done");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @friday/core exec vitest run src/agent/knowledgeBootstrap.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

- 锚点卡：`findTaskBySource((s) => s.knowledgeBootstrap === name, true)`，没有就 `createTask({ title: \`知识库冷启动：${name}\`, kind: "project", status: "processing", project: name, source: { knowledgeBootstrap: name, repoDir: p.dir, headless: true } })`；有且 `source.jobId` 对应 job `status === "running"` → `{ error: "这个项目的知识库正在扫", status: 409 }`；done 的拉回 processing。`kind: "project"` 已被 `taskBoard` / 搜索排除，不进任务列表。
- `startKnowledgeBootstrap`：`openSession(anchor, anchor, { kind: "query", project: name, repoDir: p.dir, task: bootstrapPrompt(p, listFeatures(name)), jobId })`，写 `source.jobId`，记账 `knowledge_bootstrap_start`。
- `bootstrapPrompt`：只读任务；读路由表、菜单配置、页面目录；按「用户在界面上能叫出名字的功能」列，每条 `name / aliases / where / paths（相对主仓）/ routes / summary`；用 `friday_knowledge` 分批报，每批不超过 200 条；已有功能名单附上（名字一行一个），同名的照报、Friday 会合并；全部报完直接退出，不写报告文件、不调 `friday_done`。
- `ingestBootstrap`：`raw.features` 非数组当空；截前 200；逐条过 Task 2 的 `cleanInput`，`undefined` 计入 `dropped`，`findFeatureByName` 命中就 `mergeFeature`，否则 `createFeature(…, "bootstrap")`；最后 `writeKnowledge`。
- `callBridge`：在解析 `target` 之前，`name === "friday_knowledge"` 时取 job 的 owner 任务（`job.taskId` 或 `findTaskBySource(s => s.jobId === job.id)`），没有 `knowledgeBootstrap` 回 `{ text: "这个工具只给知识库冷启动用", isError: true }`；否则 `ingestBootstrap` 并回「新建 N、合并 M、丢弃 K」。
- `onJobExit`：`job.task.source.knowledgeBootstrap` 为真时 `void finishBootstrap(job.task, jobId, exitCode)` 并返回 `job.task`，不走后面的报告 / 审核逻辑。
- `finishBootstrap`：近 365 天（按 `updatedAt`）`status === "done"`、`project` 同名、`kind` 不是 `project` 的任务，`matchFeatures(project, title, 1)` 的第一条在名字或别名上字面命中、且 `!hasHistoryFor(id, task.id)` → `addFeatureHistory({ featureId, taskId, at: task.updatedAt, what: task.title, files: [] })`；`setCursor(BOOTSTRAP_KEY(p), now)`；`writeKnowledge`；记账 `knowledge_bootstrapped`（`how`：「共 N 条功能，补了 M 条历史」，退出码非 0 时写明「会话异常退出，已入库的照留」）；`closeJobTerminal(jobId, "知识库扫完了", task.id)`；锚点 `updateTask(id, { status: "done" })`。
- `bootstrapState`：`bootstrappedAt = getCursor(BOOTSTRAP_KEY(p))`，`bootstrapping` = 锚点存在且其 job 在跑。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @friday/core exec vitest run src/agent/knowledgeBootstrap.test.ts src/agent/bridge.test.ts && pnpm typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/core/src/agent/knowledgeBootstrap.ts apps/core/src/agent/knowledgeBootstrap.test.ts apps/core/src/agent/knowledge.ts apps/core/src/agent/bridge.ts apps/core/src/api/mcp.ts apps/core/src/agent/pipeline.ts
git commit -m "知识库冷启动：后台只读会话按界面上叫得出名字的功能列一遍，经 friday_knowledge 直接入库，收尾按标题补近一年的历史"
```

---

### Task 4: 注入与会话工具

**Files:**
- Modify: `apps/core/src/memory/features.ts`（加 `knowledgeBlock`）
- Modify: `apps/core/src/agent/runner.ts:21-55`（`autonomousPrompt`）
- Modify: `apps/core/src/agent/bridge.ts:149-173`（`contextFor`）
- Modify: `apps/core/src/agent/tools.ts`（`memory_read` 分支、两个新工具）
- Test: `apps/core/src/memory/features.test.ts`、`apps/core/src/agent/bridge.test.ts`、`apps/core/src/agent/tools.test.ts`

**Interfaces:**
- Consumes: Task 1 `matchFeatures` / `readKnowledge` / `listKnowledge` / `featureHistory`；Task 3 `startKnowledgeBootstrap`。
- Produces：
  ```ts
  knowledgeBlock(project: string, text: string, limit?: number): string   // 默认 1500；没命中返回 ""
  // 会话工具：knowledge_search({ project, query }) 只读；knowledge_bootstrap({ project }) 起冷启动
  // memory_read：file = "knowledge:<项目>" 读整份
  ```

- [ ] **Step 1: 写失败测试**

```ts
// features.test.ts
it("knowledgeBlock：命中的每条一行「名字 — 在哪 — 目录」，整行截到上限，没命中为空", () => {
  createFeature("p-kb", { name: "基金筛选", where: "财富 › 基金", paths: ["src/funds"] }, "task");
  expect(knowledgeBlock("p-kb", "基金筛选加入口")).toContain("基金筛选 — 财富 › 基金 — src/funds");
  expect(knowledgeBlock("p-kb", "完全无关")).toBe("");
  expect(knowledgeBlock("p-kb", "基金筛选", 10)).toBe("");
});
// bridge.test.ts
it("contextFor 带上命中的知识库条目", () => {
  // 建 p-ctx 的功能「订单列表」，任务标题含「订单列表」、project p-ctx
  expect(contextFor(task)).toContain("订单列表");
});
// tools.test.ts
it("memory_read knowledge:<项目> 读整份，没有时列出有知识库的项目", async () => { /* 调 handler 断言文本 */ });
it("knowledge_search 返回命中条目和最近一条历史", async () => { /* 调 handler 断言文本 */ });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @friday/core exec vitest run src/memory/features.test.ts src/agent/bridge.test.ts src/agent/tools.test.ts`
Expected: 新用例 FAIL。

- [ ] **Step 3: 实现**

- `knowledgeBlock`：`matchFeatures(project, text)` 每条 `- 名字 — where — paths.join("、")`（空段省略分隔），按 `handbookBlock` 的整行累计截法；有内容时前面加一行 `项目 ${project} 里跟这件事相关的功能（Friday 的知识库，可能不全；memory_read knowledge:${project} 看整份）：`——这行计入上限。
- `autonomousPrompt(id, task, project)`：`knowledgeBlock(project, task)` 非空就在手册块之前加一段。
- `contextFor`：项目行之后加 `knowledgeBlock(project.name, [task.title, task.understanding].join("\n"))`，整块过 `untrusted("knowledge", …)`（条目里的文字来自仓库与模型提炼）。交互终端靠它拿到知识（`terminalBridgePrompt` 已要求开工先调 `friday_context`），不改 `terminalBridgePrompt` 的签名。
- `memory_read`：`/^knowledge:(.+)$/` 读 `readKnowledge`，空时回「（没有 X 的知识库，现有：…；项目页可以点「建知识库」）」；工具描述里补这一种。
- `knowledge_search({ project: string, query: string })`：`matchFeatures(project, query, 10)`，每条带 `where / paths / routes / owners / summary` 和最近一条历史。
- `knowledge_bootstrap({ project: string })`：调 `startKnowledgeBootstrap`，回「已经在后台扫了，扫完项目页能看到」或错误原文。描述写明「一项目一次，要读整个仓库、花几毛到几块钱，用户说了再调」。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @friday/core exec vitest run src/memory/features.test.ts src/agent/bridge.test.ts src/agent/tools.test.ts src/agent/runner.test.ts && pnpm typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/core/src/memory/features.ts apps/core/src/memory/features.test.ts apps/core/src/agent/runner.ts apps/core/src/agent/bridge.ts apps/core/src/agent/bridge.test.ts apps/core/src/agent/tools.ts apps/core/src/agent/tools.test.ts
git commit -m "知识库注入：自主任务提示词和 friday_context 带上命中的功能，会话能 memory_read knowledge:<项目>、knowledge_search、knowledge_bootstrap"
```

---

### Task 5: 项目页「知识库」一节

**Files:**
- Create: `apps/core/src/api/knowledge.ts`
- Modify: `apps/core/src/api/index.ts`（挂路由）
- Test: `apps/core/src/api/knowledge.test.ts`
- Modify: `apps/desktop/src/views/Projects.tsx:41-75`（`Overview` 里「遗留 worktree」那行之后）
- Modify: `apps/desktop/src/styles.css`

**Interfaces:**
- Consumes: Task 1 `listFeatures` / `featureHistory` / `deleteFeature` / `writeKnowledge` / `getFeature`；Task 3 `startKnowledgeBootstrap` / `bootstrapState`；`record`。
- Produces（HTTP）：
  - `GET /projects/:name/knowledge` → `ProjectKnowledge`（项目不在注册表 404）
  - `POST /projects/:name/knowledge/bootstrap` → `{ taskId, jobId }`，错误按 `status` 回 404 / 409
  - `DELETE /features/:id` → `{ ok: true }`，不存在 404；记账 `feature_deleted`（`risk: "irreversible"`、不挂 undo，确认靠前端的两次点击；`evidence` 存整条功能和历史，要找回能从账里看到）

- [ ] **Step 1: 写失败测试**

```ts
// knowledge.test.ts —— 用 hono app.request
it("GET 返回功能和历史，按 updatedAt 倒序", async () => { /* 两条功能，断言顺序与 history 字段 */ });
it("GET 注册表里没有的项目 404", async () => { /* … */ });
it("DELETE 删掉并重渲染文件、记一条账", async () => { /* 断言 listFeatures 为空、readKnowledge 不含名字、账里有 feature_deleted */ });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @friday/core exec vitest run src/api/knowledge.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现接口与前端**

前端：`Overview` 里加 `<KnowledgeSection name={o.name} />`，自己拉 `GET /projects/:name/knowledge`。
- 头部一行：「知识库 · N 个功能」；未冷启动显示按钮「建知识库」，已冷启动显示「重扫 · 上次 <相对时间>」，`bootstrapping` 时按钮换成转圈「正在扫…」并每 10 秒重拉一次直到结束。
- 列表一行一条：名字 · 在哪 · 目录（等宽、超长省略）· 「动过 N 次」；点行展开看别名、路由、负责人、说明、历史（时间 + what，有 taskId 的可点跳任务，复用 `onOpenTask`）。
- 每行 hover 出删除，第二次点才删、3 秒不点自动撤回（同定时任务弹窗的删除交互）。
- 空态：「还没有知识库。点「建知识库」让 Friday 扫一遍这个仓库，之后每条任务收工时它会自己补。」
- 样式只用现有 token（`--t-*`、`--s-*`、`--fg-*`、`--line-*`），不引新颜色。

- [ ] **Step 4: 跑测试与类型检查**

Run: `pnpm --filter @friday/core exec vitest run src/api/knowledge.test.ts && pnpm typecheck`
Expected: PASS。

- [ ] **Step 5: 浏览器里走一遍**

按 CLAUDE.md「验收方式」：core `FRIDAY_PORT=7791 FRIDAY_DATA_DIR=<临时目录> FRIDAY_NO_SCHEDULER=1 FRIDAY_TMUX_SOCKET=friday-verify FRIDAY_CLAUDE_BIN=<假脚本>` 起，临时目录写一份 `projects.md` 指向一个有 `src/` 的临时仓库，用一次性脚本 `createFeature` 塞三条（一条带历史）；`VITE_FRIDAY_PORT=7791 vite --port 1421`，agent-browser 打开项目页截图：空态、有数据、展开一行、删一条（两次点击）。点「建知识库」确认按钮进入「正在扫…」（假 claude 不回报，手动 `POST /jobs/:id/exit` 后回到「重扫」）。只 `kill` 自己用 `$!` 记下的 PID，前后各看一次 `lsof -nP 2>/dev/null | grep -c /dev/ptmx`。截图存 scratchpad，结果写进最终汇报。

- [ ] **Step 6: 提交**

```bash
git add apps/core/src/api/knowledge.ts apps/core/src/api/knowledge.test.ts apps/core/src/api/index.ts apps/desktop/src/views/Projects.tsx apps/desktop/src/styles.css
git commit -m "项目页加「知识库」：列功能、展开看历史、建知识库 / 重扫、逐条删"
```

---

### Task 6: 文档

**Files:**
- Modify: `CLAUDE.md`（「从 Claude Code 历史学」一节之前加「知识库（2026-10-21）」一节）
- Modify: `memory-schema/README.md`（目录树加 `knowledge/`）

- [ ] **Step 1: 写 CLAUDE.md 一节**

按现有各节的写法（起因一句 → 要点列表），覆盖：两层（项目级键在 `projects.md`，功能级在表里）、`knowledge/<项目>.md` 是生成物、收工写入的触发条件与校验（5 条、`match` 在候选里、路径要存在、不 await）、冷启动（锚点卡 `kind: project`、`friday_knowledge` 只对冷启动 job 列出、opus、直接入库、水位键）、注入点（`autonomousPrompt`、`contextFor`；交互终端靠 `friday_context`）、撤销只回这次动过的、项目页入口、本块没做的（缺陷归属、理解卡等见设计稿）。

- [ ] **Step 2: 跑全量检查**

Run: `pnpm typecheck && pnpm test`
Expected: 全部通过。

- [ ] **Step 3: 提交**

```bash
git add CLAUDE.md memory-schema/README.md
git commit -m "文档：知识库一节"
```
