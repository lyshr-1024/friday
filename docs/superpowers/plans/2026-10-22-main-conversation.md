# 主对话 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 只有一段主对话：你在这里说话，Friday 按任务板和知识库判断你说的是哪条任务、替你转给对应的卡或终端；需要你的事（方案待审 / 待验收 / 卡住）由 Friday 主动在这里说，离开回来给一条汇总；任务卡上不再有会话框。

**Architecture:** core 新增「主对话」这一段固定会话（id 存 `sync_state`），会话工具全部改成带 `taskId`、不再按会话绑任务；每轮系统提示注入整块任务板；一个挂在事件总线上的 watcher 在任务进入「要你」状态时往主对话写模板消息；消息带 `taskIds`，任务详情据此列「相关对话」。前端会话视图换成主对话 +「等你」栏，任务详情去掉输入框。

**Tech Stack:** TypeScript、hono、vitest、`node:sqlite`、React。

**Spec:** `docs/superpowers/specs/2026-10-22-one-conversation-dispatch-design.md` 第二块「主对话」。第一块已在 main（`33af6e7`）。

## Global Constraints

- 主动消息和回来汇总**模板拼，不调模型**。
- 主动开口只有三类：方案待审、待验收、卡住（含「要你定」的几种：项目归属反问、`reproject`、`discard_changes`、`start_job`、终端在问你）。「干活中」「这轮说了什么」不往主对话写。
- 每次转达或改卡，主对话里必须留一行 `→ #N 标题：做了什么`（由工具层写，不靠模型自觉）。
- 对不上或两条都像就反问，不猜。
- 不动：HUD（`api/summon.ts` 的 `hudConversation` 照旧给任务建 HUD 用的会话）、定时任务 friday 执行方的会话、后台只读 `claude -p`。
- 老任务的会话数据留在库里不删，「相关对话」里一并列出。
- 测试：`pnpm --filter @friday/core test -- <文件>`；每个任务提交前跑 `pnpm test` 和 `pnpm typecheck`（main 上有 10 个旧的 `Project.protected` 测试夹具错误，不许新增）。
- 提交信息中文，结尾 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。
- 验证时只 `kill` 自己 `$!` 记下的 PID，tmux 用 `FRIDAY_TMUX_SOCKET=friday-verify`。

## 计划的决定（设计稿没写死的）

- 短号 `#N`：`tasks.seq`，迁移按 `created_at` 回填，新任务取 `max+1`。
- 主对话 Claude session 轮换：上海时区换日，或自上次轮换起用户发了 40 句。
- 「要你」状态在 core 算（`agent/needs.ts` 的 `needOf`），`GET /tasks` 每条带 `need`，前端不重复判断。
- 主动消息靠 watcher 统一发：订阅总线 `tasks` 事件、500ms 合并一次，扫开着的任务，`needOf` 的 `key` 跟上次发过的（`sync_state` 的 `notice:<taskId>`）不同才发。第一次启动（没有 `notice:init`）只记 key 不发，免得升级时把积压的全刷一遍。
- 「离开」靠前端在窗口失焦 / 聚焦时 `POST /main/presence`。
- 排队在 core 内存里，`/ask` 碰上生成中返回 202 + 排队 id；重启丢掉排队（同生成中的回答一样）。
- `task_approve` 的「点名」：用户整句是「`#N` + 同意词」或只有同意词；只有同意词、而同时有不止一条任务挂着可在会话里批准的动作时，拒绝并要求点名。
- 依赖「等你确认到了」不发主动消息（依赖多半在等别人，不是在等你）。
- 生成中到的主动消息直接写库，按写入时间排在这一轮回答**之前**（回答是收尾时才落库的）。设计稿写的是「插在正在流式输出的那条之后」；为这个改消息排序不值，下一轮的任务板照样带上它。

## Review Focus

