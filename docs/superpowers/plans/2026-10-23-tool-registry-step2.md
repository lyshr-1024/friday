# 外部工具注册处 · 第二步（迁数据）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Friday 的数据模型不再认识具体来源：任务的来源字段统一成通用的 `external` 引用，`TaskKind` / `LinkKind` / 待审动作 / 结果账本里的 `meegle` / `slack` 取值换成中性名，老数据一次迁移、读取时兜底。

**Architecture:** 先加新类型和一个纯函数 `normalizeSource`（老形状 → 新形状），在任务读取的唯一入口 `toTask` 上永久调用它，保证任何时候读到的都是新形状（含 `restore_task` 撤销回来的老快照）。迁移期间写入方经 `legacyMirror` 同时写新老两套键，让还没切换的模块读到一致的值；各模块逐个切到新字段后，跑一次带备份、带核对的库迁移，最后删掉老键、老类型和镜像。

**Tech Stack:** TypeScript、`node:sqlite`（`VACUUM INTO` 备份）、hono、vitest、React。

**Spec:** `docs/superpowers/specs/2026-10-23-tool-registry-design.md` 第 4.8 节（第一步已合进 main `37ddc2f`，计划在 worktree `../friday-feat-external-refs`、分支 `feat/external-refs` 上做）。

## Global Constraints

