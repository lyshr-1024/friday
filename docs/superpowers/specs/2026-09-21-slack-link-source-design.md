# Slack 重做：从收件箱到关联源

日期：2026-09-21 · 分支：`feat/slack-link-source` · 状态：待用户审阅 · 替代第三版「Slack 收件」与其后的线程 / 情境卡 / 闸门链路

## 0. 背景

第三版把 Slack 做成了收件箱：triage → 按人聚合线程 → 情境卡 → 回复草稿 → 置信度闸门 → 审核 → lessons / playbooks。这条链路与后来定下的产品定位相悖：**Friday 不替代 Slack**，用户照旧在 Slack 里看和回，Friday 只是贴在上面的一层，负责记全局、干重活、随叫随到。

库里（9/18 重置后）的实证：

| 项 | 数 |
|---|---|
| 收件（私聊 / @我） | 73（23 / 50） |
| triage 判「需回复」 | 36 |
| 被「用户已在 Slack 读过或回过」扫描标成已处理 | 56 |
| 线程 / 有情境卡 | 36 / 34，全部 open |
| Slack 来源任务、lessons、thresholds、slack_reply 账本 | 全部 0 |
| 3 天 brief + triage + continuation 花费 | 约 $4.6 |

- 判断层已被架空：brief 提示词已改成「不起草回复、不给行动建议」，情境卡里 reply / confidence 为空；闸门、自动发送、lessons、playbooks 围着「Friday 起草、用户审」建，前提已不存在。
- 前端零入口：InboxList / ThreadCard 无引用，工作台只剩「↻ Slack」同步按钮，线程通知已关。每天约 $1.5 算出的情境卡没人看。
- 用户 9/17 的四条槽点全落在判断层：回复草稿不可用、重复建任务且多是已处理的、待办抽象不对、方案该交给终端。
- 关联只做了一半：带工单链接的对话（约 13/200）能接到 Meegle 任务，其余九成靠标题对项目名，命中不了。

## 1. 定位与原则

Slack 在 Friday 里的角色从「收件箱」变成「关联源」：

1. **只挂靠，不评判。** 消息作为「一段对话」落库并挂到已有任务上，Friday 不判断要不要回、不起草、不建任务、不通知。
2. **建任务只有用户明确要求这一个入口**（HUD「建成任务」、任务卡「并入这段对话」）。唯一例外是 Friday 自己接的查询活（见 §4.3）。
3. **查询类问题 Friday 替用户查代码并起草回复。** 这是保留的唯一起草场景，走「Friday 在做」→ review → `slack_reply` 待审。
4. **推断可以错，纠正后不能再错。** 用户改一次挂靠写成一条 `user` 边，摘掉一条写成否决边；`links` 的可信度只升不降，自动推断不会把纠正推翻。
5. **消息状态以 Slack 为准。** 用户在 Slack 里读过或回过，Friday 这边对应的东西自动收掉。

## 2. 留什么、删什么

**保留**

- 连接器本体 `connectors/slack.ts`：拉 @ 与私聊、`fetchContext` 补拉前文、`noise.ts` 噪音过滤、机器人过滤、Block Kit 取正文、已读已回扫描（`fetchLastRead` / `repliedSince` / `sweepRepliedInbox`）、Meegle 链接解析、`postMessage` / `chat.delete`。
- `slack_reply` 待审动作、执行、撤回账本；「派出任务完成后回帖」（`pipeline.ts` 里 job 回流那段）。
- HUD 呼出模式的 Slack 场景（`agent/summon/slack.ts`），改读新数据。
- 工作台「↻ Slack」按钮与 `POST /inbox/sync`。

**删除**