1. **主对话被绑到任务上**：任何把主对话 id 写进 `task.source.conversationId` 的路径（`todo_add` / `task_add` 的 `freeConversation`、`run_claude` 的 linked、`/run`）都会让 `findTaskBySource(conversationId)` 把整段主对话认成某条任务的会话。主对话 id 永远不能出现在任何任务的 `source.conversationId` 上（Task 5 测试）。
2. **升级第一次启动**：库里已有几十条 review / blocked 的任务，watcher 不能一口气往主对话里刷几十条（Task 6 测试）。
3. **同一状态反复发**：任务在 review 里被改了 progress、勾了验证点、挂了别的动作，`key` 不变就不能重发；交付了第二轮（`report.at` 变了）要再发（Task 6 测试）。
4. **裸同意词、多条在等**：主对话里说「通过」，同时 #12 挂合并、#15 挂方案，不能随便批一条（Task 3 测试）。
5. **生成中再说话**：排队的消息在当前这轮结束后按顺序跑，撤回的不跑；生成出错 / 被中断后队列照样往下走（Task 8 测试）。

---

### Task 1: 任务短号 `#N` 与引用解析

**Files:**
- Modify: `apps/core/src/memory/db.ts`（`tasks` 补 `seq` 列并回填）、`apps/core/src/memory/tasks.ts`（`createTask` 取号、行映射、`findTaskByRef`）、`packages/shared/src/index.ts`（`Task.seq`）
- Modify: `apps/core/src/agent/tools.ts`（`findTaskById` 换成 `findTaskByRef`，`taskLine` 前缀 `#N`）
- Modify: `apps/desktop/src/views/Board.tsx`（列表行与详情头显示 `#N`）
- Test: `apps/core/src/memory/tasks.test.ts`、`apps/core/src/memory/db.test.ts`

**Interfaces:**
- Produces: `Task.seq: number`；`findTaskByRef(ref: string): Task | undefined`（`#12` / `12` 按 seq；否则完整 id，或 ≥6 位的 id 前缀，唯一命中才返回）；`taskTag(t: Task): string` = `` `#${t.seq} ${t.title.slice(0, 30)}` ``（放 `memory/tasks.ts`）。

- [ ] **Step 1: 写失败测试**

```ts
it("新任务按顺序拿短号，#N / 数字 / id 前缀都能找回", () => {
  const a = createTask({ title: "甲", kind: "verbal", source: {} });
  const b = createTask({ title: "乙", kind: "verbal", source: {} });
  expect(b.seq).toBe(a.seq + 1);
  expect(findTaskByRef(`#${b.seq}`)!.id).toBe(b.id);
  expect(findTaskByRef(String(a.seq))!.id).toBe(a.id);
  expect(findTaskByRef(b.id.slice(0, 8))!.id).toBe(b.id);
  expect(findTaskByRef("#999999")).toBeUndefined();
});
// db.test.ts
it("老库补 seq：按 created_at 回填，从 1 开始不重复", () => { /* 建无 seq 列的旧表插 3 行乱序 created_at，migrate 后 seq = 按时间 1/2/3 */ });
```

- [ ] **Step 2: 跑测试确认失败** — `pnpm --filter @friday/core test -- tasks.test.ts db.test.ts`，Expected: FAIL（`seq` 不存在）
- [ ] **Step 3: 实现**：迁移按现有 `taskCols.includes(...)` 写法补 `seq INTEGER`，回填 `UPDATE tasks SET seq = (SELECT COUNT(*) FROM tasks t2 WHERE t2.created_at < tasks.created_at OR (t2.created_at = tasks.created_at AND t2.rowid <= tasks.rowid)) WHERE seq IS NULL`；`createTask` 在同一条 INSERT 里写 `(SELECT COALESCE(MAX(seq), 0) + 1 FROM tasks)`。前端列表行标题前、详情头标题前加灰色等宽 `#N`。
- [ ] **Step 4: 跑测试确认通过**，同上命令 + `pnpm typecheck`，Expected: PASS、类型错误仍是 10 个
- [ ] **Step 5: 提交** `任务短号 #N：建任务时取号、老库回填，#N / 数字 / id 前缀都能找回任务`

---

### Task 2: 主对话、消息挂任务、Claude session 轮换

