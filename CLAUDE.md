# Friday

macOS 个人助理：常驻菜单栏，有长期记忆，聚合待办（Meegle、本地记录，后续 Slack），知道我在做哪些项目，后续能按定时任务自主拉起 Claude Code 干活。非沙盒、直接分发、不走 App Store。所有运行时数据只存本机。

## 架构（已定，不要更改）

- **壳** `apps/desktop/src-tauri`：Tauri 2 / Rust。只做菜单栏图标、全局热键、浮窗管理、开机自启、系统通知、拉起并守护 sidecar。胶水代码，尽量薄，不放业务逻辑。
- **核心** `apps/core`：Node + TypeScript 独立进程，HTTP 只监听 `127.0.0.1`，端口默认 7788（`FRIDAY_PORT` 可改）。所有业务都在这里：调度器、记忆库、连接器、Claude Agent SDK 调用、`claude` 子进程管理。**必须能脱离壳独立运行和测试**（`pnpm dev:core`）。
- **前端** `apps/desktop/src`：React + TS，跑在 Tauri WebView。第一版只有 Spotlight 风格浮窗和最简设置页。
- **共享类型** `packages/shared`：前后端共用的 API 类型与常量，只放类型和常量。
- **记忆库**：`~/Library/Application Support/Friday/`，不在项目目录。Markdown 存半结构化内容（projects/decisions/people），SQLite（`node:sqlite` 内建模块）存待办、同步状态、会话日志。仓库只提交 `memory-schema/` 里的 schema 和示例。
- **Claude 调用**：`@anthropic-ai/claude-agent-sdk`，复用本机 `claude` 登录态，不用 API key。
- **项目管理工具**：Meegle（飞书项目），连接器直接调本机 `meegle` CLI（`mywork todo` + `workitem get`），登录态由 CLI 自己的 token store 管理，Friday 不碰凭证。Slack 连接器第一版不做，只保留 `Connector` 接口位。
- 包管理 pnpm，HTTP 框架 hono，构建 tsup（core）/ vite（前端）。

## 目录约定

```
apps/core/src/
  api/        HTTP 路由，一个文件一组路由，在 api/index.ts 汇总
  memory/     记忆库路径、初始化、SQLite 读写
  connectors/ 外部数据源，实现 connectors/types.ts 的 Connector 接口
  scheduler/  定时任务（第二版）
  agent/      Agent SDK 封装、claude 子进程、permission.ts 操作分级
```

## 范围

第一版（已完成）：热键呼出浮窗、`POST /ask`、`POST /note`、待办同步 `GET /todos?sync=1`、记忆库初始化、开机自启。原「今日简报」`GET /today`（Claude 总结待办）已按用户要求移除，换成 `GET /hot`（AI 热点）。
第二版（已完成）：`POST /run` 在 Ghostty 打开项目目录跑交互式 Claude Code；独立打包（`.app` 内嵌 core 产物与依赖，不依赖仓库目录，node 仍用系统的）。
第三版（已完成）：Slack 收件——`connectors/slack.ts` 用浏览器登录态（钥匙串 `friday-slack` 的 `token` xoxc + `cookie` xoxd，`scripts/slack-auth.sh` 写入）调 Web API：`search.messages` 查 `<@me>`、`client.counts` 找有未读的私聊再 `conversations.history`；`scheduler/index.ts` 10:00–20:00（Asia/Shanghai）每 3 分钟、其余 15 分钟拉一次；新消息交 `agent/triage.ts` 用 Sonnet 5 批量判断是否需回复 / 紧急度 / 摘要 / 回复草稿，落 `inbox` 表；只有需回复且在活跃时段才进通知队列，壳 `notify.rs` 每 20 秒 `GET /notifications` 取走弹系统通知。Friday 只读 Slack，不发消息。启动器「Slack 收件」面板 / `⌘R` 立即同步。预处理同时按项目注册表（名字、别名、`- 频道：#a, #b`）推导关联项目 `triage.project`，编码类消息给一句 `triage.task`；收件条目「在会话里处理」→ 带原文、链接、预处理结果开一个新对话（`open_chat` + initialPrompt），Friday 在会话里先给判断（项目、怎么回、要不要动代码、用哪个 skill），用户确认后再 run_claude / skill / 给草稿；操作区不直接动手。`POST /inbox/:id/handle` 仍保留给程序化调用。会话里有 `slack_inbox` 工具，"处理拂晓那条"同一流程。
未做：项目智能匹配、自动更新、内嵌 node、Slack 发送。结构预留位置即可，不要提前实现。

## macOS 坑

- **PATH**：Finder / 自启拉起的 app PATH 极简。壳启动 sidecar 前先用 `zsh -ilc 'echo $PATH'` 取真实 PATH 注入子进程环境；找 `node`、`claude` 都靠它。
- **bundle ID** 固定 `com.haoran.friday`，签名用本机自签证书 `Friday Dev`（首次 `scripts/make-signing-cert.sh` 生成，只影响 `tauri build`，dev 不需要）。改 ID 或换签名会让 TCC 权限全部重置。
- **TCC**：控制其他 app 要"自动化"权限，模拟键盘要"辅助功能"权限。第一版不需要，设置页预留权限状态区。
- **capabilities 白名单**：WebView 能调用的插件能力必须在 `src-tauri/capabilities/` 显式声明。sidecar 由 Rust 直接 spawn，不经 shell 插件，所以不在白名单里。
- **sidecar 生命周期**：壳退出必须杀 sidecar；sidecar 崩溃壳要重拉并发系统通知。