- `agent/triage.ts`、`agent/brief.ts`、`agent/enrich.ts`、`agent/continuation.ts`、`agent/autowrite.ts`、`agent/lessons.ts` 与 `distill`、`memory/playbooks.ts`、`memory/threads.ts` 及 `threads` 表、置信度闸门与 `thresholds` 表、`GET /threads` 一族接口、`GET /learn` / `PUT /learn/threshold`、`reviewOnce`、线程通知、`pipeline.ts` 里 `threadToTask` / `decideStart` 的 Slack 路径。
- 前端 `InboxList` / `ThreadCard` / `TodoList`、`Board.tsx` 里按 Slack 线程派生待办的折叠逻辑、`REPLY_CATEGORIES` / `ReplyCategory` 等共享类型。
- 设置页「每天复盘人工处理」开关（`settings.learn`）。
- 老数据不迁移（用户 9/17 明确：老数据可以不兼容）。`inbox` 表里的历史行照留，不补挂靠。

`lessons` 表连 CHECK 约束一起 drop。`agent/lessons.ts` 里若有与 `slack_reply` 无关的逻辑随删。

## 3. 数据模型

**对话单位**改用 Slack 原生粒度：有 `thread_ts` 的整个 thread 算一段（键 `channelId:thread_ts`），否则单条消息算一段（键 `channelId:ts`）。原「按人两小时聚合 + 灰区语义归并」解决的「同一人隔几小时催同一件事」，由挂靠硬信号「同一人同一频道近期挂过的任务」覆盖。

**挂靠复用已有的 `links` 表，不新建表。** `memory/links.ts` 已经实现了本设计需要的全部语义，浏览器那一端（`urlNode` ↔ 任务）也已经在用它：

- 边无向、同一条边只留一行（`links_edge` 唯一索引），重复推断走 UPSERT。
- 可信度 `user` > `rule` > `guess` **只升不降**：用户纠正过的不会被后来的自动推断覆盖。
- `unlink(a, b)` 断开并写一条否决边（另一端加 `!` 前缀），`rejected(a, b)` 查它；`linkUp` 在 `source !== "user"` 时先查否决，**被否决过的自动推断不会再连回来**。这正是「纠正以后不能再错」，不需要另造映射表。
- 每条边带 `why`（一句话说明凭什么这么连），界面直接显示，出错时能看出是哪条规则的锅。

新增一个节点类型：`LinkKind` 加 `"slack"`，`ref` 是对话键（`channelId:thread_ts` 或 `channelId:ts`）。`memory/infer.ts` 加 `slackNode(conversation: string): LinkNode`，与已有的 `taskNode` / `meegleNode` / `urlNode` 并列。

三级硬信号映射到 `LinkSource`：工单链接、近期同人同频道 → `"rule"`；模型推断 → `"guess"`（界面标「Friday 推断」）；用户手动挂 → `"user"`。`how` 的细分不再单独存列，写进 `why` 那句话里。

`inbox` 表：去掉 `triage` / `category` / `thread_id` 列，保留 `thread_ts`；`done` 改名 `settled`（用户在 Slack 里读过或回过）；加 `prior TEXT`（JSON，`fetchContext` 拉到的前文），供任务卡和 HUD 展示、供查询任务作为输入。

任务类型新增 `kind: "slack_query"`，`source` 带 `conversation`、`channelId`、`userName`、`threadTs?`、`project?`、`jobId`。

## 4. 流程

每条新消息按顺序过三步，前两步零模型调用。

### 4.1 噪音过滤

照旧（`classifyNoise`），挡掉的不入库，游标照常推进。

### 4.2 挂靠 `agent/slack/attach.ts`（纯函数 + 一处可选模型调用）

候选任务 = 状态不是 done / ignored 的全部任务，减去被 `rejected()` 否决过的。按优先级取第一个命中的硬信号，命中即 `linkUp(slackNode(conv), taskNode(id), "rule", why)`：

1. **工单**：消息正文含 Meegle 工单链接或工单号（复用 `infer.ts` 的 `meegleIdsIn`）→ `source.meegleId` 相同的任务。`why`：「消息里贴了工单 24440539」。
2. **近期**：同一人同一频道 48 小时内已挂过的任务（查 `links` 里该频道其他对话的邻居）。`why`：「拂晓 3 小时前在这个频道说的也是这条」。