**Files:**
- Create: `apps/core/src/memory/mainConversation.ts`
- Modify: `apps/core/src/memory/conversations.ts`（`messages.task_ids`、`addMessage` 的 `taskIds`、`listMessagesForTask`）、`apps/core/src/memory/db.ts`（补列）、`packages/shared/src/index.ts`（`Message.taskIds`、`MessageKind` 加 `"notice"`）
- Modify: `apps/core/src/agent/runs.ts`（`touchTask`，收尾时把本轮碰过的任务记到这一轮的用户消息和回答上）
- Modify: `apps/core/src/api/ask.ts`（没给 `conversationId` 就用主对话；主对话的 resume 走 `mainResume`）、`apps/core/src/api/conversation.ts`（`GET /main`）
- Test: `apps/core/src/memory/mainConversation.test.ts`、`apps/core/src/agent/runs.test.ts`（没有就新建）

**Interfaces:**
- Produces:
  - `mainConversationId(): string`（`sync_state` 键 `main:conversation`，没有或那段已被删就新建并记下）
  - `mainResume(now?: Date): string | undefined`：上海日期和 `main:session:since` 不同，或那之后主对话里用户消息 ≥ 40 条 → 把 `since` 记成 now、返回 undefined（新开 Claude session）；否则返回主对话的 `claude_session_id`（transcript 文件还在才返回，同 `/ask` 现有判断）
  - `addMessage(conversationId, { ...; taskIds?: string[] })`；`Message.taskIds?: string[]`
  - `listMessagesForTask(taskId: string): Message[]`：主对话里 `task_ids` 含它的 + 任务自己 `source.conversationId` 那段的全部，按时间排
  - `touchTask(conversationId: string, taskId: string): void`（`agent/runs.ts`）
  - `GET /main` → `{ id: string }`

- [ ] **Step 1: 写失败测试**

```ts
it("主对话只有一段：两次取同一个 id；那段被删了就新建", () => {
  const a = mainConversationId();
  expect(mainConversationId()).toBe(a);
  deleteConversation(a);
  expect(mainConversationId()).not.toBe(a);
});
it("换日或满 40 句换新的 Claude session", () => {
  const id = mainConversationId();
  setClaudeSessionId(id, "s1");
  mainResume(new Date("2026-10-22T02:00:00Z")); // 记下 since
  // 让 transcript 存在：测试里把 transcriptPath 打桩或建空文件
  expect(mainResume(new Date("2026-10-22T03:00:00Z"))).toBe("s1");
  expect(mainResume(new Date("2026-10-23T02:00:00Z"))).toBeUndefined();
});
// runs.test.ts
it("这一轮碰过的任务记到用户消息和回答上", async () => { /* startRun 时 askStream 打桩：途中调 touchTask(conv, t.id)，收尾后两条消息 taskIds 都是 [t.id] */ });
it("listMessagesForTask：主对话里挂了它的 + 它自己的旧会话", () => { /* ... */ });
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**：`messages` 补 `task_ids TEXT`（JSON）。`runs.ts` 的 `Run` 加 `taskIds: Set<string>` 和这一轮用户消息的 id；`touchTask` 找不到进行中的 run 就什么都不做；`execute` 收尾时 `UPDATE messages SET task_ids` 给用户消息、`addMessage` 回答时带上。`/ask`：没带 `conversationId` 时 `conv = mainConversationId()`，`conv === mainConversationId()` 时 resume 用 `mainResume()`，否则沿用现有逻辑。
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: 提交** `主对话：固定一段、按天或 40 句换 Claude session；消息记下这一轮碰过的任务`

---

### Task 3: 会话工具改成点名任务，转达和改卡都留痕

**Files:**
- Modify: `apps/core/src/agent/tools.ts`
- Modify: `apps/core/src/agent/prompt.ts`（`friday()` 里的工具说明与路由规则）
- Test: `apps/core/src/agent/tools.test.ts`

**Interfaces:**
- Consumes: `findTaskByRef`、`taskTag`（Task 1），`touchTask`、`addMessage({ taskIds })`（Task 2）
- Produces: `terminal_say { taskId, text }`、`task_update { taskId, ...原字段 }`、`task_start { taskId }`、`task_approve { taskId, actionId?, text? }`、`task_reject { taskId, reason }`、`jobs_activity { taskId?, jobId?, limit? }`（两个都没给就报错）。`taskId` 描述统一为「任务短号 #N、id 前 8 位或完整 id」。删掉 `boundTask`、`boundJob`、`freeConversation`。

工具层规则（每个都要做）：
- 解析不到 → 返回「没有这条任务：<ref>。先用 tasks_list 找，或问用户是哪条」。
- 成功后 `touchTask(conversationId, t.id)`，并往当前会话追加一条 `kind: "run"` 消息 `→ ${taskTag(t)}：<做了什么>`，带 `taskIds: [t.id]`。「做了什么」：terminal_say =「已转给终端：<text 前 80 字>」；task_update =「改了 <changed 列表>」；task_start =「开工了」；task_approve =「已执行「<label>」」；task_reject =「已打回：<reason>」。jobs_activity 只 touch 不留痕。
- `task_approve` 点名：用户最后一句去掉开头的 `#\d+` 后再判同意词；带了 `#N` 但不是这条 → 拒绝；没带 `#N`、而开着的任务里挂着 `APPROVAL` 里有的动作的不止一条 → 拒绝，返回「现在有 N 条在等你点头（#a「label」、#b「label」），让用户说「#N 通过」这样点名」。
- `todo_add` / `task_add` 不再写 `source.conversationId`；`run_claude` 不再找「这段会话绑着的任务」，一律新建。