## 安全与隐私

- `.env`、记忆库、任何 token 绝不入库，`.gitignore` 已覆盖。
- 连接器凭证存 macOS 钥匙串，不存明文。
- 核心 API 只监听 `127.0.0.1`。
- 操作分级见 `apps/core/src/agent/permission.ts`：只读放行 / 可逆写记日志 / 不可逆必须确认。第一版只有类型定义。

## 视觉方向：深色仪表盘（B 方案）

- 全局固定深色（不跟随系统）：灰阶为主，`--live`（电光青 #38d6ff）只用于「正在活动」的状态：同步指示点、进度条、思考光环与三点、生成中转圈、引导项选中竖线、需回复标签、输入框聚焦光晕。其余一律灰阶，不要把青色用在静态装饰上。
- 启动器毛玻璃用 `HudWindow` 材质；会话窗深底加 28px 低透明网格。
- 动效克制但有生命感：引导项按 `--i` 错落浮现，窗口高度用 8 步缓动，回复流式时有光标，思考时头像有光环。
- 启动器空闲态底部是仪表式状态带（等宽、大写小字）：slack 下次同步倒计时（来自 `/inbox.nextSyncAt`）、inbox 需回复/总数、todo 数、当前模型。

## 任务中枢与账本（2026-09-07 对齐后的主干）

- 目标形态：Friday 是握着全部上下文的专属 agent，**替用户干活，用户只审核**。一切输入（Slack 线程、Meegle 工单、口头交代、文档链接）汇成 `tasks` 表里的**任务**：collected → understood → processing → review → done（blocked / ignored）。
- 三级权限落地：只读直接做；可逆直接做并记账、可撤销（记待办、更新 people.md）；不可逆挂成任务的 `pending` 动作等用户点「通过并执行」（发 Slack 回复 `slack_reply`、合并分支 `git_merge`）。用户已同意审核通过后由 Friday 发 Slack。
- **账本** `audit` 表：Friday 每个动作一条（action / why / how / evidence / risk / reversible / status / undo）。`GET /audit`，`POST /audit/:id/undo`。账本视图在会话窗「工作台 → 账本」。
- **自主改代码**（`agent/pipeline.ts`）：情境卡建议 run_claude 且能定位项目 → `startAutonomousJob`：Ghostty 里 `claude -p`（`autonomousPrompt`：新分支 friday/<id8>、跑类型检查与测试、界面改动用 agent-browser 截图到 `<runs>/<id>.shots/`、交付报告写到 `<runs>/<id>.report.md`，禁止 push/merge/提问）。任务退出 → `onJobExit` 用 `agent/report.ts` 解析报告与截图（存附件）→ 任务进 review，附 `git_merge` 待审核动作。
- **交付报告**（`DeliveryReport`）是验收的唯一依据：概要、改动、测试过程、测试结果、截图、请你验证。用户明确要求：功能长什么样 + 测试过程，用截图和文本，不要视频。这条对 Friday 派出的任务和改 Friday 本身都适用。
- 接口：`GET /tasks`（板 + 计数）、`POST /tasks`（口头 / 文档）、`POST /tasks/:id/approve/:actionId`、`/reject`（带原因，退回 processing 并作废 pending）、`/done`、`/ignore`。
- 前端：会话窗默认视图是「工作台」（任务板六列 + 任务详情：理解 / 方案 / 进展 / 交付报告 / 等你点头的动作 / 打回 / 在会话里讨论；账本可按任务筛、可撤销）；启动器第一项「工作台」、状态带 `review N`。
- **内嵌终端**（已做）：`settings.terminal` 新增并默认 `embedded`：`launchClaude` 不再 `open` 外部终端，而是 `agent/pty.ts` 用 node-pty 在 PTY 里跑同一份任务脚本（锁 / script 录日志 / Stop hook / 退出回报都不变），输出留 400KB 回放缓冲。接口 `GET /pty/:id/stream`（SSE，先回放再实时）、`POST /pty/:id/{input,resize,kill}`。前端 `views/Terminal.tsx` 用 @xterm/xterm + fit + web-links 渲染在任务详情里（任务 `source.jobId`），可直接打字与 Claude Code 对话。node-pty 的 `spawn-helper` 复制后会丢可执行位，`bundle-core.sh` 里 chmod；esbuild 不打包原生模块，用 `createRequire` 运行时加载。Ghostty / Terminal 仍可在设置里选回。
- **第三块修正**：不是给用户推荐学什么，而是 Friday 自己学——根据用户近期业务主动研究社区的好做法、交互、产品设计（WebSearch/WebFetch），产出针对手头项目的具体建议并沉淀进记忆库（待做）。

## 工作台：线程、功课、首屏