- 设计稿 4.8 原文：`TaskSource` 的来源字段收成 `external?: ExternalRef`；**业务代码只读核心字段**，只有工具自己认识的值进 `attrs` 由工具解释；Friday 自己的语义（合并、容器、外部已关）改中性名留在 `TaskSource`；`TaskKind` 的 `slack` / `meegle` → `conversation` / `work_item`；`TaskCategory` 的 `slack` → `conversation`；`links` 的 `meegle` / `slack` / `thread` / `channel` → `ext`，`ref = <工具>:<类型>:<id>`；迁移一次性、带版本标记、整体在事务里、迁移前 `VACUUM INTO` 备份（**不许 `cp` 库文件**，WAL 未落盘会误判）、迁移后核对条数、重复执行是 no-op；先在真实库副本上跑。
- **不改的（计划裁定）**：会话工具名（`meegle_add` / `meegle_sync` / `slack_sync` / `slack_inbox`）、HTTP 路由路径（`/tasks/sync-meegle`、`/slack/:conv/*`、`/inbox/*`）、HUD 动作名（`slack_query` 等）、界面上给人看的文字「Meegle」「Slack」、注册处里的工具名、`settings.roles` 的值、审计表里已有的历史行（只读的账，不改写）、`todos` 表、`connectors/<tool>/` 目录内部。这些是「工具的名字」或对外接口，不是 Friday 的数据模型。
- 审计 `undo` 里的 `meegle_state` / `meegle_node` / `delete_slack_message` / `tool_undo` 种类保留（它们是工具的撤销说明，由工具解释）。
- 第一步的保证全部不退：同步行为、发送 / 撤回记账、待审 `tool_call` 生命周期、守卫与 strict-mcp。现有测试的**断言**只允许改字段名，不许改期望行为。
- 基线类型检查有 10 个既有 TS2741（测试夹具缺 `Project.protected`），门槛是不新增；`src/api/ask.queue.test.ts` 偶发失败、`agent/terminal.test.ts` 偶发超时，与本计划无关。
- 中文提交，每任务至少一提交，结尾 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`；不覆盖 git author；只 kill 自己 `$!` 的 PID。

## 映射表（所有任务以此为准）

`ExternalRef`（`packages/shared`）：

```ts
export interface ExternalRef {
  tool: string;                         // 注册处里的工具名：meegle / slack
  type: "work_item" | "conversation";
  id: string;                           // 工单号 / 对话键 channelId:ts
  kind?: "story" | "defect" | "other";  // 只有 work_item
  state?: { key: string };
  parent?: { id: string; name?: string };
  schedule?: { frontend?: string; backend?: string };
  tags?: string[];
  author?: string;
  attrs?: Record<string, string>;       // 只有工具解释
}
```

| 老字段（`TaskSource`） | 新位置 |
|---|---|
| `meegleId` | `external = { tool: "meegle", type: "work_item", id }` |
| `meegleType` | `external.kind`（`story`→story，`issue`/`defect`/`bug`→defect，其余 other）＋ `external.attrs.typeKey`（原值） |
| `statusKey` | `external.state.key` |
| `meegleProject` | `external.attrs.space` |
| `linkedStoryId` / `linkedStoryName` | `external.parent = { id, name }` |
| `meegleTags` | `external.tags` |
| `feDue` / `beDue` | `external.schedule = { frontend, backend }` |
| `nodeKey` / `nodeName` | `external.attrs.nodeKey` / `nodeName` |
| `reporter` | `external.attrs.reporter` |
| `mergedMeegleIds` | `mergedIds` |
| `merged[].meegleId` | `merged[].id` |
| `storyContainer` | `container` |
| `meegleClosed` | `closedExternally` |
| `conversation` | `external = { tool: "slack", type: "conversation", id }` |
| `channelId` / `threadTs` | `external.attrs.channelId` / `threadTs` |
| `userName` | `external.author` |
| `threadId`（老库遗留，代码已不写） | `external = { tool: "slack", type: "conversation", id: threadId, attrs: { legacy: "thread" } }` |
| `url`、`description`、`docs`、`removedDocs`、`autoClosed`、`headless`、`fromTaskId` 等 | 不动（不是来源专属） |
| `TaskDoc.from: "meegle"` | `"sync"` |
| `BriefDep.evidence.source: "meegle" / "slack"` | `"work_item"` / `"conversation"` |

其它取值：`TaskKind` `meegle`→`work_item`、`slack`→`conversation`；`TaskCategory` `slack`→`conversation`（判据改为 `external?.type === "conversation" || fromTaskId`）；`PendingActionType` `slack_reply`→`chat_reply`（payload `{ channel, threadTs, userName, text }` → `{ to: ExternalRef, text }`），`meegle_update`（代码里已无引用）→ `custom`；`RunTrigger` `slack`→`chat`；`LinkKind` 去掉 `meegle` / `slack` / `thread` / `channel`，加 `ext`，ref：`meegle:work_item:<id>`、`slack:conversation:<键>`、`slack:channel:<频道名>`、`slack:thread:<id>`；`isQueryTask(s)` = `Boolean(s.headless && s.external?.type === "conversation")`。

一处同一个任务同时有工单号和对话键的情况（老数据里理论上可能）：工单优先进 `external`，对话键转成一条 `task ↔ ext:slack:conversation:<键>` 的 `rule` 边，不丢。

## Review Focus

1. **撤销一条迁移前的「删除任务」**：`restore_task` 的快照是老形状，恢复后任务必须以新形状出现、Meegle 同步还能认领它（不重复建卡）。→ Task 1 测试（`toTask` 兜底）＋ Task 6 测试（恢复后同步不重复）。
2. **关联边改名后方向翻转、撞重复**：`thread` / `meegle` 等改成 `ext` 后，`order()` 的字符串比较会让部分边两端对调，与已有边撞唯一索引；必须按 `user > rule > guess` 保留最强的一条，否决边（`!` 前缀）保持否决。→ Task 5 测试。
3. **迁移中途出错 / core 在迁移时被杀**：事务回滚、版本标记不写、下次启动重试；读取端靠 `toTask` 兜底，界面照常。→ Task 6 测试（注入一行坏 JSON 让迁移抛错，断言库不变、标记不在、`listTasks` 仍返回新形状）。
4. **老的待审 Slack 回复（`slack_reply`）在升级后被批准**：必须能照常发出、记账字段不变。→ Task 3 测试（库里放一条老 payload 的 `slack_reply`，迁移后批准，断言调用了 post 且账里 `channel` / `ts` 正确）。
5. **前端拿到混合形状**：迁移完成前后，前端都只认新字段；`GET /tasks` 对一条只有老键的行返回新形状。→ Task 1 测试（API 层）。

---

### Task 1: 新类型、`normalizeSource`、读取兜底与双写镜像

**Files:**
- Modify: `packages/shared/src/index.ts`（加 `ExternalRef`、`TaskSource` 新字段、新枚举值；老字段与老枚举值**暂留**并标 `/** @deprecated 第二步迁移中 */`；`isQueryTask` / `taskCategory` / `briefRefusal` 改读新字段并兼容老字段；导出访问器）
- Create: `apps/core/src/memory/externalRef.ts`
- Modify: `apps/core/src/memory/tasks.ts`（`toTask` 调 `normalizeSource`；`createTask` / `updateTask` 写入前过 `legacyMirror`）
- Test: `apps/core/src/memory/externalRef.test.ts`、`apps/core/src/api/tasks.test.ts`（补一条）

**Interfaces:**
- Produces（shared）：`ExternalRef`；`workItemOf(s: TaskSource): ExternalRef | undefined`（`external?.type === "work_item"`）；`conversationOf(s: TaskSource): ExternalRef | undefined`；`TaskKind` 增 `work_item` / `conversation`；`TaskCategory` 增 `conversation`；`TaskDoc.from` 增 `sync`；`PendingActionType` 增 `chat_reply`；`RunTrigger` 增 `chat`；`LinkKind` 增 `ext`。
- Produces（core `memory/externalRef.ts`）：
  - `normalizeSource(raw: Record<string, unknown>): TaskSource` —— 按映射表从老键补出新键；已有新键时以新键为准；**本任务里保留老键**（Task 8 改为剥掉）；纯函数、幂等。
  - `legacyMirror(s: TaskSource): TaskSource` —— 从新键反写老键（Task 8 删除）。
  - `extraConversationOf(raw: Record<string, unknown>): string | undefined` —— 老行同时带工单号和对话键时返回对话键，供 Task 6 建边。
  - `stripLegacy(s: TaskSource): TaskSource` —— 删掉映射表左列的全部老键（Task 6 写库时用，Task 8 并进 `normalizeSource`）。
  - `migrateKind(kind: string): TaskKind`、`migratePending(p: PendingAction[]): PendingAction[]`、`migrateTrigger(t: string): RunTrigger`、`migrateDocFrom`（嵌在 `normalizeSource` 里处理 `docs` 与 `merged[].docs`）。
- [ ] **Step 1: 写失败测试** `externalRef.test.ts`：表驱动，一条老 Meegle 缺陷（含映射表 Meegle 侧所有字段）→ 断言 `external` 各字段、`mergedIds`、`merged[0].id`、`container`、`closedExternally`、`docs[0].from === "sync"`、`brief.deps[0].evidence.source === "work_item"`；一条老 Slack 查询任务（`conversation`、`channelId`、`threadTs`、`userName`、`headless`）→ `external.type === "conversation"`、`attrs.channelId`、`author`；一条只有 `threadId` 的 → `attrs.legacy === "thread"`；同时有工单号和对话键 → `external.tool === "meegle"`，且 `extraConversationOf(raw)` 返回该对话键（只有工单号或只有对话键时返回 `undefined`）；`normalizeSource(normalizeSource(x))` 深相等于 `normalizeSource(x)`；`legacyMirror(normalizeSource(x))` 的老键与 `x` 一致。`migratePending`：`slack_reply` 老 payload → `chat_reply` 且 `payload.to.attrs.channelId`；`meegle_update` → `custom`。
- [ ] **Step 2: 写失败测试**（`api/tasks.test.ts`）：直接用 SQL 插一行只有老键的任务，`GET /tasks` 返回的该任务带 `source.external.id`、`kind === "work_item"`（Review Focus 5）。
- [ ] **Step 3: 跑测试确认失败。**
- [ ] **Step 4: 实现。** `toTask` 里 `kind` 也过 `migrateKind`、`pending` 过 `migratePending`。
- [ ] **Step 5: 全量测试与类型检查通过**（老字段都还在，现有代码不受影响）。
- [ ] **Step 6: 提交** `外部引用：新类型、读取兜底与双写镜像`

### Task 2: 工单侧切到新字段

**Files:**
- Rename: `apps/core/src/agent/meegle.ts` → `apps/core/src/agent/workItems.ts`（导出名中性化：`syncMeegleOnce`→`syncWorkItemsOnce`、`meegleState`→`workItemSyncState`、`addMeegleByRef`→`addWorkItemByRef`、`ensureStoryContainers`→`ensureContainers`；会话工具名与 HTTP 路由不变，只改内部调用）；测试文件同步改名
- Modify: `apps/core/src/connectors/roles.ts`（`WorkItemsRole` 的 `ref: WorkItemRef` 参数全部换成 `ExternalRef`；新增 `external(item: WorkItem): ExternalRef`；`WorkItemRef` 只在 `connectors/meegle/` 内部使用）
- Modify: `apps/core/src/connectors/meegle/{index,client,rules}.ts`（工具自己把 `ExternalRef.attrs.space` / `nodeKey` 等翻译成 CLI 参数；`external()` 组出映射表里的形状；`TaskDoc.from` 写 `"sync"`）
- Modify 读写方：`agent/{autostart,brief,briefJob,bridge,pipeline,reproject,sessions,taskUpdate,runner,noteTask}.ts`、`agent/summon/{match,card,slack}.ts`、`agent/slack/attach.ts`、`agent/weekly/collect.ts`、`memory/{infer,search,db,noteTask}.ts`、`api/{tasks,summon,links}.ts`、`scheduler/index.ts`（只改它们读写的工单字段，见盘点：`meegleId`、`mergedMeegleIds`、`merged`、`meegleType`、`linkedStory*`、`storyContainer`、`autoClosed`、`meegleClosed`、`meegleProject`、`statusKey`、`meegleTags`、`feDue`/`beDue`、`nodeKey`/`nodeName`、`reporter`）
- Test: 现有 `agent/meegle.test.ts`（改名后）等只改字段名

**Interfaces:**
- Consumes: Task 1 的 `workItemOf`、`ExternalRef`、`legacyMirror`（`createTask` / `updateTask` 已自动镜像，调用方不用管）。
- Produces: `WorkItemsRole` 新签名，如 `transitions(ext: ExternalRef)`、`transition(ext: ExternalRef, to: StateTransition, caller: Caller)`、`confirmNode(ext: ExternalRef, caller: Caller)`（`nodeKey` 由工具从 `ext.attrs` 取）、`external(item: WorkItem): ExternalRef`；业务侧读 `workItemOf(t.source)?.kind` 判缺陷，不再读 `meegleType`。

- [ ] **Step 1: 改 `agent/workItems.test.ts`（原 `meegle.test.ts`）里构造任务与断言的字段名**为新字段，断言的期望行为一条不改；跑测试确认失败（字段尚未切换）。
- [ ] **Step 2: 实现切换。** 业务代码不许出现 `attrs.` 访问（那是工具的事），用 `grep -rn "\.attrs\b" apps/core/src --include='*.ts' | grep -v connectors/` 自查为空。
- [ ] **Step 3: 全量测试与类型检查通过。**
- [ ] **Step 4: 自查 grep** `grep -rnE "\.(meegleId|mergedMeegleIds|meegleType|linkedStoryId|linkedStoryName|storyContainer|meegleClosed|meegleProject|statusKey|meegleTags|feDue|beDue|nodeKey|nodeName|reporter)\b" apps/core/src --include='*.ts' | grep -v '\.test\.ts' | grep -v 'memory/externalRef.ts' | grep -v 'connectors/meegle/'` → 无输出。
- [ ] **Step 5: 提交** `外部引用：工单侧读写改用 external`

### Task 3: 对话侧切到新字段

**Files:**
- Rename: `apps/core/src/agent/slack/` → `apps/core/src/agent/chat/`（`attach.ts`、`query.ts`、`queryJob.ts`、`settle.ts`、`channelMatch.ts` 及测试；导出名不含 slack 的保持，含 slack 的中性化）
- Modify: `apps/core/src/connectors/roles.ts`（`ChatRole` 增 `external(item: InboxItem): ExternalRef`；`post(args: { to: ExternalRef; text: string }, caller)`，工具从 `to.attrs` 取 `channelId` / `threadTs`）、`connectors/slack/index.ts`
- Modify: `agent/pipeline.ts`（`chat_reply` 待审：建、改、执行；`slack_reply` 只在 `migratePending` 里出现）、`agent/taskUpdate.ts`、`agent/bridge.ts`、`agent/briefJob.ts`、`agent/notices.ts`、`agent/summon/{slack,match,index}.ts`、`agent/tools.ts`、`api/{slack,summon,tasks}.ts`、`memory/{infer,db}.ts`（`db.ts:136-138` 的 `pending LIKE '%"slack_reply"%'` 同时认两个值）、`agent/chat/queryJob.ts`（建任务 `kind: "conversation"`、`external` 由 `role("chat").external(item)` 给；`createRun` trigger `chat`）
- Modify: `agent/summon/slack.ts:102` 手拼的对话键改用 `conversationKey(...)`（盘点发现的重复公式）
- Test: 相关测试只改字段名；新增 Review Focus 4 的测试

**Interfaces:**
- Consumes: Task 1 的 `conversationOf`、`isQueryTask`（新判据）。
- Produces: `chat_reply` 的 payload 形状 `{ to: ExternalRef; text: string }`；`ChatRole.external`、`ChatRole.post` 新签名。

- [ ] **Step 1: 写失败测试**（Review Focus 4）：库里插一条带老 `slack_reply` 待审（payload `{ channel: "C1", text: "x", threadTs: "1.2", userName: "a" }`）的任务，批准（`executePending`），mock slack client 的 `postMessage`：被以 `("C1", "x", "1.2")` 调用；最新账 `action === "slack_reply_sent"`、`evidence.channel === "C1"`。
- [ ] **Step 2: 改现有测试字段名**，跑确认失败。
- [ ] **Step 3: 实现切换。**
- [ ] **Step 4: 全量测试与类型检查通过；自查 grep** `grep -rnE "source\.(conversation|channelId|threadTs|userName|threadId)\b|\"slack_reply\"|kind: \"slack\"" apps/core/src --include='*.ts' | grep -v '\.test\.ts' | grep -v 'memory/externalRef.ts' | grep -v 'connectors/slack/'` → 只剩 `memory/db.ts` 那条兼容 SQL（写明）。
- [ ] **Step 5: 提交** `外部引用：对话侧读写改用 external，待审回复改名 chat_reply`

### Task 4: 前端与共享判断切到新字段

**Files:**
- Modify: `apps/desktop/src/views/{Board,TaskDialog,TaskHeader,Search,Resources,Hud,Related,Needs}.tsx`、`apps/desktop/src/lib/core.ts`（按盘点：`meegleId` 13 处、`linkedStoryId` 8、`feDue` 10、`beDue` 6、`mergedMeegleIds` 3、`merged` 2、`statusKey` 2、`nodeKey` / `nodeName` 2、`meegleTags`、`url`、`docs`、`t.kind === "slack" / "meegle"`、`TaskCategory "slack"`、`QUEUE_GROUPS`、`consequence()` 里的 `slack_reply`、按 `action` 名匹配账的地方不动）
- Modify: `packages/shared/src/index.ts` 里 `taskCategory`、`briefRefusal`、`TASK_CATEGORY_LABEL`（`conversation: "Slack"`——界面文字保留「Slack」）
- Modify: `apps/core/src/memory/search.ts`（`category`）

**Interfaces:**
- Consumes: shared 的 `workItemOf` / `conversationOf`；前端只读新字段。
- Produces: 无新接口。

- [ ] **Step 1:** `pnpm -r typecheck` 作为红灯：先在 shared 里把老字段的 `@deprecated` 改成**从 `TaskSource` 的前端可见类型里拿掉**（用一个 `type ClientTaskSource = Omit<TaskSource, 老键…>` 给 `Task.source`），让前端所有老字段访问变成类型错误；记录错误数。
- [ ] **Step 2:** 逐个改到类型检查只剩 10 个基线错误。
- [ ] **Step 3: 浏览器验证**（CLAUDE.md「验收方式」：`FRIDAY_PORT=7791 FRIDAY_DATA_DIR=<临时> FRIDAY_NO_SCHEDULER=1` + `VITE_FRIDAY_PORT=7791`，agent-browser `--profile <临时目录>`，只 kill 自己的 PID，ptmx 前后各看一次）：用一次性脚本造 1 条 Meegle 缺陷（挂需求、有排期、有标签）、1 条 Slack 查询任务、1 条带老键的任务（SQL 直插），截图任务列表分组、缺陷详情（关联需求、排期、标签、来源链接）、查询任务详情；三张图存 scratchpad 并在报告里列路径。
- [ ] **Step 4: 提交** `外部引用：前端与共享判断改用 external`

### Task 5: 关联边改成 `ext`

**Files:**
- Modify: `apps/core/src/memory/infer.ts`（`meegleNode` / `slackNode` / `threadNode` / `channelNode` 换成 `extNode(tool: string, type: string, id: string): LinkNode`，`kind: "ext"`、`ref: \`${tool}:${type}:${id}\``；频道名照旧剥 `#`）、`memory/links.ts`、`memory/schema.ts`（`links` 的 CHECK 改成 `('task','ext','branch','url','project')`）、`memory/db.ts`（新增链表重建迁移）、调用方（盘点第 3 节：`agent/chat/attach.ts`、`queryJob.ts`、`summon/slack.ts`、`api/slack.ts`、`api/summon.ts`、`agent/briefJob.ts`、`api/tasks.ts`、`api/links.ts` 的 `KINDS`）
- Test: `apps/core/src/memory/links.test.ts`、`apps/core/src/memory/db.test.ts`