提示词（`prompt.ts`）加一段，原样：

> 你只有一个主对话，用户在这里说所有任务的事。要对哪条任务动手，调工具时带 taskId（#N）。判断用户在说哪条：①他点了名（#N、标题里的词、项目名加功能名）；②指代你上一条主动消息说的那件事（「收下」「打回，按钮颜色不对」）；③任务板和知识库对得上，并且只剩一条开着的任务。对不上，或有两条都像，就反问「你说的是 #12 导出还是 #15 筛选？」，不要猜。

并删掉「当前会话绑着一条带终端的任务时…」那段（`prompt.ts:36`）。

- [ ] **Step 1: 写失败测试**（`tools.test.ts`，用 `call(name, args)` 现有写法；会话 id 用 `fridayToolList(conv)` 传进去，新加一个 `callIn(conv, name, args)`）

```ts
it("terminal_say 按 #N 找任务，会话里留「→ #N 标题：已转给终端」", async () => { /* 任务有 jobId、say 打桩；断言消息 content 以 `→ #${t.seq} ` 开头、taskIds=[t.id] */ });
it("找不到的 taskId：不动，提示先 tasks_list", async () => {});
it("裸「通过」、同时两条在等点头：拒绝并列出两条", async () => { /* 两条任务各挂 git_merge / brief_approve；最后一句用户消息「通过」 */ });
it("「#12 通过」只批 #12", async () => {});
it("task_add 在主对话里建的任务不带 conversationId", async () => {});
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**（按上面的规则）
- [ ] **Step 4: 跑测试确认通过**；`rtk proxy grep -rn "boundTask\|boundJob\|freeConversation" apps/core/src` 应无输出
- [ ] **Step 5: 提交** `会话工具改成点名任务：taskId 支持 #N，转达和改卡在主对话里留一行；裸同意词遇到多条在等就要求点名`

---

### Task 4: 每轮注入任务板

**Files:**
- Create: `apps/core/src/agent/needs.ts`
- Modify: `apps/core/src/api/ask.ts`（`taskBlock` 换成 `boardBlock`）、`apps/core/src/api/tasks.ts`（`GET /tasks` 每条带 `need`）、`packages/shared/src/index.ts`
- Test: `apps/core/src/agent/needs.test.ts`