- Slack 消息逐条分类后按人聚合成**线程**（`memory/threads.ts`）：私聊按人、频道 @ 按频道+人，同键 2 小时内接续（`THREAD_GAP_MS`）。`inbox.thread_id` 增量列。
- 每个被新消息触及的线程做功课（`agent/enrich.ts`，只读）：同一人历史线程的情境、`people.md` 里的条目、消息里 Meegle 链接用 `meegle` CLI 拉标题/状态/优先级/负责人、关联项目的 git 状态；然后 `agent/brief.ts` 用 Sonnet 出**情境卡**（situation / needs / needsReply / urgency / reply / actions / context / todo / person），最多 3 个线程并行。
- 可逆自动写（`agent/autowrite.ts`，permission.ts 的 reversible 级）：情境卡给了 todo 就记待办，给了 person 就往 `people.md` 该人条目追加一行「备注（日期，Friday 自动）」；每个线程每类只做一次（`threads.auto_done`），结果写进 context 留痕。
- 通知按线程发「N 个人等你回」。`GET /threads`、`POST /threads/:id/{refresh,done,ignore}`；`slack_inbox` 工具输出线程视角。启动器「Slack 找我的人」是线程卡片（情境、需要你、建议回复、背景、原文折叠、复制回复 / 在会话里处理 / 已处理 / 忽略）。
- **首屏**（`GET /desk`，`agent/desk.ts`）：会话窗空对话不再是介绍文案，而是「Hello {name}！{时段问候}，有什么可以帮你？」+ Sonnet 写的「现在先做什么」（≤5 行，素材没变 10 分钟内用缓存）+ 等你回的人 / 待办 / 进行中任务，带一键动作。名字取 `settings.name`，缺省用 macOS 账户全名（`id -F`），设置页可改；启动器占位符同样问候。

## 附件与链接

- 会话窗支持粘贴图片、拖入文件、📎 选文件：前端读成 base64 `POST /attachments` 存到记忆库目录 `attachments/`（表 `attachments`，单个 20MB 上限，一条消息最多 10 个），`/ask` 带 `attachments: [id]`。`agent/content.ts` 组装 Anthropic 消息内容：png/jpg/gif/webp → image 块，pdf → document 块，文本类（按 mime 或扩展名）→ 内联 text 块（10 万字截断），其他类型只告知文件名。带附件时 `askStream` 走流式输入（一条 `SDKUserMessage`）。用户消息 `payload.attachments` 存元数据，缩略图从 `GET /attachments/:id` 加载（CSP `img-src` 已放行 127.0.0.1）。
- 消息文本里的 URL 由 `Linkified` 变成可点链接（点击 / ⌘点击 都用系统浏览器打开），页面根挂 `LinkMenuHost`：任何 `<a href>` 右键弹「打开链接 / 复制链接」。

## 终端任务（会话 ↔ Ghostty 的关联）

- 每次 run_claude / `POST /run` / 收件「处理」都建一条 `jobs` 记录。启动脚本（`agent/runner.ts`）：`mkdir` 原子锁防 Ghostty 双开 → `script -q <runs>/<id>.log zsh -c 'claude --dangerously-skip-permissions --settings <id>.settings.json <task>'` 录整个终端会话 → 退出后复位终端（关鼠标追踪等）→ `curl POST /jobs/:id/exit {code}` → `exec zsh -il`。
- `--settings` 注入一个 Stop hook（`<id>.hook.sh`，用 sidecar 自己的 node 绝对路径，因为 Ghostty 由 open 拉起没有 nvm PATH），每轮回答结束读 stdin 的 `last_assistant_message` POST 到 `/jobs/:id/message`；错误写 `<id>.hook.log`。
- 退出回报时：状态改 done/failed，若任务带 conversationId 则往会话追加一条 run 消息，并进通知队列「任务结束 · 项目」。
- 前端：会话窗侧栏「任务」面板（运行中 5 秒刷一次）、run 消息下挂任务卡片（状态、耗时、终端里 Claude 最后一轮、聚焦终端、看日志），启动器状态带显示 `jobs N`。会话里有 `jobs_list` 工具。10 秒内同目录同任务的重复启动直接复用（`recentDuplicate`）。
- 做不到：从会话窗往终端里输入指令（需要接管 TTY）。

## 工作台（2026-09-08 重设计）：一屏只回答「现在要我决定什么」

