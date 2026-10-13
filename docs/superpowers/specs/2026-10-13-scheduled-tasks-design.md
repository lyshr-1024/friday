# 定时任务（2026-10-13）

## 起因

用户在会话里说「每天 10 点去拉这个多维表格视图里研发负责人是我、产品验收不通过的记录，去修复」，Friday 回「我没有定时自己触发的能力」。调度器 `scheduler/index.ts` 里只有五个硬编码的 `setTimeout`（Slack / Meegle / 学习 / 终端对账 / 周报），用户没法自己登记。

**定位**：定时任务 = 什么时候 + 谁来执行 + 一段提示词（或一个固定调用）。具体去哪拉数据、怎么筛，写在提示词里交给执行方自己用 skill / MCP 解决，**Friday 不为某个数据源写专用连接器**。

## 范围

- 做：`schedules` 表；每分钟一次的到点检查；三种执行方（项目 / Friday / 固定调用）；会话工具登记；「···」→ 定时任务弹窗；周报、学习两行内置例行在同一列表里展示。
- 不做：界面上的编辑表单（改走会话）；stdio 类型的 MCP；把周报、学习的执行逻辑迁进通用调度。

## 数据

表 `schedules`（`memory/schedules.ts`）：

| 列 | 说明 |
|---|---|
| `id` | `s-` + 8 位 hex |
| `title` | 「每天修 WBO 验收不通过的页面」 |
| `cron` | 五段 cron，按 `Asia/Shanghai` 解释；Friday 把「每天 10 点」翻成 `0 10 * * *` |
| `enabled` | 0/1 |
| `executor` | `project` / `friday` / `call` |
| `project` | executor=project 时必填，登记时经 `resolveProject` 校验 |
| `prompt` | project / friday 必填 |
| `mode` | `continue` / `fresh`，project / friday 用 |
| `attended` | 0/1，project 用：1 = 交互式终端，0 = 无人值守 `claude -p` |
| `server` / `tool` / `args` | executor=call：`server` 为 `friday` 或 `~/.claude.json` `mcpServers` 里的名字，`args` 为 JSON |
| `anchor_task_id` | project + continue 的长期卡 |
| `conversation_id` | friday 的会话（continue 一直用这段；fresh 记最近一次的） |
| `created_at` / `last_run_at` / `last_result` / `last_ok` / `last_ref` | `last_ref` 是上次结果落在哪：任务 id 或会话 id |
| `history` | JSON 数组，最近 5 轮的交付概要（project continue 用；`runs` 表不存每轮报告，只能自己攒） |

`TaskSource` 加 `scheduleId?: string`。

## 触发（`scheduler/schedules.ts`）

- `startScheduler` 里加一个 60 秒的 tick，逐条看 `enabled` 的：`prev = croner(cron).previousRun(now)`。
- **该跑**：`prev > max(last_run_at, created_at)`。
- **错过补一次**：电脑睡眠、Friday 没开导致错过的，醒来只跑一次（只看最近一个 `prev`，不逐个补）。`now - prev > 12h` 则不跑，写 `last_run_at = now`、`last_result = "错过了 HH:MM 那次，超过 12 小时不补"`，账本记 `schedule_skipped`。
- **上一轮没完跳过**：project 的上一张卡还是 `processing` 且会话在干活、或挂着未处理的 `git_merge`；friday 的会话 `isRunning`。跳过同样写 `last_run_at`、记 `schedule_skipped`（「上一轮还在」）。
- 跑了记 `schedule_fired`（evidence：scheduleId、executor、ref），写 `last_*`。执行抛错写 `last_ok = 0`、发通知。
- `POST /schedules/:id/run` 走同一个分派函数，不看到点、照样看「上一轮没完」。

## 三种执行方（`agent/schedule.ts` 的 `fireSchedule`）

### project

跑出来的是普通任务卡：`kind: code`，标题前缀 `[定时] `，`source.scheduleId`，进任务列表。不经 autostart 门禁、不占其并发。

- **continue**：第一次建长期卡写进 `anchor_task_id`；卡已 done / ignored 先 `reopenTask`。提示词 = 原 prompt + 「上几轮做了什么」：每次触发前，把长期卡此刻的 `report`（上一轮的交付）概要追加进 `history`（按 `report.at` 去重，留最近 5 条），再拼进提示词。**不依赖 Claude 的对话上下文**，worktree 删了、会话关了照样接得上。
  - 无人值守：`startAutonomousJob(anchor, …, trigger: "schedule")`。会话 `exited` 时它本来就走 `runInSession` 在原 worktree 起新一轮 `-p`；没会话就重开。
  - 有人值守：`startInteractiveJob(anchor, …)`；已有会话时它走 `continueRootSession` 把话送进去，忙时 `say()` 排队。
- **fresh**：每次 `createTask` 新卡，按 `attended` 走上面同样两个入口。
- 有人值守的到点发通知「到点了，已在 <项目> 开好终端：<标题>」，带 `taskId`。
- `RunTrigger` 加 `"schedule"`。