**Interfaces:**
- Consumes: `taskTag`（Task 1）、`listMessages`（Task 2 的 `taskIds`）
- Produces:
  - `type NeedKind = "brief" | "review" | "blocked"`；`NEED_LABEL: Record<NeedKind, string>` = `{ brief: "方案待审", review: "待验收", blocked: "卡住" }`（`packages/shared`）；`Task.need?: NeedKind`
  - `needOf(t: Task): { kind: NeedKind; key: string; reason: string } | undefined`，规则（按顺序，先中先返回）：
    1. `kind` 是 `okr_weekly` / `handbook` / `project`，或状态 done / ignored → undefined
    2. 挂着 `brief_approve` → `brief`，key `brief:${t.source.brief?.at}`，reason = 理解卡 `plan` 前 120 字
    3. 状态 blocked → `blocked`，key `blocked:${t.progress}`，reason = progress
    4. `attention` 是 `question` / `intake` → `blocked`，key `${attention}:${t.progress}`，reason = progress
    5. 挂着 `reproject` / `discard_changes` / `start_job` → `blocked`，key `decide:${那条的 id}`，reason = `${label}：${detail 前 120 字}`
    6. 状态 review 且有 `report` → `review`，key `review:${report.at}`，reason = `report.summary`
    7. 其余 undefined
  - `boardBlock(conversationId: string, now?: number): string`：每条开着的任务（同 `taskBoard` 的排除规则）一行 `#N · 项目 · 标题 · 阶段 · 状态 · 等了多久`，状态取 `NEED_LABEL[need]`，否则 processing =「在干」、`autostart` 计划有 =「排队」、其余用 `STATUS_LABEL`；这段会话最近 3 条消息 `taskIds` 里的任务另给完整块（`contextFor(task, job, "friday")`，同原 `taskBlock`）。整块上限 6000 字，超了按「要你 > 在干 > 排队 > 其他」从后往前删行，完整块优先保留。

- [ ] **Step 1: 写失败测试**：`needOf` 七条各一例（含「review 但没有 report」→ undefined、done 的 → undefined）；`boardBlock` 一例断言行格式 `#${seq} · demo · 标题`，一例断言最近碰过的任务有完整块，一例造 300 条任务断言长度 ≤ 6000 且「待验收」那条还在。
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**；`/ask` 系统提示用 `boardBlock(conv)`；`GET /tasks` 的 `withSession` 加 `need: needOf(t)?.kind`
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: 提交** `每轮注入整块任务板：开着的任务各一行，刚聊过的给全文；按「要你」状态算 need`

---

### Task 5: 任务不再自带会话，旧的会话写入点改道

**Files:**
- Modify: `apps/core/src/memory/tasks.ts`（`createTask` 不建会话；`updateTask` 不再补会话）
- Modify: `apps/core/src/agent/bridge.ts`（`notify` 不再写会话消息；`terminalAsking` 不写会话；`setVerified` 不写会话）
- Modify: `apps/core/src/agent/delivery.ts`（`postDelivery` / `postShots` 删掉——交付消息改由 Task 6 的 watcher 发）及其调用点（`bridge.ts`、`pipeline.ts`）
- Test: `apps/core/src/memory/tasks.test.ts`、`apps/core/src/agent/bridge.test.ts`、`apps/core/src/agent/delivery.test.ts`

**Interfaces:**
- Consumes: `mainConversationId`（Task 2）
- Produces: 任务的 `source.conversationId` 只剩两种来源：老数据、HUD 的 `hudConversation`。`deliveryText(report, query)` 保留（Task 6 用）。

- [ ] **Step 1: 写失败测试**