- 起因：用户看六列看板与纵向分组两版都"迷茫、乱、没重点、配色差"，要求先研究再改。研究笔记在记忆库 `research/2026-09-08-工作台配色与层级.md`（Radix/Geist/Linear/Apple HIG/Refactoring UI/Superhuman triage）。
- 设计系统：`styles.css` `:root` 用 Radix Slate 深色 12 级（`--bg-1..5` 底与组件、`--line-1..3` 边框、`--fg-1..4` 四级文字），旧变量名（`--page`/`--card`/`--label-*`）映射到新 token。唯一主按钮 `.b--primary` 近白底深字；青色 `--live` 降饱和只标活动态与焦点；状态只用 `.dot--*` 小圆点（等你决定 amber / 卡住 red / 进行中 cyan / 完成 green）。一种边框、圆角 8，列表用分隔线不套卡片。
- 布局（`views/Chat.tsx` + `views/Board.tsx`）：无顶栏、无常驻侧栏。页头 `.q__head`（可拖动，留红绿灯）右侧只有「问 Friday ⌘N」。主区 = 待我决定队列：`review`/`blocked` 任务按有待审动作 → 优先级 → 等待时长排序，队首展开成 `Focus`（情境 / Friday 的建议 / 通过前请确认 / 测试结果，折叠：交付报告、链接、内嵌终端、这条任务的账；按钮 [通过并执行 ↵][打回][忽略] + 在会话里讨论），其余一行一条 `Row`（需要你：…），点哪条就在原位展开（不提到队首）。Slack 来源的任务右栏列「对方给的链接」（`extractUrls` 从线程原文提取，`<url|标题>`/`&amp;`/`<@U…>` 先由 `decodeSlack` 还原），底部折叠「Slack 原文」逐条可点、可跳 Slack。处理完自动跳下一条（`act` 里状态变了就清 `selectedId`）。「Friday 在做」「最近完成」折叠在下方。
- 侧栏 `.rail` 固定在最左（200px，2026-09-09 起；之前是靠边缘滑出的浮层），`⌘\` 收起 / 展开并记 localStorage `friday:rail`；收起时 `.chat--norail` 让页头和列表给红绿灯留位。项：待我决定（amber 计数）/ Friday 在做 / 全部任务 / 操作记录 / AI 热点，底部问 Friday、状态行。
- 快捷键：`⌘N` 问 Friday（自由对话，见下条）、`⌘⇧N` 直接开新对话、`⌘\` 侧栏、回车 = 队首主动作（输入框 / 抽屉 / 终端聚焦时不触发）。
- **唯一入口是对话（2026-09-08）**：「＋交代一件事」已删，`POST /tasks` 只剩程序化调用。`⌘N` 弹出抽屉进入自由对话模式（不建会话、不跟任务板的 `onFocusChange` 走），第一句发出时 `POST /route`（`agent/route.ts`，Sonnet，只给最近 20 条非生成中会话的标题 + `projects.md` 项目名/别名）判断接旧会话还是新开，规则偏保守默认新建；命中旧会话时抽屉顶部 `.drawer__route` 显示「接着：标题 · 理由」+「其实是新话题」（换新会话把那句重发）。`/ask` 只在 transcript 还在时才带 `resume`（`transcriptPath` 已修成 Claude Code 真实编码：非字母数字全换 `-`）。系统提示改为：涉及改代码先说判断（项目 / 改哪里 / 方案）等用户点头再 `run_claude`，用户明确说“直接做”可跳过。「在会话里讨论」进入的是任务会话，退出自由模式。
- **Friday ↔ 终端双向管道（2026-09-08）**：终端不再脱节。①终端 → Friday：`api/mcp.ts` 在 `POST /mcp/:jobId` 挂最小 MCP（JSON-RPC：initialize / ping / tools/list / tools/call），`runner.ts` 起 claude 时统一 `claudeFlags`：`--settings`（SessionStart + Stop hook）、`--mcp-config <id>.mcp.json`（指回该端点）、`--append-system-prompt`（`prompt.ts` `terminalBridgePrompt`）。工具在 `agent/bridge.ts`：`friday_context`（任务理解/方案/原话/Slack 原文/项目/人物）、`friday_progress`（写 task.progress）、`friday_done` / `friday_blocked`。**任务完不完成由用户说**：交互式终端里这两个工具只表示「这一轮」的结果——任务留在 processing（「Friday 在做」），写 `task.attention`（`review` 这轮做完了等你看 / `blocked` 卡住），Row 的点和 Focus 状态行按 attention 变色（amber / red），等你看的排到组首，通知「这轮做完了，等你看」+ 绑定会话追加 run 消息；用户再给指示（terminal_say、在 PTY 里敲回车）或终端 `friday_progress` 开新一轮时清掉 attention；用户点「标记完成」才 done。只有 Friday 自主派出的 `-p` 任务（`startAutonomousJob` 写 `source.autonomous: true`）friday_done 才直接进 review + friday/ 分支挂 git_merge 待审、friday_blocked 才改 status blocked。交互式终端进程退出也不改任务状态，只记进展。job 没任务时补建。②Friday → 终端：`agent/terminal.ts` 忙不忙直接看 PTY 最近 3 秒有没有输出（`pty.ts` `lastOutputAt`；Claude Code 干活时 spinner 每 100ms 重绘，空闲时静止）——之前用 Stop hook + 输入时序两个方向都漏（xterm 自动应答 Ink 的查询会被当成输入；重开后又全判空闲）。空闲才直接敲，忙则排队、每秒轮询等安静再送，Stop hook 到了也试一次；文本与回车分两次写（间隔 200ms），否则被当成粘贴不提交。会话工具 `terminal_say(text)` 找当前会话绑定任务的 jobId（或 run_claude 从该会话开的 job），只对内嵌 PTY 有效，会往会话追加「→ 已转达给终端：…」run 消息并记账 `terminal_say`。hook 脚本现在回传 `event`/`source`。③Friday 读 transcript：`agent/transcript.ts` 尾读 300KB jsonl，把 assistant 的 text/tool_use（`describeTool` 挑关键参数）和 user 的 tool_result 成败压成动作流；`GET /jobs/:id/activity`、会话工具 `jobs_activity`；任务卡 Focus「终端在做」（`.fx__doing`，processing 时 5 秒拉一次，圆点绿 ✓ / 红 ✗ / 青闪 = 进行中）。系统提示：会话绑着带终端的任务时，“让它…/告诉它…”用 terminal_say 转达，“做到哪了”用 jobs_activity。**会话绑着任务时 `/ask` 每轮把卡片此刻的内容（`api/ask.ts` `taskBlock`：contextFor + 终端状态 + attention + 最近交付）注入系统提示「【当前任务】」，Friday 以它为第一上下文；前端不再把背景拼进第一句。** PTY 输入接口带回车时清 attention。已知：空目录首次进会卡在 Claude Code 的目录信任确认，需要在终端里选 Yes。
- **会话结论回流任务卡 + 发消息前先看原文（2026-09-09）**：会话工具 `task_update`（`agent/taskUpdate.ts` `updateTaskFromChat`）能改状态（用户说“做完了”→ done、“不用管了”→ ignored、“先放着”→ review；收工时清 attention 和待审动作）、理解 / 方案 / 进展、改写或新挂待审的 Slack 回复草稿（`updatePending` 同时改 `detail` 和 `payload.text`）、`dropReply` 撤掉；系统提示要求讨论改了方案或回复就同步。Thread 每轮结束广播 `friday:tasks-changed` 让卡片刷新。待审动作是 `slack_reply` 时主按钮叫「看一眼再发」，点开 `.fx__confirm`：发给谁（私聊 / 原线程）、可编辑的原文、⌘↵「就这么发」/ Esc；`POST /tasks/:id/approve/:actionId` 接受 `{ text }` 覆盖后再执行。有待审动作时旁边还有「完成，不发 / 完成，不执行」（`/done` 清 pending），收工但不外发。`executePending` 失败会把动作放回待审（之前会被吞掉）。状态行显示「卡片更新于」，报告带 `at`。
- **实时推送（2026-09-09）**：`src/bus.ts` 进程内总线，`GET /events`（`api/events.ts`，SSE）把 `tasks`（`createTask`/`updateTask` 后）、`terminal`（`agent/terminal.ts` 每 500ms 对比忙闲，变了才推；`pty.resize` 后 1.5 秒内的重绘不计活动）、`conversation`（`runs.ts` 生成开始 / 结束）推给前端；前端 `lib/events.ts` 转成 `friday:event` / `friday:tasks-changed`，Board 合并终端实时值、200ms 合并拉取，轮询只剩 30 秒兜底。**「通过前请确认」可勾选且落库**（`report.checked`，`POST /tasks/:id/verify`，`bridge.setVerified`）：全部勾完 = 这轮验收通过——记账 `verified_all`；processing 且有终端、无待审动作 → `terminal_say` 让终端继续下一步（提交 / 建 draft MR，做完 friday_done）并清 attention；有待审动作 → 会话里提示点「通过并执行」；`/ask` 的任务块带「验证点已确认 n/N」。**终端弹交互式提问 = 阻塞**：hook 加 `PreToolUse` / `PostToolUse`（matcher `AskUserQuestion|ExitPlanMode`）与 `Notification`（`permission_prompt`），hook 脚本多回传 `toolName / toolInput / message / notificationType`；`bridge.terminalAsking` 把问题整理成一句（`describeQuestion`：问题 + 编号选项 / plan 摘要）→ `attention: question`（红点呼吸）、进展「终端在问：…」、系统通知「终端在等你回答」、会话里留问题原文；前端把它算进「待我决定」并排最前（`needs` 显示「马上回：…」）。`PostToolUse` / 用户回车 / Stop 解除。Friday 的任务块知道终端在等答案，用户说选哪个就 `terminal_say` 敲编号或文字。**终端每轮说完**（Stop hook 带 `text`）→ `bridge.turnFinished`：非自主任务标 `attention: review`、进展换成它说的话、往任务会话追加「终端里的 Claude 这轮说完了：…」（10 秒内刚 friday_done 过的不重复）——用户不用去翻终端。
- **任务标完成 / 忽略时关掉它的终端**（2026-09-10，`terminal.closeTaskTerminal`）：杀 PTY 整个进程组（zsh → script → claude，只 kill PTY 会留孤儿）、`finishJob`、记账 `terminal_closed`；入口 `/done` `/ignore`、`task_update` 的 done / ignored、待审动作全部执行完。不留孤儿 claude 进程和「运行中」的 job。
- **Meegle 工单进任务**（`agent/meegle.ts`）：调度器启动 8 秒后、之后每 15 分钟 `syncMeegleOnce`：`MeegleConnector.fetchWorkItems()`（`mywork todo` + `workitem get --fields priority`）→ 每条分派给我的工单建 `kind: meegle` 任务（`source.meegleId/url`，理解里写节点、状态、优先级、截止），一律 `understood` 排队不占「待我决定」；已有的更新标题/优先级/截止，用户标完成或忽略的不再动；不在分派列表里的自动 done 并记账 `meegle_done`；Friday 里已 done / ignored 但 Meegle 状态含 Reopen 且又在分派列表里的，拉回 `understood` 并记账 `meegle_reopened` + 系统通知（只认 Reopen 状态，用户在 Friday 里主动标完成的不翻回）。项目按标题里出现的项目名/别名（≥3 字）匹配。同时仍写 `todos` 表供会话上下文。`POST /tasks/sync-meegle` 手动触发：左栏「待办」分组头有「↻ Meegle」按钮（同步完显示 +新增 / 重开 / 完成 数，4 秒后消失），会话工具 `meegle_sync` 同一件事；「待我决定」分组头同样有「↻ Slack」（`POST /inbox/sync`）+ 会话工具 `slack_sync`。前端「待办」分组（understood/collected：分派给用户、Friday 没在做、不需要拍板的事）默认展开，按截止日 → 优先级 → 创建时间排序；「Friday 在做」只剩 processing，排在待办之前。Friday 目前不会主动接待办里的工单，待定策略见 2026-09-08 讨论：先由 Friday 判断可做性挂「开工」待审动作。
- **任务 ↔ 会话 ↔ 终端**：「在会话里讨论」新开会话时 `POST /tasks/:id/conversation` 把 `source.conversationId` 记到任务上，再点就是「继续会话」直接 `load` 原会话；`askStream` 收到 `conversationId` 后 `fridayTools(conversationId)` 按会话建 MCP 工具，`run_claude` 先找 `source.conversationId` 相同的任务，找到就把 job 挂上去（`source.jobId`、processing、progress），找不到才新建 code 任务。Focus 里有 jobId 就常显内嵌终端；Row 上有「终端」「会话」小标签。**抽屉跟随当前任务**：Board 的 `onFocusChange` → Chat `syncDrawerToTask`，展开哪条任务抽屉就切到它的会话（没聊过则空着，第一句发出时 `openTaskConversation` 建会话、绑定并把 `taskContext` 拼在前面）；`⌘⇧N` 才脱离任务开自由对话。绑定后前端广播 `friday:tasks-changed` 让任务板立刻刷新。
- **终端性能**：xterm 用 `@xterm/addon-webgl` 渲染（上下文丢失自动退回 DOM），SSE 输出按 `requestAnimationFrame` 合帧后一次 `write`，连上时只回放缓冲尾部 64KB（`REPLAY_TAIL`），`.xterm-host` `contain: strict` 独立合成层。输入仍是每键一个 POST，若还卡再换 WebSocket。
- **终端随 Friday 重启失效后可重开**：PTY 只活在 sidecar 内存里，重启即没。前端 `Terminal` 连不上流时显示「重新打开终端」，`POST /pty/:id/reopen`（`runner.reopenClaude`）在 job 目录起新 PTY 跑 `claude --dangerously-skip-permissions --continue`（接该目录最近的会话，失败则新开），并把旧 `<id>.log` 尾部 60KB 作为回放缓冲先吐出来。
- **主题预设**：`settings.theme`（graphite / warm / navy / light，`THEME_OPTIONS`；light 是 2026-09-09 加的浅色，写死的颜色都已收进 token：`--ok` `--bad` `--shadow-card`），设置页「外观」分段切换，`lib/theme.ts` 把值写到 `<html data-theme>` 并缓存 localStorage 防闪，设置窗改完 `emit("friday://theme")` 广播给工作台即时换色。每个预设只是 `:root[data-theme=…]` 一组变量，布局不动；浅色主题未做。设置页 `.settings` 自身滚动（全局 html/body 是 overflow hidden）。
- 首屏问候用 `settings.name` + 本地时段，不再调 `/desk`（前端 `DeskView` 已删）。
- 验收方式：core `FRIDAY_PORT=7791 FRIDAY_DATA_DIR=<临时目录> FRIDAY_NO_SCHEDULER=1` + `VITE_FRIDAY_PORT=7791 vite --port 1421`，浏览器直开 vite 页面（`coreBaseUrl` 无 Tauri 时回退到本机端口；CORS 放行所有本机 origin），用 agent-browser 截图。

## 会话归任务（2026-09-09）：没有独立的会话抽屉

- 起因：用户"老是对不齐哪个任务对应哪个会话"。根子是任务板、抽屉、终端三个有独立状态、靠两套规则松耦合（抽屉有时跟任务走，⌘N 自由模式又不跟）。换左右边解决不了，所以把抽屉删了，**任务是唯一的锚**。
- `views/Thread.tsx`：一段会话的消息流 + 输入框 + 附件 + 流式跟随，`forwardRef` 暴露 `load / reset / send / focus`；滚动：切会话 / 自己发消息强制落底，用户在底部才跟着新内容滚，往上翻了就不打扰，右下角浮「↓」（有没看到的新回复时变「有新回复 ↓」）；`conversationId` 为 null 时第一句走 `resolve(prompt)` 决定落到哪。空闲时每 8 秒对一次消息（终端里 Claude 的交付 / 卡住会追加进来）。
- **主从布局（2026-09-09）**：用户说展开式看不到哪些任务在跑 / 做完了。Board 的 queue / doing / all 视图改成 `.split`：左栏 `.split__list`（分组：待我决定 / Friday 在做 / 待办 / 最近完成；`all` 按状态分组）每条 `.li` = 状态点（attention 优先）+ 标题两行 + 一句状态（needs / doingRight / queuedRight），左栏排序按活跃度：终端在输出 / Friday 在回的排最前，其次最近更新倒序（待我决定里有待审动作的仍优先）；**关注**（`task.pinned`，`POST /tasks/:id/pin`，条目悬停出 ☆、卡片状态行 ☆ 关注）单独一组放最顶上，默认焦点也先看它。右栏 `.split__detail` 是 flex 列：Focus 的 `.fx` 卡片自己滚动（meta sticky），`.fx__foot` 操作栏在卡片外、钉在右栏底部一直可见（独立一条带边框底色）。左栏条目在终端 busy 或该任务会话生成中（Chat 传 `runningConvs`）时显示青色活动条 `.li__bar`；导航底部有「N 个终端在跑」。旧的 `Row` 组件删了；ledger 视图仍是单列页面。
- **任务卡单列，从上到下按优先级**：标题 → 情境 / 建议 / 报告 → `.fx__talk`「和 Friday 聊这条任务」（`<ChatThread conversationId={task.source.conversationId}>`，高 clamp(300px, 44vh, 480px)，resolve = 新建会话 + `taskBindConversation` + 把 `taskContext(t)` 拼在第一句前）→ 「终端在做」动作流 → **终端默认收起**（`.fx__term-toggle`，标签带终端状态——展开时由 xterm 输出流本地判定（3 秒无输出=空闲），收起时用 `/jobs/:id/activity` 5 秒一拉带回的 `terminal`，最后才是任务板 15 秒的；点开才挂 xterm；「聚焦终端」点过来自动展开）→ 账 → 按钮。用户的心智是「先看 Friday 怎么说，不放心再展开终端自己看」，左右两栏试过被否。「在会话里讨论」按钮删了——讨论一直在卡上。回车 = 主动作在 `.thread` 内不触发。
- **「问 Friday」是一个视图**（`view === "ask"`，侧栏第一项，`⌘N`）：全宽 Thread，`resolve` 走 `POST /route`（接旧 / 新开），命中旧会话时 `.route-hint` 显示「接着：… · 理由」+「其实是新话题」；页头右侧 新对话（`⌘⇧N`）/ Skill / 模型。Esc 回工作台。`openAsk(pending)` 把要做的事排队，Thread 挂上后的 effect 执行（视图切换是异步的）。「会话历史」点一段 → 在这个视图打开。`take_pending_chat` / `friday://open-conversation` 也落到这里。
- 已删：`.drawer*` 全部 CSS、`syncDrawerToTask`、free 模式标志、`Board.onDiscuss`。「聚焦终端」仍是 `friday:focus-job` → 切回队列 → 选中任务 → xterm 聚焦。