硬信号全没中且候选非空 → Haiku 一次：给消息正文（`untrusted`）、前文、候选任务的标题与一句理解，要求答一个任务 id 或 `none`；提示词写明拿不准答 `none`。答了就 `linkUp(..., "guess", why)`。没候选或答 `none` → 静默留库，不写任何边。

同一段对话后续消息进来时，先看 `neighbors(slackNode(conv), "task")`，已有边就沿用，不重跑。

**纠正**：任务卡「不是这条」→ `unlink(slackNode(conv), taskNode(id))`，自动写否决边；HUD / 任务卡「挂到…」→ `linkUp(..., "user", "你手动挂的")`。两者都不需要额外的映射表，`links` 的可信度规则天然保证不被推翻。

**沉淀到人**：用户手动挂过之后，「近期」那条规则下次就会命中同一个人在同一频道的新消息，等价于 spec 早先设想的「人 + 频道 → 任务」映射。

### 4.3 查询分类与查代码 `agent/slack/query.ts`

只对私聊和 @ 我、且正文带疑问信号（`？` / `?` / 怎么 / 哪里 / 哪儿 / 为什么 / 为啥 / 能不能 / 是不是 / 有没有）的消息跑。Haiku 判两件事：是不是「读代码就能回答的问题」（实现在哪、为什么这样、能不能改、某字段从哪来）；问的是哪个项目（从注册表选，选不出为空）。都不是 → 什么也不做。

是 → 建 `slack_query` 任务进 processing（标题「回答 {人}：{问题前 40 字}」，理解写问题原文与前文），在项目目录起只读的 `claude -p`：

- 权限只放行 Read / Grep / Glob 与 Bash 里的只读命令（`git log` / `git show` / `rg`），挂现有 `guard.ts` hook；不开 Edit / Write，不建 worktree。
- 项目判不出 → 依次查全部注册项目，提示词要求先判哪个项目相关再深入。
- 产出写到 `<runs>/<id>.report.md`：结论、依据（文件路径 + 行号）、一句 20 到 80 字可直接发给对方的回复草稿。

任务退出 → 解析报告 → 任务进 review，挂 `slack_reply` 待审（草稿即报告里那句，`payload.channel` / `threadTs` 取自对话）。报告全文进任务卡「交付报告」，用户能核对依据。

复用现有 `startAutonomousJob` 的骨架（jobs 记录、Ghostty 窗口、退出回报），提示词与权限集另写一份 `queryPrompt`。

### 4.4 用户在 Slack 里自己回了

已读已回扫描（每轮同步）命中一段对话：

- 该对话上挂着的 `slack_query` 任务若还没发出 → 任务 done、撕掉 `slack_reply` 待审动作、记账 `slack_settled_by_user`。
- 该对话只是挂靠在别的任务上 → 只标 `settled`，任务不动。

这是防「重复出现已处理的事」的关键。

### 4.5 建任务的两个入口

- HUD「建成任务」：`addNoteTask`，`kind: verbal`，`source` 带 `conversation`，同时 `linkUp(slackNode(conv), taskNode(new.id), "user", "你在 HUD 里把这段对话建成了任务")`。
- 任务卡「并入这段对话」：从最近 7 天未挂靠的对话里挑，同样写一条 `user` 边。

「派出任务完成后回帖」照旧：`job_reported_back` 时若原任务挂着 Slack 对话，挂 `slack_reply` 待审，回帖到那段对话。

## 5. 界面