**Interfaces:**
- Produces: `extNode(tool, type, id)`；`migrateLinks(d: DatabaseSync): { kept: number; merged: number }`（在 `migrate()` 里调）。

**迁移规则：** 检测：`sqlite_master` 里 `links` 的建表语句还含 `'meegle'`。在 `BEGIN`/`COMMIT` 里：`links` 改名 `links_old` → 跑 `SCHEMA` 建新表 → 逐行把老端点换成 `ext`（`meegle`→`meegle:work_item:`、`slack`→`slack:conversation:`、`channel`→`slack:channel:`、`thread`→`slack:thread:`；否决边保留 `!` 前缀放在最前：`!meegle:work_item:123`）→ 两端按 `links.ts` 的 `order()` 重新排序 → 插入时撞唯一索引则保留 `source` 更强的一行（`user > rule > guess`，同级保留 `updated_at` 新的）→ 删 `links_old`；出错 `ROLLBACK`。`order()` 和 `veto()` 从 `links.ts` 导出给迁移复用，不许复制。

- [ ] **Step 1: 写失败测试**（Review Focus 2）：在旧建表语句的库里插入：一条 `task ↔ thread`（`thread` > `task`，迁移后方向翻转）、一条 `task ↔ meegle`（rule）和一条会映射到同一 `ext` 端点的 `user` 边、一条否决边 `task ↔ !slack:...`；跑 `migrate()` 后断言：边数 = 去重后的数、保留的是 `user`、否决边仍挡住 `linkUp` 重连、`neighbors(extNode("meegle","work_item","123"), "task")` 能找到任务；再跑一次 `migrate()` 无变化。
- [ ] **Step 2: 改现有 links / attach 测试的节点构造**，跑确认失败。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 全量测试与类型检查通过。**
- [ ] **Step 5: 提交** `外部引用：关联边统一成 ext`