## 窗口形态（2026-09-07 晚重排）：只有工作台

- 启动器（Raycast 式浮窗）已删除。热键 `⌘⇧Space`、托盘左键、启动台再点、Reopen 都指向唯一的**工作台窗口**（label `chat`，普通 macOS 窗口，Overlay 标题栏，1180×760）；工作台开着且聚焦时按热键隐藏。应用启动即打开工作台。
- 右上角「问 Friday」（`⌘N`）拉出右侧 440px 抽屉承载对话：最近对话下拉、新对话（`⌘⇧N`）、Skill、模型、消息流、输入框（附件粘贴/拖入）。会话历史不再是主体，用户明确"不在意曾经和 Friday 说过什么"。顶部标签与首屏横幅已被 2026-09-08 的队列式工作台取代。
- 任务详情「在会话里讨论」和首屏「处理」都会打开抽屉并带上下文开新对话。

## 历史：启动器与会话窗（已废弃，仅供理解旧代码）

- **启动器**（窗口 `main`，透明毛玻璃、置顶、失焦即收）只做一次性动作：空闲态是输入框 + 引导面板（AI 热点 / 待办 / 记一条待办 / 跑项目 / 打开会话窗 / 设置，↑↓ 选、回车执行）+ 一行状态；结果就地显示，`Esc` 清空再 `Esc` 收起。每次呼出都是干净的。
- **会话窗**（窗口 `chat`，普通 macOS 窗口，可拖可缩放，`tauri-plugin-window-state` 记位置）承载多轮对话：左侧会话列表 + 「今天」侧栏开关，中间消息流 + 底部输入框，右侧可展开「AI 热点」面板（同 `/hot`，可重新拉取）。`⌘N` 新对话，`⌘W` 关窗。
- **进入会话**：启动器里 `⌘↵` 直接带着问题开会话窗；或者一问一答后再输入，视为追问，整段搬进会话窗继续。启动器每次呼出会为本次动作懒建一个 conversation，搬过去时沿用它的 id。
- 会话窗开着时应用切到 `ActivationPolicy::Regular`（有 Dock 图标、可 `⌘Tab`），关掉后回到 Accessory。热键在会话窗可见但未聚焦时优先聚焦它，否则切换启动器。
- 会话窗刚创建时前端还没就位，`open_chat` 把参数放进 `PendingChat` 状态，前端 mount 后调 `take_pending_chat` 取；已存在的窗口走 `friday://open-conversation` 事件。
- 生成是后台任务（`agent/runs.ts`）：`POST /ask` 启动任务并订阅 SSE，客户端断开只取消订阅，任务继续跑完落库；`GET /ask/stream?conversationId=` 重新订阅（先回放已生成部分），`POST /ask/cancel` 才真正中断。会话接口带 `running` / `partial`，侧栏对生成中的会话显示转圈；多个会话可并行。
- `/ask` 多轮靠 Agent SDK `resume` 续同一个 Claude 会话（`persistSession: true`），`conversations.claude_session_id` 记会话 id。内置工具全部禁用（`tools: []`），只挂 `agent/tools.ts` 里进程内 MCP 工具：`memory_read` / `memory_write`（记忆库三个 markdown 整篇读写）、`todo_add`，通过 `allowedTools` 自动放行，`maxTurns: 8`。用户在对话里说"给 X 加别名 / 登记项目 / 记决策 / 记待办"由 Claude 自己调工具完成。系统提示注入记忆库全文（`memory/context.ts`），并明确除此之外没有工具，防止它假装执行命令。
- 设置页有「记忆库」一组，内置编辑器直接改三个 markdown（`GET/PUT /memory/:name`，`⌘S` 保存），保存即生效。
- **Skill 模式**（`settings.skills`，默认开，设置页与会话窗标题栏 Skill 胶囊可切）：开着时 `/ask` 用 `settingSources: ["user"]` 读用户 `~/.claude` 的 skill，内置工具放行 `Skill / Bash / Read / Glob / Grep`（不开 Edit / Write，改代码仍走 run_claude），`permissionMode: "bypassPermissions"` + `allowDangerouslySkipPermissions`（用户明确要求），`maxTurns: 30`。关着时回到隔离模式只有 Friday 自己的 MCP 工具。skill 文档重，一问可到 $1+，建议 Skill 模式配 Sonnet。
- 流式输出里 Claude 调工具前的碎话（"我先查一下"）不该留在会话里：`askStream` 在 `tool_use` 块开始时发 `{type:"reset"}`，前端清草稿、core 清 answer，最终只落最后一段文字。不展示过程文案，忙碌时只有细进度条 / 小转圈；简报的待办折叠成「N 条待办 ›」。