```ts
it("建任务不再建会话", () => { expect(createTask({ title: "x", kind: "verbal", source: {} }).source.conversationId).toBeUndefined(); });
it("重新打开没会话的任务也不补", () => { /* done → understood，conversationId 仍 undefined */ });
it("主对话 id 不会出现在任何任务上", async () => {
  // 经主对话依次调 task_add、todo_add、run_claude（startAutonomousJob 打桩）
  const main = mainConversationId();
  expect(listTasks(undefined, 1000).some((t) => t.source.conversationId === main)).toBe(false);
});
it("交付不再往任务会话写消息（由主对话的主动消息接手）", async () => { /* 老任务带 conversationId，friday_done 后那段会话消息数不变 */ });
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**；改完 `rtk proxy grep -rn "postDelivery\|postShots" apps/core/src` 应无输出。原依赖「建任务即有会话」的测试按新行为改（`createTask` 的会话断言、`TaskDialog` 相关），每改一条在 ledger 记一句
- [ ] **Step 4: 跑测试确认通过**（`pnpm test` 全量）
- [ ] **Step 5: 提交** `任务不再自带会话：建任务不建、重开不补；交付 / 在问你 / 验证点全勾不再往任务会话写`

---

### Task 6: 主动消息

**Files:**
- Create: `apps/core/src/agent/notices.ts`
- Modify: `apps/core/src/index.ts`（启动时 `startNoticeWatcher()`；`FRIDAY_NO_SCHEDULER` 不影响它）
- Test: `apps/core/src/agent/notices.test.ts`

**Interfaces:**
- Consumes: `needOf`（Task 4）、`mainConversationId` / `addMessage({ taskIds })`（Task 2）、`taskTag`（Task 1）、`deliveryText`（Task 5 保留）
- Produces:
  - `noticeText(t: Task, need: NonNullable<ReturnType<typeof needOf>>): string`，模板（原样）：
    - brief：`` `${taskTag(t)} · 方案待审\n${need.reason}\n说「#${t.seq} 按这个做」开工，或说哪里要改。` ``
    - review：`` `${taskTag(t)} · 待验收\n${deliveryText(t.report!, Boolean(t.source.headless))}` ``
    - blocked：`` `${taskTag(t)} · 卡住\n${need.reason}` ``
  - `postNotices(): number`：扫开着的任务，`needOf` 有值且 key ≠ `getCursor(`notice:${t.id}`)` 就发一条（`role: "assistant", kind: "notice", taskIds: [t.id]`，review 的 payload 带 `attachments: report.screenshots`），再 `setCursor`；`needOf` 没值且有 cursor 的清成空串（下次进同一状态还会发）。没有 `notice:init` 时只记 key 不发，然后写 `notice:init`。返回发了几条。
  - `startNoticeWatcher(): () => void`：订阅总线 `tasks` 事件，500ms 合并后跑 `postNotices`，返回取消订阅

- [ ] **Step 1: 写失败测试**

```ts
it("第一次跑只记不发，之后进入状态才发", () => { /* 先有一条 review 任务 → postNotices()=0；再造一条 blocked → postNotices()=1，主对话最后一条 kind notice、content 含「· 卡住」 */ });
it("同一状态不重发：review 里改 progress、勾验证点都不发；第二轮交付（report.at 变）再发", () => {});
it("离开状态再回来会再发", () => { /* blocked → processing → blocked */ });
it("方案待审的文案带「说「#N 按这个做」开工」", () => {});
it("待验收带截图附件", () => {});
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: 提交** `主动消息：任务进入方案待审 / 待验收 / 卡住时往主对话写一条模板消息，同一状态不重发，升级首次只记不发`

---

### Task 7: 离开回来的汇总

**Files:**
- Modify: `apps/core/src/agent/notices.ts`（`returnDigest`）、`apps/core/src/api/conversation.ts`（`POST /main/presence`、`GET /main/needs`）
- Test: `apps/core/src/agent/notices.test.ts`

**Interfaces:**
- Consumes: `needOf`、`postNotices`
- Produces:
  - `presence(active: boolean, now?: number): Message | undefined`：失焦写 `main:away` = now；聚焦时离开 ≥ 15 分钟、且主对话里 `kind: "notice"` 的消息有晚于 `main:away` 的，就发一条汇总并返回；清掉 `main:away`
  - 汇总模板（原样，没有的分组整行省略）：

```
离开这 ${分钟} 分钟，${要你的条数} 件要你：
方案待审  #N 标题 · reason
待验收    #N 标题 · reason
卡住      #N 标题 · reason
还在干：#N 标题，#M 标题（排队）
```

  - `mainNeeds(): MainNeeds`，`MainNeeds = Record<NeedKind | "working" | "queued", Array<{ id: string; seq: number; title: string; reason?: string; since: string }>>`（`packages/shared`）；working = processing 且 `isFridayRun`，queued = understood 且有 `autostartPlan`
  - `POST /main/presence { active: boolean }` → `{ digest?: Message }`；`GET /main/needs` → `MainNeeds`

- [ ] **Step 1: 写失败测试**：离开 20 分钟期间来了一条 notice → 聚焦得到汇总，内容首行 `离开这 20 分钟，1 件要你：`；离开 20 分钟没有新 notice → 不发；离开 10 分钟 → 不发；「还在干」一行列出 processing 的自主任务。
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: 提交** `离开 15 分钟以上回来，有新的要你的事就在主对话里发一条汇总；GET /main/needs 给「等你」栏`

---

### Task 8: 生成中再说话就排队

**Files:**
- Modify: `apps/core/src/api/ask.ts`（排队、`DELETE /ask/queue/:id`、`GET /ask/queue`）
- Modify: `apps/desktop/src/lib/core.ts`、`apps/desktop/src/views/Thread.tsx`（发送遇 202 显示「排队中 · 撤回」；会话变成 running 时自动跟上流）
- Test: `apps/core/src/api/ask.test.ts`

**Interfaces:**
- Produces: `POST /ask` 在生成中时返回 `202 { queued: { id: string; prompt: string } }`（不再 409）；`GET /ask/queue?conversationId=` → `Array<{ id; prompt }>`；`DELETE /ask/queue/:id` → 200 / 404。队列在当前这轮结束（总线 `conversation` 事件 `running: false`）后取第一条、用当时的系统提示开跑；出错、被中断后同样继续。

- [ ] **Step 1: 写失败测试**（`askStream` 打桩成可控的异步生成器）

```ts
it("生成中再发：202 排队，这一轮结束后按顺序跑", async () => {});
it("撤回的不跑", async () => {});
it("上一轮出错 / 被中断，队列照样往下走", async () => {});
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**；前端：输入框照常能发，202 时在消息流末尾加一条灰色「排队中」气泡带「撤回」（调 DELETE），会话事件 `running: true` 且本 Thread 没在跟时 `askSubscribe` 跟上；重新挂载时用 `GET /ask/queue` 恢复排队气泡
- [ ] **Step 4: 跑测试确认通过** + `pnpm typecheck`
- [ ] **Step 5: 提交** `主对话里 Friday 在回时再说话就排队，这一轮结束接着跑，可撤回`