- **任务卡**新增一段「Slack 里的讨论」：按时间列该任务挂着的对话，每段显示人、频道、首条正文、前文折叠、「在 Slack 打开」、「不是这条」。边的 `source` 是 `guess` 的标一个小字「Friday 推断」并显示那条 `why`，让用户知道哪些该核对、凭什么连的。
- **HUD 在 Slack 前台**：按窗口标题解析频道或人名，取该频道 / 私聊最近一段对话。卡片「我看到了」写对话首句；匹配区写「属于任务 X · {进展一句}」或「没对上任务」；动作固定三个：帮我查这个（建 `slack_query` 任务，跳过疑问信号判定）/ 建成任务 / 挂到…（下拉列未完成任务）。零模型调用。
- **工作台**：不新增任何 Slack 列表或分组。`slack_query` 任务走现有「Friday 在做」→「待我决定」，卡片来源标识「Slack 查询」。「↻ Slack」按钮保留。
- **设置页**：去掉「每天复盘人工处理」；「系统通知」那行的说明改成「任务结束、终端在等你回答」。

## 6. 接口

- 删：`GET /threads`、`POST /threads/:id/*`、`GET /learn`、`PUT /learn/threshold`、`POST /tasks/review`。
- 改：`GET /inbox` 返回对话视图（含挂靠）；`POST /inbox/sync` 不动。
- 增：`POST /slack/:conversation/attach {taskId}`（写 `user` 边）、`DELETE /slack/:conversation/attach/:taskId`（`unlink`，自动写否决边）、`POST /slack/:conversation/query`（HUD「帮我查这个」）、`POST /slack/:conversation/task`（建成任务）。
- 会话工具：`slack_inbox` 改为输出对话与挂靠视图；删 `review_now`；`task_update` 不动。

## 7. 成本

- 挂靠：多数消息零调用；Haiku 只在「硬信号全没中且有候选」时跑一次，按当前日均 20 条消息估不超过 $0.1 / 天。
- 查询分类：只对带疑问信号的私聊 / @ 跑 Haiku，一次约 $0.002。
- 查代码：只读 `claude -p`，一次几分到几十分钱，按数据一天几条。
- 对比现状每天约 $1.5 的 triage + brief + continuation。用量面板里 `label` 新增 `attach` / `query`；`claude -p` 的花费仍不计（沿用现状）。

## 8. 测试与验收

**单测（vitest）**

- `attach.test.ts`：工单 > 近期 的优先级；被 `unlink` 否决过的任务不再进候选、也不被模型重连；硬信号命中时不调模型；无候选不调模型；同一对话后续消息沿用 `neighbors` 查到的已有边；手动挂过之后同人同频道的新消息走「近期」直接命中。
- `query.test.ts`：疑问信号判定（含全角问号、无问号但有「怎么」）；私聊与 @ 以外不跑；解析报告取出草稿并钳长度；项目判不出时提示词列全部项目。
- `settle.test.ts`：用户已回 → `slack_query` 任务 done 且待审动作撕掉；仅挂靠的任务不动。
- `guard` 只读放行集：Edit / Write / `git push` 被拦。
- `db.test.ts`：`threads` / `lessons` / `thresholds` 表 drop，`inbox` 去列与加 `prior` / `settled`，老库升级不报错。`links` 表不动。

**真机（每步截图进交付报告）**

1. 一条带工单链接的 @ → 对应 Meegle 任务卡出现「Slack 里的讨论」。
2. 同一人同一频道 3 小时后再发一条无链接消息 → 自动挂到同一任务，卡片上显示那条边的 `why`。
3. 私聊「xx 在哪实现的」→「Friday 在做」出现一张卡 → 进 review 有草稿与依据 → 「看一眼再发」发出。
4. 同样一条问题，用户先在 Slack 里回了 → 下一轮同步后卡片自动 done，账本一条 `slack_settled_by_user`。
5. Slack 前台呼出 HUD → 卡片显示「属于任务 X」，「挂到…」改到另一条任务 → 任务卡更新，同一人再发消息直接挂到新任务。
6. 用量面板 3 天里 Slack 相关花费低于 $0.5。

## 9. 不做

Slack 发送以外的任何外发；后台起草非查询类回复；按人聚合线程与语义归并；学习闭环（映射表是它的替代）；老数据迁移；HUD 以外的主动通知；`claude -p` 用量计入面板。