## 浮窗命令约定

- 直接输入 → `POST /ask`（SSE 流式）。
- `记 …` 或 `/note …` → `POST /note`。
- `/hot`、`热点` → `GET /hot`：并行拉 Hacker News（AI 关键词过滤 top 60）、Hugging Face Daily Papers、OpenAI 博客 RSS、Simon Willison Atom、量子位 RSS，只留 48 小时内的，去重后交给 Claude 挑最多 10 条并写中文标题/摘要（输出 JSON，链接按序号回填，Claude 不碰 URL），内存缓存 1 小时，`?refresh=1` 强刷。Anthropic 官网无 RSS，机器之心 RSS 已失效，不要再加回来。源定义在 `connectors/news.ts`。
- `/todos`、`待办` → `GET /todos?sync=1`：同步 Meegle 后返回未完成待办，不经 Claude。
- `跑 <项目> [任务]` 或 `/run <项目> [任务]` → `POST /run`：按 `projects.md` 解析项目，生成 `<dataDir>/runs/<id>.sh`，`open -na Ghostty --args --working-directory=… -e 脚本`。脚本用 `whence -p claude` 拿到的绝对路径并显式加 `--dangerously-skip-permissions`（Friday 只是透传用户指令，权限策略与用户平时用 claude 一致）；Claude 退出后留一个交互 shell。
- `Esc` 关闭（生成中则中断），`⌘,` 打开设置。
- 呼出热键默认 `⌘⇧Space`（`⌥Space` 被 Raycast 占用，`⌃Space` 被输入法占用），可在记忆库目录 `settings.json` 里写 `{"hotkey": "..."}` 覆盖。