---

### Task 9: 会话视图换成主对话 +「等你」栏

**Files:**
- Modify: `apps/desktop/src/views/Chat.tsx`（会话视图、聚焦 / 失焦上报、删路由和新对话）、`apps/desktop/src/views/Thread.tsx`（`notice` 消息渲染）、`apps/desktop/src/lib/core.ts`、`apps/desktop/src/styles.css`
- Create: `apps/desktop/src/views/Needs.tsx`
- Delete: `apps/core/src/agent/route.ts`、`apps/core/src/agent/route.test.ts`、`POST /route` 路由
- Test: core 侧 `rtk proxy grep -rn "routeAsk\|/route\b\|routeCandidates" apps` 无输出；前端靠 `pnpm typecheck` 和 Task 11 的真机截图

**Interfaces:**
- Consumes: `GET /main`、`GET /main/needs`、`POST /main/presence`（Task 2、7）
- Produces: `Needs` 组件（props `{ onPick: (taskId: string) => void }`），分组顺序 方案待审 / 待验收 / 卡住 / 在干 / 排队，每行 `#N 标题`，空组不显示，组头带数量；收到总线 `tasks` 事件时重新拉。

要做的：
- 会话视图：左边 `Thread conversationId={主对话 id}`，不传 `resolve`；右边 240px 宽的 `Needs`，点一行切到任务视图并选中那条。删掉「新对话」按钮、`⌘⇧N`、`routeHint` 和「其实是新话题」、`resolveFree`、`redoAsNew`。Skill / 模型两个胶囊保留。
- `notice` 消息：卡片样式（细边框、左侧状态色点：方案待审 amber、待验收 green、卡住 red），首行 `#N 标题` 可点，点了同上；正文按原样分行；带附件的显示缩略图。
- 窗口 `focus` / `blur` 时 `POST /main/presence`，返回带 `digest` 就不用处理（Thread 会按事件刷新出来）。
- 「···」→ 会话历史：列老会话，点开是只读的 `Thread`（`disabledNote="旧会话，只读。有事在主对话里说"`）。