### Task 6: 库迁移（任务、待审、结果账本）、备份与核对

**Files:**
- Create: `apps/core/src/memory/migrateExternal.ts`
- Modify: `apps/core/src/memory/db.ts`（`migrate()` 末尾调用）、`apps/core/src/memory/tasks.ts`（`restoreTask` 写入前过 `normalizeSource` / `migrateKind` / `migratePending`）
- Create: `apps/core/scripts/migrate-dry-run.ts`（一次性核对脚本，见 Step 5）
- Test: `apps/core/src/memory/migrateExternal.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `normalizeSource` / `migrateKind` / `migratePending` / `migrateTrigger`；Task 5 的 `extNode`、`linkUp`。
- Produces:
  - `backupDb(d: DatabaseSync, dir: string): string` —— `VACUUM INTO '<dir>/backups/todos-<YYYYMMDD-HHmmss>.db'`，返回路径；目录不存在就建。
  - `migrateExternalRefs(d: DatabaseSync): { tasks: number; runs: number; extraLinks: number } | undefined` —— 已有标记 `sync_state` 的 `migration:external-refs` 时返回 `undefined`。

**规则：** 先 `backupDb`；`BEGIN`；逐行 `tasks`：`source = stripLegacy(normalizeSource(source))`、`kind = migrateKind(kind)`、`pending = migratePending(pending)`；`extraConversationOf(老 source)` 有值的建一条 `rule` 边（`why: "迁移：任务同时带工单号和对话键"`）；`runs.trigger`：`UPDATE runs SET trigger = 'chat' WHERE trigger = 'slack'`；核对：迁移前后 `tasks` 行数相等、`runs` 行数相等、每行 `source` 都能 `JSON.parse` 且不含任何老键；不一致就 `ROLLBACK` 并抛错（`migrate()` 捕获、打日志、**不写标记**，启动继续——读取端有 `toTask` 兜底）；一致就写标记 `migration:external-refs`（值为备份路径）后 `COMMIT`。审计表不动。

- [ ] **Step 1: 写失败测试**：
  - 正常路径：库里放老形状的 Meegle 任务、Slack 查询任务、带 `slack_reply` 待审的任务、`trigger = 'slack'` 的 run → 迁移后各行新形状、无老键、标记存在、备份文件存在且能打开、再跑一次返回 `undefined`。
  - Review Focus 3：插一行 `source` 为坏 JSON → 迁移抛错被 `migrate()` 捕获；库里其它行**仍是老形状**（回滚）、标记不存在、`listTasks()` 对好行仍返回新形状。
  - Review Focus 1：删一条迁移后的任务拿到 `restore_task` 快照，再把快照里的 `source` 换成老形状 JSON，`restoreTask` 后 `getTask` 是新形状；随后用假 `workItems` 角色跑一轮同步，返回同一工单时**不新建任务**。
- [ ] **Step 2: 跑测试确认失败 → 实现 → 通过**；全量与类型检查。
- [ ] **Step 3: 提交** `外部引用：库迁移带备份与核对，撤销恢复也走新形状`
- [ ] **Step 4: 写** `apps/core/scripts/migrate-dry-run.ts`：参数是源库路径；用 `VACUUM INTO` 拷到临时目录（**不碰源库**），对副本跑 `migrate()`，打印：迁移前后各表行数、老键残留数（应为 0）、额外建的边数、随机 20 条任务的 `id · kind · external.tool/type/id · title`。
- [ ] **Step 5: 真实库副本验证**：`tsx apps/core/scripts/migrate-dry-run.ts "$HOME/Library/Application Support/Friday/todos.db"`，输出贴进报告；有任何残留或行数不符就停下报告（这是计划里唯一读取真实用户数据的地方，只读、拷贝在临时目录）。
- [ ] **Step 6: 提交** `外部引用：迁移演练脚本`

### Task 7: 收件表通用化（可选，见交付说明）

**Files:**
- Modify: `apps/core/src/memory/schema.ts`（`inbox` 加 `tool TEXT NOT NULL DEFAULT 'slack'`、`attrs TEXT`）、`memory/db.ts`（`ALTER` 两列；`channel_name` / `thread_ts` 的值拷进 `attrs`；**老列保留不删**，避免重建一张 13 列的表，下一个版本再删）、`memory/inbox.ts`、`packages/shared` 的 `InboxItem`（`channelId` / `channelName` / `threadTs` 改为从 `attrs` 读，类型上保留为工具填的可选字段 → 本任务把 `InboxItem` 拆成通用部分 `{ id, tool, kind, author, authorId, text, permalink, ts, receivedAt, done, prior?, attrs }`，`channelId` 等只在 `connectors/slack/` 与 `agent/chat/` 内经 `role("chat")` 的访问器读）
- Test: 现有 inbox / chat 测试改字段名

- [ ] **Step 1–4:** 同前面的节奏（改测试 → 红 → 实现 → 全量绿 → 提交 `外部引用：收件表通用化`）。

### Task 8: 删掉老键、老类型与镜像，验收与文档

**Files:**
- Modify: `packages/shared/src/index.ts`（删所有 `@deprecated` 老字段与老枚举值 `meegle` / `slack` / `thread` / `channel` / `slack_reply` / `meegle_update`；`ClientTaskSource` 去掉，`Task.source` 直接用 `TaskSource`）、`apps/core/src/memory/externalRef.ts`（删 `legacyMirror`；`normalizeSource` 改为补出新键后**剥掉老键**——即与 `stripLegacy` 合一；`toTask` 照旧调用，作为永久兜底）、`apps/core/src/memory/tasks.ts`（去掉镜像）
- Modify: `CLAUDE.md`（「外部工具注册处」一节补第二步：映射表摘要、`ext` 边、读取兜底、迁移标记与备份位置、演练脚本用法；各节里的 `source.meegleId` 等字段名改成新名字）
- [ ] **Step 1:** `pnpm -r typecheck` 改到只剩 10 个基线错误；全量测试通过。
- [ ] **Step 2: 验收 grep**：
  ```bash
  grep -rnE "\b(meegleId|mergedMeegleIds|meegleType|linkedStoryId|linkedStoryName|storyContainer|meegleClosed|meegleProject|statusKey|meegleTags|feDue|beDue|threadId)\b" packages apps --include='*.ts' --include='*.tsx' | grep -v node_modules | grep -v '\.test\.ts' | grep -v 'connectors/meegle/' | grep -v 'memory/externalRef.ts'
  grep -nE "\"(meegle|slack|thread|channel|slack_reply|meegle_update)\"" packages/shared/src/index.ts
  ```
  第一条无输出；第二条只允许界面标签值（如 `TASK_CATEGORY_LABEL` 里的 `"Slack"` 文案不在此列——它是大写，不命中）和 `DEFAULT_SKILL_LIST` 里的 skill 名 `"meegle"`，逐条写明。
- [ ] **Step 3: 真机验证**（同第一步的隔离规程，假 `meegle`）：起 core，库里先放 Task 6 测试里那套老形状数据 → 启动后标记存在、备份文件存在；跑一轮 `syncWorkItemsOnce`（假 `meegle` 返回其中一条老任务对应的工单）→ 不新建卡、状态更新正确；`GET /tasks` 无老键。
- [ ] **Step 4: 提交** `外部引用：删掉老字段与镜像，文档`

---

## 自查记录

- 设计稿 4.8 覆盖：`external` 与 `attrs`、Friday 语义改中性名 → T1 映射表、T2/T3；`TaskKind` / `TaskCategory` → T1、T2、T3、T4；`links` → T5；`inbox` → T7；前端与 shared → T4；迁移规程（一次性、版本标记、事务、`VACUUM INTO`、条数核对、副本先跑、幂等）→ T6；验收（副本上条数一致、抽 20 条、再跑 no-op、同步不重复不误收、grep）→ T6 Step 5、T8。
- 设计稿没覆盖、计划补的：读取兜底（`toTask` 永久 `normalizeSource`）、迁移期双写镜像、`restore_task` 老快照、老待审 `slack_reply`、关联边方向翻转与去重、同时带工单号和对话键的任务、`summon/slack.ts` 手拼对话键。
- 不改的对外名字列在 Global Constraints，避免实现者把会话工具名、路由、界面文字一起改掉。