### friday

- 每个定时任务一段会话（`createConversation`，标题 = schedule 标题）。continue 一直用它、带 `resume`（transcript 还在才带，同 `/ask`）；fresh 每次新建、记到 `conversation_id`。
- `startRun(conv, prompt, opts)`，`opts` 同 `/ask`（skills、skillList、web、model），`label: "schedule"`，`systemPrompt` 在 `friday(...)` 后追加：「这一轮是定时任务『<标题>』自动触发的，用户不在看。不可逆的动作只能挂成待审，不要直接执行；结尾第一行写一句结论」。
- **硬拒**：定时会话不绑任务，`task_approve` / `task_reject` / `task_update` 本来就调不动（`boundTask` 为空）；`close_terminals` 在会话属于某个 schedule 时直接返回「定时任务里不能关终端，等用户回来」。
- 跑完（`run.done`）发通知：标题 = schedule 标题，正文 = 回答第一行（≤80 字）。`Notice` 只能带 `taskId`，这条不带跳转；弹窗里「上次结果」点了打开这段会话。

### call

- `server === "friday"`：在 `fridayToolList()` 里按名字找到工具，直接调它的 handler（`args` 先过它自己的 zod schema），取返回的 text。
- 其他：`connectors/mcp.ts` 的 `callTool(server, tool, args)`，从 `okr.ts` 抽出 `initialize → tools/call` 的 JSON-RPC 客户端（读 `~/.claude.json` 的 `mcpServers[server]`，http only，兼容 JSON / SSE 响应，15 秒超时）。`okr.ts` 改为调它。stdio 的在登记时就拒绝。
- 结果截 2000 字存 `last_result`；`isError` 或抛错 → `last_ok = 0` 并通知。成功不通知。

## 登记（会话工具）

- `schedule_add({title, cron, executor, project?, prompt?, mode?, attended?, server?, tool?, args?})`：校验 cron 能解析、project 能解析、call 的 server 存在且是 http（friday 的 tool 名存在）；返回 id + 下次运行时间（中文）。
- `schedule_update(id, 部分字段)`、`schedule_remove(id)`、`schedules_list()`。
- 系统提示：登记 / 修改前先把「什么时候 · 谁跑 · 跑什么 · continue / fresh · 有没有人值守」复述给用户，用户说好再调；call 要原样列出 tool 和参数（无人值守、不过模型，写操作会直接执行）。用户没说的 `mode` / `attended` 由 Friday 按描述判断并在复述里写明。
- 账本：`schedule_added` / `schedule_updated` / `schedule_removed`，只记账不做撤销（登记前已复述确认，删了可以再登记）。

## 接口

- `GET /schedules` → `{ items: ScheduleView[] }`，`ScheduleView` 带 `when`（cron 的中文描述）、`nextRunAt`、`executorLabel`。
- `PATCH /schedules/:id {enabled}`、`POST /schedules/:id/run`、`DELETE /schedules/:id`。

## 界面

「···」菜单加「定时任务」，弹窗 `ScheduleDialog`（`views/Routines.tsx`，外壳 `Modal`）：

- 顶部两行内置：周报（「周五 16:00 起自动起草」，开关 = `settings.okrWeekly`，点行打开周报弹窗）、学习（「每周一轮」，开关 = `settings.learnHistory`，点行打开学习弹窗）。
- 下面每条定时任务一行：标题 · 时间 · 执行方标签 · 下次 · 上次结果（✓/✗ + 相对时间，点了跳任务卡或会话）· 开关 · 「现在跑一次」· 删除（第二次点击才删）。点行展开看完整 prompt / call 参数。
- 空态：「还没有定时任务。在会话里说『每天 10 点在 whale-console 里……』就能登记。」

`cron` → 中文：只覆盖常见形态（每天 / 工作日 / 每周 X / 每小时 / 每 N 分钟），其余原样显示 cron。

## 测试

- `schedules.test.ts`：到点判定（正常、错过补一次、超 12h 跳过、`created_at` 之前的不跑、上一轮没完跳过）。
- `schedule.test.ts`：三种执行方分派（project continue 复用长期卡 + 上几轮概要拼进提示词、done 的卡先重开；fresh 每次新卡；friday 系统提示带定时说明；call friday 工具直调）。
- `mcp.test.ts`：起本地假 http MCP，测 JSON / SSE 两种响应、超时、`isError`。
- `tools` 测：schedule 会话里 `close_terminals` 被拒。
- 真机：`FRIDAY_CLAUDE_BIN` 假脚本 + `FRIDAY_TMUX_SOCKET=friday-verify`，登记一个 `* * * * *` 的 project continue，看第二轮落到同一张卡且提示词带上一轮概要；friday、call 各跑一次；浏览器过一遍弹窗。

## 文档

CLAUDE.md 加一节「定时任务（2026-10-13）」。