- [ ] **Step 1: 删 core 的路由，跑 `pnpm test`**，Expected: PASS（删掉的测试不算）
- [ ] **Step 2: 前端改造**
- [ ] **Step 3: `pnpm typecheck`**，Expected: 无新增错误
- [ ] **Step 4: 提交** `会话视图换成主对话：右侧「等你」栏、主动消息渲染成卡片、离开回来上报；删掉新对话和会话路由`

---

### Task 10: 任务视图：按「要你」分组，详情去掉输入框，加「相关对话」

**Files:**
- Modify: `apps/desktop/src/views/Board.tsx`（列表分组、删 `TaskChat` 的四处使用和组件本身、详情头）、`apps/desktop/src/views/TaskDialog.tsx`（`chat` 插槽删掉）、`apps/desktop/src/lib/core.ts`
- Modify: `apps/core/src/api/tasks.ts`（`GET /tasks/:id/related`）
- Create: `apps/desktop/src/views/Related.tsx`
- Test: `apps/core/src/api/tasks.test.ts`（`/related` 接口）

**Interfaces:**
- Consumes: `listMessagesForTask`（Task 2）、`Task.need`（Task 4）
- Produces: `GET /tasks/:id/related` → `Message[]`；`Related` 组件 props `{ taskId: string }`，默认折叠，标题「相关对话 N 条」，展开只读列出（用户 / Friday / 主动消息三种样式），不带输入框。

要做的：
- 列表分组：方案待审 / 待验收 / 卡住 / 在干 / 排队 / 其他，前三组按 `need`，「在干」= processing，「排队」= `autostart` 有值，其余进「其他」（原有的阶段子分组放进「其他」里保持不动）。
- 详情：删掉所有 `TaskChat`，各处原位置放 `Related`；空态、自主卡、排队卡的会话区一并去掉。`IdleState` / `FridayTop` 里引导「在会话里说」的文案改成「在主对话里说「#N 开工」」。
- `TaskDialog` 不再接 `chat`。

- [ ] **Step 1: 写失败测试**：`/tasks/:id/related` 返回主对话里挂它的 + 它旧会话的消息，按时间排；不相干的不出现。
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**；`rtk proxy grep -rn "TaskChat" apps/desktop/src` 无输出
- [ ] **Step 4: `pnpm test && pnpm typecheck`**
- [ ] **Step 5: 提交** `任务视图按方案待审 / 待验收 / 卡住 / 在干 / 排队分组；详情去掉会话框，改成只读的相关对话`

---

### Task 11: 真机验收与文档

**Files:**
- Modify: `CLAUDE.md`（新增「主对话（2026-10-22）」一节；改掉「每条任务建立时就有且只有一段 Friday 会话」「会话归任务」「`/route`」「`⌘⇧N`」等矛盾描述）

- [ ] **Step 1: 起隔离环境**：core `FRIDAY_PORT=7791 FRIDAY_DATA_DIR=<临时> FRIDAY_NO_SCHEDULER=1 FRIDAY_TMUX_SOCKET=friday-verify FRIDAY_CLAUDE_BIN=<假 claude>`（挂在活着的父进程下）；前端 `VITE_FRIDAY_PORT=7791 pnpm --filter @friday/desktop exec vite --port 1421`；前后各看一次 ptmx 计数。
- [ ] **Step 2: 后端逐条验**（curl）：建两条任务 → `GET /tasks` 带 `seq`；一条 `friday_done` → 主对话最后一条是 `#N 标题 · 待验收`；`POST /main/presence {active:false}`、把 `main:away` 改成 20 分钟前、再造一条 blocked、`{active:true}` → 拿到汇总；`GET /main/needs` 分组正确。主对话的模型调用不验（会花钱），工具层留痕已有测试。
- [ ] **Step 3: 前端用 agent-browser 打开 `http://localhost:1421`**，截三张图存 scratchpad：会话视图（主对话 + 「等你」栏 + 一张待验收卡片）、任务视图（分组 + `#N`）、任务详情（没有输入框、相关对话展开）。逐张对照本计划 Task 9、10 的「要做的」核对。
- [ ] **Step 4: 收尾**：只 kill 自己记下的 PID，`tmux -L friday-verify kill-server`，ptmx 回到起点。
- [ ] **Step 5: 改 CLAUDE.md，提交** `文档：主对话`