## settings.json（记忆库目录下，可选）

```json
{ "hotkey": "CmdOrCtrl+Shift+Space", "terminal": "ghostty", "model": "claude-sonnet-5" }
```

壳只读 `hotkey`；core 读写 `terminal`（`ghostty` | `terminal`）和 `model`（空串 = 跟随 Claude Code 默认，候选见 `packages/shared` 的 `MODEL_OPTIONS`），`PUT /settings` 写回时保留其他键。模型对 `/ask` 与 `/hot` 全局生效，设置页和会话窗标题栏都能切。

## 打包

```
pnpm --filter @friday/desktop tauri build      # 产物 apps/desktop/src-tauri/target/release/bundle/macos/Friday.app
```

`beforeBuildCommand` 会跑 `scripts/bundle-core.sh`：tsup 构建 core，`pnpm deploy --prod` 到 `src-tauri/resources/core`（hoisted 布局，237MB，大头是 Agent SDK 自带的 Claude Code 二进制），Tauri 打进 `Contents/Resources/core`，release 模式下壳用 `node dist/index.js` 拉起。签名身份写死 `Friday Dev`，没建证书时用 `APPLE_SIGNING_IDENTITY=- pnpm --filter @friday/desktop tauri build` 临时 ad-hoc 签。只出 `.app`，不出 DMG（bundle_dmg.sh 需要 Finder 自动化权限）。

## 开发命令

```
pnpm install
pnpm dev          # tauri dev，会一起拉起 vite 与 sidecar
pnpm dev:core     # 只跑 sidecar，curl http://127.0.0.1:7788/health
pnpm typecheck
pnpm test
```

Rust 工具链在 `~/.cargo/bin`，新 shell 需要 `source ~/.cargo/env`。

## 提交约定

提交信息用中文，每完成一个功能点提交一次。git author 用 `lys.haoranjing@gmail.com`。
