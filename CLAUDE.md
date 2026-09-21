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
第三版（已完成，2026-09-21 重做）：Slack 关联源——见下文「Slack：关联源」一节。原「Slack 收件」那套（triage 分类 → 按人聚合线程 → 情境卡 → 起草回复 → 置信度闸门 → 经验闭环）已整体删除，约 1667 行。
未做：项目智能匹配、自动更新、内嵌 node、Slack 发送。结构预留位置即可，不要提前实现。

## Slack：关联源（2026-09-21 重做）

**定位**：Friday 不替代 Slack，你照旧在 Slack 里看和回。Slack 在 Friday 里只是「关联源」——把对话挂到你已有的任务上，让四端（Slack / Meegle / 终端 / 浏览器）彼此知道对方的存在。

**为什么推翻第三版**：那套围着「Friday 起草、你审」建，而这个前提你 2026-09-17 就否了（草稿不可用、重复建任务、待办抽象不对）。库里 `lessons` 与 `thresholds` 从投产起一条没有，情境卡每天花一块多算出来没人看，前端早已零入口。

- **只挂靠，不评判**。消息进来只做三件事：`connectors/noise.ts` 挡噪音 → `agent/slack/attach.ts` 挂靠 → 带疑问信号的过一道查询分类。不判断要不要回、不起草、不自建任务、不发通知。
- **挂靠复用 `links` 表**（`memory/links.ts`），没有新建表。两级硬信号零模型调用：①消息里的 Meegle 工单号（`memory/infer.ts` 的 `meegleIdsIn`）②同人同频道 48 小时内挂过的任务。都没中且有候选才问一次 Haiku，记成 `guess` 边。`user > rule > guess` 只升不降，`unlink` 写否决边且自动推断不会再连回来——「纠正以后不能再错」落在这里，不需要额外的映射表。
- **对话单位是 Slack 原生粒度**：有 `thread_ts` 的整个 thread 算一段，否则单条算一段。键 `channelId:thread_ts|ts`，`conversationKey` 在 `packages/shared` 前后端共用。
- **唯一的起草场景**：私聊或 @ 我、且带疑问信号（`？?` / 怎么 / 哪里 / 为什么 / 能不能 / 是不是 / 有没有）的消息，`agent/slack/query.ts` 判一句「读代码就能答吗 + 哪个项目」，是就 `startQueryJob` **在后台**起一个**只读**的 `claude -p` 去查。产出 `## 概要 / ## 依据（文件:行号）/ ## 回复草稿`，任务进 review 挂 `slack_reply` 待审。
- **后台跑，不弹窗口**（你明确要求：主动点的时候才弹出来）。所以不走 `launchClaude`（那条必然 `osascript` + `activate` 抢前台），而是直接 `spawn` 子进程、输出落 `<runs>/<id>.log`、退出时自己回调 `onJobExit`。想看就点任务卡的「打开终端看」，走 `reopenTerminal` 用 `--resume` 接回同一会话，并把 `readonly` 透传回去。
- **只读靠 PreToolUse hook**，不能靠 settings 的 `permissions.deny`——`--dangerously-skip-permissions` 会让它完全失效（实测过），而原有的 Bash 守卫 matcher 只认 `Bash`。`buildHookSettings(hook, guard, readOnly)` 多挂一条 matcher 为 `Edit|Write|MultiEdit|NotebookEdit` 的 deny。隔离验收实锤过：用同一份 settings 手工起 `claude -p` 要求改文件，Write 被拒、目标文件未变。
- **「这是不是查询任务」统一用 `isQueryTask(source)`**（`packages/shared`，判据是 `headless && conversation`）。别单看 `kind` 或 `conversation`：HUD「建成任务」落成的 `verbal` 任务也带 `conversation`，`onJobExit` 和 `settleQueryTasks` 都因此误判过。
- **消息状态以 Slack 为准**：每轮同步扫一遍已读已回，命中的对话上挂着的查询任务自动 done、草稿撤下、记一条 `slack_settled_by_user`。只是挂靠在别的任务上的不动它。这是「已处理的事又冒出来」的根治点。
- **建任务只有两个入口**（Friday 自己不建，查询任务除外）：HUD 的「建成任务」、任务卡的「并入这段对话」。
- **界面**：任务卡「Slack 里的讨论」按时间列挂着的对话，`guess` 的标「Friday 推断」并显示那条 `why`（判断依据要能核对）；HUD 在 Slack 前台时给三个零模型调用的动作（帮我查这个 / 建成任务 / 挂到…）。工作台不新增任何 Slack 列表。
- **HUD 认当前会话靠窗口标题，解析踩过四种形态（2026-09-21 真机逐个补齐）**：①中文界面的频道不带 `#`，跟一个全角「（频道）」标记 ②有未读时标记后面还会插段（`一起养牛（频道） - Longbridge - 1 个新项目 - Slack`），所以**不能按结尾匹配，要直接找「（频道）」这个标记，它前面那截就是频道名** ③人名普遍带英文后缀（`拂晓 (Chen Xiaofu)`），而带未读数时只剩中文名，两边都要剥括号再比 ④左侧那些视图（活动 / 私信 / 文件…）会整个占掉标题，得挡掉否则 Friday 会去找一个叫「活动」的同事。另外**「活动」视图里点开的全屏 thread 读不到频道名**（标题只有「活动」，频道只在界面元素里，Electron 应用的辅助功能接口读不到，Slack 菜单里也没有复制链接命令）——这种视图下 HUD 认不出会话，只能先点回频道。
- **频道挂靠**：`proj-` / 需求名频道本身就约等于需求标题，但实测 13 个频道只有 2 个能字面对上（`一起养牛` 对不上 `养牛计划1.0`）。所以三层：字面够像（`MIN_OVERLAP = 6`，实测 7 字要中、3 字巧合要挡）→ 模型兜底 → 你手动登记一次写成 `user` 边永久生效。这些频道里的消息几乎不带工单号（`#一起养牛` 16 条只有 1 条），现有硬信号在这儿本来就失效。
- **频道实时消息**：常驻群（如 `#team-fe-bo`）从没 @ 过你，本地收件箱零条，呼出时什么都不知道。改成实时拉：`search.messages` 带 `in:#频道名`，一次拿到频道 ID 和最近 10 条。**你们是 Enterprise Grid，`users.conversations` 和 `conversations.list` 都报 `enterprise_is_restricted`，只有 search 这条路通**。2.5 秒超时不阻塞呼出，私聊不拉。搜索接口返回的是账号名（`jiacheng.zhou`），拿收件箱 + `people.md` 当花名册换成显示名（`佳成 (Zhou Jiacheng)`）——只读收件箱不够，同组同事天天说话却从没 @ 过你。
- **接口**：`POST /slack/:conv/attach`（写 user 边）、`DELETE /slack/:conv/attach/:taskId`（unlink，自动写否决边）、`POST /slack/:conv/query`、`POST /slack/:conv/task`。
- **成本**：多数消息零模型调用，Haiku 只在硬信号全没中且有候选时跑一次。对比重做前每天约 $1.5 的 triage + brief + continuation。用量面板 label 为 `attach` / `query`。
- **已知边界**：老消息没有 `prior`（前文）补不回来；否决的粒度是对话键而非「人+频道」，同人后续新对话仍可命中同一任务；`CONV_SCAN_LIMIT = 500`，超过这个数更早的消息聚不回任务卡。

## 从 Claude Code 历史学（2026-09-15）

冷启动问题：Friday 的经验闭环（lessons / playbooks）只能等用户一次次干预慢慢攒，而用户在 Claude Code 里已经说过几百条约定了。实测近 30 天 673 个会话里有 2244 条用户原话，本地预筛出 322 条带纠正信号的（17.5 万字符），全量提炼约 $0.6——**大头不是模型钱，是别学错**。

- **取料** `agent/history.ts`：扫 `~/.claude/projects/**/*.jsonl`，只取 `type: "user"` 且 `isMeta`/`isSidechain` 都不为真的文本块（sidechain 是 subagent 的 prompt，不是用户说的）。预筛正则只用来把两千条缩到三百条，「这算不算可复用约定」交给模型——正则判不了「改成 No photo yet」是一次性文案还是长期口径。
- **项目归属看 jsonl 自带的 `cwd`**，不要反解目录名（`whale-console` 里的连字符和路径分隔符编码后长得一样，解不回来）。先对 `projects.md` 的 `- 目录：` 做前缀匹配（仓库内 worktree 天然覆盖，嵌套取最深），不中再看路径段里有没有项目名——**orca 把 worktree 放在 `~/orca/workspaces/<仓库>/<分支>`，跟项目目录毫无关系，实测 6 条 fe-wealth-admin 的原话全被丢进「通用」**。
- **挡掉 Friday 自己写的 prompt**（`isOwnPrompt`）：`cwd` 在记忆库目录下的会话是 Friday 自己调 Claude（情境卡、intake、提炼），那些"用户消息"是它自己写的。实测混进来 3 条（「这之前，与千一的私聊里聊的是…」「工单信息：Meegle Defect #…」），学回来是自我强化的回音室。
- **提炼** `agent/handbook.ts`：按项目分批喂 Sonnet，**每条规则必须跟一行 `>` 开头的原话出处**——手册里一条「member_id 一律用 string」没有出处，用户就没法判断是不是模型编的（同「证据优先」）。已有手册一起喂进去要求**重写整份而不是追加**，否则跑十周变成一百条流水账，新旧口径并存等于没学。输出 JSON：`handbook` / `decisions` / `people` / `aliases`，解析层对越界字段一律钳掉。历史原文过 `untrusted()`（里面混着 Slack 原文和网页抓取）。
- **不直接写记忆库**：提炼结果建一条 `kind: "handbook"` 的 review 任务（`plan` 是分项目的草稿全文），挂 `handbook_apply` 待审动作，用户点「通过并执行」才落盘 → `handbooks/<项目>.md`、追加 `decisions.md` / `people.md`、`addProjectHints` 补别名。整个 apply 记一条账，`undo: restore_memory` 存 apply 前的快照整体还原（手册是覆盖写的，逐条撤销没意义）。
- **注入**：`autonomousPrompt` 内联该项目手册 + `_global`（各截 1500 字，`memory/handbooks.ts` 的 `handbookBlock`；放在 memory 层是为了不让 runner 把整条提炼链路拖进来）。会话的 `friday()` **不内联**，只说一句「handbooks/ 下有这几份，需要时 `memory_read handbook:<项目名>`」——不破坏记忆库瘦身那 46%。
- **节奏**：一条代码路径，游标为空扫近 30 天（冷启动），有水位从水位往后扫。`historyDue` 跟 `learnDue` 一个思路，只看离上次跑过了多久（存 `sync_state` 的 `history:ran`，重启不丢），每周一轮；候选不足 8 条不弹，但照样推进「跑过」时间，否则每半小时重扫同一批。
- 入口：`POST /tasks/learn-history`、会话工具 `learn_history`、设置页「项目手册」分组的「现在学一轮」；开关 `settings.learnHistory`（默认开）。手册在设置页可直接编辑（`GET/PUT /handbooks/:slug`，只放行已存在的文件名），学错了删掉那一行就行。

## 自主任务在 worktree 里跑（2026-09-15）

原来 `startAutonomousJob` 直接在项目主目录里 `claude -p` 建分支改代码，两个后果：占着主仓（用户没法同时在那儿干活）、`worktreeDirt()` 要求主仓干净才肯开工，用户手上有未提交改动时 Friday 直接 blocked。

- 开工前 `git worktree add --detach <项目>/.claude/worktrees/friday-<id8>`（`git.ts` 的 `fridayWorktree` / `addWorktree`），`launchClaude` 的 cwd 指到那儿。位置跟 Claude Code 客户端一致，用完即删，不混进 orca 的 workspace 列表。**用 `--detach` 不预建分支**——分支名仍由终端里的 Claude 按项目规范自己起（它有完整上下文，Friday 做中文 slug 会变乱码），提示词第一条改成「你已经在一个 worktree 里（detached），先 `git switch -c <分支名>`」。
- `worktreeDirt()` 只剩「得是个 git 仓库」这一条。主仓脏不脏跟 Friday 无关了，这正是用 worktree 的意义。
- **清理**（`cleanupTaskWorktree`）：目录一律删（只是个检出），**分支只用 `git branch -d` 删**——没合并的 git 会拒绝，那是安全阀不是错误：被忽略的任务里可能有还想捡回来的改动，那个决定归用户，账本 `worktree_removed` 里写明分支留着了。出口三处：`git_merge` 执行成功后（合完再收，这时 `-d` 才删得掉）、`/tasks/:id/done`、`/tasks/:id/ignore`，以及会话里 `task_update` 说收工。
- **顺带修了一个一直没被发现的 bug**：`getTaskByJob` 读 `task.source.dir`，而 `TaskSource` 根本没有 `dir` 字段，一直拿到空串 → `currentBranchSync("")` 返回空 → **`git_merge` 待审动作从来没挂上过**。现在 `TaskSource` 加了 `repoDir`（主仓）和 `worktree`（Friday 开的那个），分支名去 worktree 读，合并在主仓做（分支正被 worktree 检出着，在 worktree 里 merge 不了）。

## 终端：外部 Ghostty（2026-09-20 改）

内嵌 PTY 那套（node-pty + xterm + SSE 流 + 重开机制）整体删掉，开工一律弹 Ghostty 窗口。

- **为什么能删干净**：Ghostty 自带 AppleScript 接口（`input text` / `send key` / `focus` / `close`），走的是 app 自己的脚本接口而不是模拟键盘，所以只要「自动化」权限、不要「辅助功能」。`terminal_say` 因此原样保留。
- `agent/ghostty.ts`：开窗口 / 注入文本 / 聚焦 / 关闭 / 存活检查。**认窗口一律用 terminal id**（开窗口时拿到，存 `jobs.ghostty_id`）——标题不能用，Claude Code 自己会改。
- **两个坑**：①Ghostty 的 `command` 属性按 shell 规则拆词，脚本路径里的「Application Support」不加引号会被拆成两段，**窗口开出来但脚本没跑、随即关闭**（现象极像开窗口失败）；②`setGhosttyId` 必须等 `createJob` 之后再调，原来放在 `launchClaude` 里 UPDATE 落空，`ghostty_id` 一直是空的。所以 `launchClaude` 改成把 id 返回给调用方。
- **忙闲判断**从「PTY 最近 3 秒有没有输出」换成 Stop hook（外部窗口读不到输出流）。判不准就直接发——Claude Code 忙时输入进它自己的缓冲区不会丢，比攒在 Friday 这边等一个可能不来的信号好。`say` 因此不再有 `queued`，发之前先 `isAlive` 问一句窗口还在不在，免得谎报「已转达」。
- **连带删掉**：`userTyped`（靠「每键一个 POST」，外部窗口拿不到击键，relay 经验链路自然失效；它带走的 `clearAttention` 交给 Stop hook）、`reopenClaude`（为「PTY 随 sidecar 重启就没」做的，外部窗口没这问题）、`pendingCount` / `resetTerminalState`（本来就是死代码）。`cleanEnv` 搬到 `agent/env.ts`——它在 `pty.ts` 里但外部终端也要用，直接删 `pty.ts` 会误伤。
- **已知**：`close` 关掉的是 Claude Code 那层，脚本末尾 `exec zsh -il` 留下的交互 shell 壳还在（窗口标题还挂着）。

## 安全护栏

- 外部文本（Slack 原文、Meegle 条目、历史情境卡、few-shot 范例）进任何 prompt 前一律过 `agent/fence.ts` 的 `untrusted(source, text)`，system 里声明定界符内是数据不是指令，并剥掉正文里伪造的闭合标签。
- 自主任务（无人看着的 `claude -p`）：`agent/guard.ts` 的黑名单经 PreToolUse hook 拦 push / merge / rebase / `reset --hard` / `checkout main` / sudo / `rm -rf` 根目录，正则允许 `git -C <dir>` 这类全局选项插在子命令前。**`--dangerously-skip-permissions` 会让 settings 里的 `permissions.deny` 完全失效（实测过），所以护栏必须走 hook**。交互式终端不挂这个守卫。
- 自主任务开工前 `worktreeDirt()` 体检，工作区不干净就不开工，任务标 `blocked` 并列出是哪几个文件。

## macOS 坑

- **PATH**：Finder / 自启拉起的 app PATH 极简。壳启动 sidecar 前先用 `zsh -ilc 'echo $PATH'` 取真实 PATH 注入子进程环境；找 `node`、`claude` 都靠它。
- **bundle ID** 固定 `com.haoran.friday`，签名用本机自签证书 `Friday Dev`（首次 `scripts/make-signing-cert.sh` 生成，只影响 `tauri build`，dev 不需要）。改 ID 或换签名会让 TCC 权限全部重置。
- **TCC 权限**：控制其他 app 要「自动化」，读窗口标题 / 选中文字要「辅助功能」，兜底截图要「屏幕录制」。
- **重装 .app 后辅助功能权限会失效（2026-09-21 踩过，排查了四轮）**：自签名（`TeamIdentifier=not set`）的 app 每次重新 build 替换，macOS 都可能把它从辅助功能列表里踢掉，**而且面板上看着还是勾选状态**。后果隐蔽——`snapshot.rs` 的 `front_window_title` 在无权限时返回**空字符串**而不是报错，于是呼出模式拿不到窗口标题、`slackScene` 查不到任何东西、场景上下文为空，模型只好拿记忆库里的全局待办硬凑，表现为「HUD 答非所问」，看起来像模型或提示词的问题。
  - **一眼定位**：`<dataDir>/logs/core.log` 里每次呼出都有一行 `[summon] Slack 标题="…" 权限(辅助/自动化/录屏)=√√×`。标题空 + 辅助 × 就是这个坑，不用再怀疑解析和模型。
  - **修**：系统设置 → 隐私与安全性 → 辅助功能，把 Friday **关掉再打开**（只看着是开的不算，要切一次），然后**重启 Friday**（TCC 状态在进程启动时才重新读）。
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
- **记待办统一建成任务（2026-09-14，`memory/noteTask.ts`）**：用户让 Friday 记了六条待办，左栏没有任何变化——`todo_add` 写的是 `todos` 表，而左栏「待办」分组读的是 `tasks` 表里 `understood` 的任务，两者毫无关系。`todos` 是旧启动器时代的遗留，启动器删掉后写入端还在（`todo_add` / `POST /note` / 情境卡的自动待办），读取端一个不剩（`TodoList` 组件已无人引用），库里攒了 85 条从没露过面的待办。改成一律走 `addNoteTask` 进 `tasks`（`kind: verbal`，界面本来就显示「口头」「Meegle」这些来源标识），`createTask` 自带 `publish` 所以 UI 刷新顺带解决。启动时 `migrateLocalTodos` 把**最近一天**的旧待办补成任务、去重、搬完标 done 不重复搬；更早的留在表里不动，免得几十条陈年内容一次涌进左栏把真在办的事淹掉。
  **autowrite 的待办不能用 `threadId` 做 source**：线程本身那条任务就是靠 `findTaskBySource(threadId)` 找回来的，再挂一条同 `threadId` 的会让它匹配到哪条变得不确定，改用 `source.fromTaskId` 关联。撤销从删 todo 行改成标 `ignored` 保留痕迹（`undo.kind: drop_note_task`），旧账本里的 `delete_todo` 仍能撤。`todos` 表只剩 Meegle 同步和 `/todos` 接口用。
- 三级权限落地：只读直接做；可逆直接做并记账、可撤销（记待办、更新 people.md）；不可逆挂成任务的 `pending` 动作等用户点「通过并执行」（发 Slack 回复 `slack_reply`、合并分支 `git_merge`）。用户已同意审核通过后由 Friday 发 Slack。
- **账本** `audit` 表：Friday 每个动作一条（action / why / how / evidence / risk / reversible / status / undo）。`GET /audit`，`POST /audit/:id/undo`。账本视图在会话窗「工作台 → 账本」。
- **自主改代码**（`agent/pipeline.ts`）：情境卡建议 run_claude 且能定位项目 → `startAutonomousJob`：Ghostty 里 `claude -p`（`autonomousPrompt`：新分支 friday/<id8>、跑类型检查与测试、界面改动用 agent-browser 截图到 `<runs>/<id>.shots/`、交付报告写到 `<runs>/<id>.report.md`，禁止 push/merge/提问）。任务退出 → `onJobExit` 用 `agent/report.ts` 解析报告与截图（存附件）→ 任务进 review，附 `git_merge` 待审核动作。
- **分支名按项目规范起（2026-09-14）**：原来自主任务写死 `friday/<jobId 前 8 位>`，用户指出这不对——项目有自己的分支命名规范（`~/.claude/skills/harua-dev`：新功能 `feat/<topic>`、修缺陷 `fix/<bug>`、杂活 `chore/<topic>` 或 `style/<topic>`）。改成**让终端里的 Claude 自己起名**：它有完整上下文（任务标题多是中文，Friday 这边做 slug 会变成乱码，而且它才知道这次算 feat 还是 fix）。`autonomousPrompt` 给规则和例子（`feat/export-center`、`fix/withdrawal-rule-tabs`），并要求起好后第一时间用 `friday_progress` 把分支名回报。
  配套改了三处判据：`onJobExit` 不再拼分支名，改用 `git.currentBranchSync(dir)` 读实际值，读不到或在 main/master 上就不挂 `git_merge` 待审动作（免得挂个假的）；`bridge.friday_done` 里「是不是 `friday/` 开头」的判断换成「不是主干就算功能分支」；`prompt.ts` 的系统提示同步。
- **交付报告**（`DeliveryReport`）是验收的唯一依据：概要、改动、测试过程、测试结果、截图、请你验证。用户明确要求：功能长什么样 + 测试过程，用截图和文本，不要视频。这条对 Friday 派出的任务和改 Friday 本身都适用。
- 接口：`GET /tasks`（板 + 计数）、`POST /tasks`（口头 / 文档）、`POST /tasks/:id/approve/:actionId`、`/reject`（带原因，退回 processing 并作废 pending）、`/done`、`/ignore`。
- 前端：会话窗默认视图是「工作台」（任务板六列 + 任务详情：理解 / 方案 / 进展 / 交付报告 / 等你点头的动作 / 打回 / 在会话里讨论；账本可按任务筛、可撤销）；启动器第一项「工作台」、状态带 `review N`。
- **内嵌终端**（2026-09-11 做，2026-09-20 已删）：曾用 node-pty 在 sidecar 里跑 PTY、前端 xterm 渲染在任务卡里。现在一律外部 Ghostty，见上文「终端：外部 Ghostty」。
- 历史遗留：`research/*.md` 笔记与库里已有的 `kind: learn` 任务不动，`readResearchNote` 搬到 `memory/research.ts`，任务卡照样能展开笔记。

## 收件前的处理（噪音过滤与补拉前文）

> 这一节原名「工作台：线程、功课、首屏」，线程聚合 / 情境卡 / 灰区语义归并那套已随 2026-09-21 的 Slack 重做删除，见上文「Slack：关联源」。下面三条是仍在用的部分。

- **收件前挡噪音（2026-09-14，`connectors/noise.ts`）**：248 条历史收件里 21 条（8.5%）没有信息量——日历/IT 工单的空消息、`:ok_hand:` 纯表情、只 @ 一下没写字、「好」「ok」「哈哈哈」这类应答。空消息尤其有害：Friday 没有可依据的内容只能猜，之前那条「内容好像没显示出来」的错误草稿就是这么来的。挡掉的**不入库、用户完全看不到**，所以规则只认客观特征：去掉 @ 和 emoji 后一个字都不剩，或整句完全等于固定应答词（`ACK` 白名单，不做「短于 N 字就算」——「改好了」「没问题」也短但是结论）。链接保留占位符，「只发了个文档链接」是有信息的。判不准的一律放行。游标照常推进，否则挡掉的下次同步会重新捞一遍。
  **按 @ 人数挡群发广播试过但放弃了**：拿库里历史数据一验，@ 六人以上的消息里要回的 6 条、不用回的 10 条，挡掉会误杀六件真事。
  **顺序要紧**（与另一条并行任务合并后的最终形态）：先 `isBot` 挡机器人 → 再 `blocksText` 取 Block Kit 正文 → 最后拿**取出来的正文**判噪音。原来直接 `classifyNoise(m.text)` 有缺陷：Block Kit 消息的 `text` 恒为空，真事会被当空消息挡掉。

- **补拉对话上下文（2026-09-14，`connectors/slack.ts` `fetchContext`）**：收件箱里存的是「@ 到我的那一条」，而 `search.messages` 只返回这一条——**真正说明是什么事的前文以前从来没被拉过**。库里的实证：「你看看志华遗留的这个问题」27 字、「晚一点吧，准备发UAT」26 字、「你搜这个关键词：in_quick_entry」37 字，全是指代句。`brief.ts` 里那句「不要写你自己的能力限制（比如无权限读 thread）」正是在盖这个洞——模型本来一直在抱怨读不到 thread，被提示词按住了。
  做法：消息在 thread 里（`inbox.thread_ts` 增量列，从 `search.messages` / `conversations.history` 的 `thread_ts` 取，等于自身 ts 的是根消息不算回复）就 `conversations.replies` 拉整个 thread；否则 `conversations.history` 带 `latest` + `inclusive` 拉它前面 `CONTEXT_LIMIT`（10）条。**按 `subtype` 过滤系统消息**——真实 API 跑出来第一版混进了 `has joined the channel`，4 条前文里 2 条是噪音，挤掉了真正有用的内容。拉不到就返回空数组，不让整条消息的处理失败。
  现在这份前文喂给三处：①挂靠判断（`attachPrompt` 的「这之前聊的是」）②查询分类（`queryPrompt` 同名段）③落库进 `inbox.prior`，任务卡上「这之前聊的是什么 N 条」折叠显示。**前文和主消息一样要过 `untrusted()`**——它同样来自 Slack，2026-09-21 补围栏测试时发现这两处原本是裸拼的。
  **边界**：`thread_ts` 是这次才加的列，**老消息补不回来**，只有新进来的消息吃得到这个能力。

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
- **关终端（2026-09-14）**：用户看到状态行「18 个终端在跑」。查下来 18 个里 12 个的任务已 done、1 个已 ignored——**不是关终端的逻辑没跑，是重启后的僵尸没人收**：PTY 只活在 sidecar 内存里，进程重启后数据库里还标着 running 的必然已经死了，越攒越多。三件事：
  ① **启动收尸**（`memory/jobs.ts` `reapStaleJobs`，`index.ts` 里 `initMemory()` 之后调）：把所有 running 的 job 标成 done（exit_code -1），打一行日志。实测一次清掉 18 个。
  ② **手动关**：`closeTaskTerminal` 抽出底层的 `closeJobTerminal(jobId, why, taskId?)`（手动关时任务不一定还在，taskId 可选）。接口 `POST /jobs/:id/close` 关单个、`POST /jobs/close-all` 关全部（body `{onlyFinished: true}` 只关任务已 done/ignored 的）。**返回值语义保持不变**：`closeJobTerminal` 的 true 表示「真的杀掉了一个活进程」，job 收尾不算——接口自己按 job 状态统计处理数。
  ③ **前端与会话**：左栏状态行的「N 个终端在跑」变成可点按钮，点开是确认框（标题写决策「关掉这 N 个终端？」，说明只补后果「里面跑着的 Claude Code 会一起停掉，任务本身不动」，按钮用结果词「全部关掉」不是「确认」——GPUI 的确认框规范）。会话工具 `close_terminals`，默认只关已收工的，说「全部关掉」才全关。
- **Meegle 工单进任务**（`agent/meegle.ts`）：调度器启动 8 秒后、之后每 15 分钟 `syncMeegleOnce`：`MeegleConnector.fetchWorkItems()`（`mywork todo` + `workitem get --fields priority`）→ 每条分派给我的工单建 `kind: meegle` 任务（`source.meegleId/url`，理解里写节点、状态、优先级、截止），一律 `understood` 排队不占「待我决定」；已有的更新标题/优先级/截止，用户标完成或忽略的不再动；不在分派列表里的自动 done 并记账 `meegle_done`；Friday 里已 done / ignored 但 Meegle 状态含 Reopen 且又在分派列表里的，拉回 `understood` 并记账 `meegle_reopened` + 系统通知（只认 Reopen 状态，用户在 Friday 里主动标完成的不翻回）。项目按标题里出现的项目名/别名（≥3 字）匹配。同时仍写 `todos` 表供会话上下文。`POST /tasks/sync-meegle` 手动触发：左栏「待办」分组头有「↻ Meegle」按钮（同步完显示 +新增 / 重开 / 完成 数，4 秒后消失），会话工具 `meegle_sync` 同一件事；「待我决定」分组头同样有「↻ Slack」（`POST /inbox/sync`）+ 会话工具 `slack_sync`。前端「待办」分组（understood/collected：分派给用户、Friday 没在做、不需要拍板的事）默认展开，按截止日 → 优先级 → 创建时间排序；「Friday 在做」只剩 processing，排在待办之前。Friday 目前不会主动接待办里的工单，待定策略见 2026-09-08 讨论：先由 Friday 判断可做性挂「开工」待审动作。
- **贴链接手动加工单（2026-09-21）**：同步链路只认 `mywork todo`（分派给我的），而用户在需求里担角色、当前节点在别人手上的工单进不来——用户贴了 `story/detail/24487610` 说「待办里没有这个，新建一个」，Friday 只能回「我打不开链接」。补了会话工具 `meegle_add`：`parseMeegleRef` 从链接拆出 project key 和工单号（光给数字不行，project key 只能从链接来），`MeegleConnector.fetchOne` 单拉一条拼成和同步链路同构的 `MeegleWorkItem`（没有 node 和排期，那两个来自 todo），再走 `workItemToTask` 建任务，所以后续 `syncMeegleOnce` 能正常接管它。`workItemToTask` 多一个 `manual` 参数，理解里写「你手动加进来的」而不是谎称「分派给你」。已在板上的不重复建。定时同步的范围没动（按角色捞范围太大，先不做）。
- **任务 ↔ 会话 ↔ 终端**：「在会话里讨论」新开会话时 `POST /tasks/:id/conversation` 把 `source.conversationId` 记到任务上，再点就是「继续会话」直接 `load` 原会话；`askStream` 收到 `conversationId` 后 `fridayTools(conversationId)` 按会话建 MCP 工具，`run_claude` 先找 `source.conversationId` 相同的任务，找到就把 job 挂上去（`source.jobId`、processing、progress），找不到才新建 code 任务。Focus 里有 jobId 就常显内嵌终端；Row 上有「终端」「会话」小标签。**抽屉跟随当前任务**：Board 的 `onFocusChange` → Chat `syncDrawerToTask`，展开哪条任务抽屉就切到它的会话（没聊过则空着，第一句发出时 `openTaskConversation` 建会话、绑定并把 `taskContext` 拼在前面）；`⌘⇧N` 才脱离任务开自由对话。绑定后前端广播 `friday:tasks-changed` 让任务板立刻刷新。
- **精致化（2026-09-11）**：用户说「配色没问题，就是不够精致」。诊断出七处粗糙，全部改掉，只动样式与图标不动结构：①**字号四档**（`--t-title` 19 / `--t-body` 13.5 / `--t-aux` 12.5 / `--t-micro` 11），原来 12px 和 13px 各有六七处混用、还有个 11.5px 的孤例，只靠灰度分层；②**间距全落 4 的倍数**（`--s-1`…`--s-8`），原来 5/6/7/10/14/18/22 随手给，同级元素间距不一致；③**卡片元信息行分主次**：状态用 `.fx__state`（`--fg-2` + 500 字重），来源和时间压到 `.fx__meta-dim`（`--fg-4`），原来六段同字号平铺；小标签 `.k` 改成 11px + 600 字重 + 0.05em 字距，靠形态而非灰度和正文区分；④**圆角三档**（`--r-sm` 6 / `--r-md` 8 / `--r-lg` 12），原来 5/6/7/8/10/12 六种，三个同类小按钮各不相同；⑤**补过渡**：`--dur` 150ms + `--ease`，给 `.b` / `.li` / `.rail__item` / `.grp__act` / `.seg__item` / `.li__pin` / `.fx__pin` / `.link` / `.dot` 的 hover 与状态变化都加上，原来只有 `.switch` 有；⑥**字符图标换 SVG**（`views/Icon.tsx`，16 个 path、统一 1.5px 描边、`currentColor`、`1em` 随字号缩放）：`↻ ✦ ★ ☆ › ‹ ↓ ✓ ×` 全换，原来不同字体下粗细不一、基线对不齐；`<kbd>` 里的 `↵ ⌘ ⇧` 是键盘符号约定，保留；⑦**任务卡里的会话空态压缩**：`Thread` 加 `compact` prop 去掉大头像并把文案压成两行，容器高度改成 `height: auto` + `max-height`，`:has(.turn)` 有消息了才固定 44vh——原来空态就占 300px，比真实内容还抢眼。另外修了两个旧 bug：`.dot` 定义了两次，旧的 `margin-right: 6px` 没被重置会和父级 `gap` 叠加；`.b--primary:hover` 硬编码 `#fff` 改成走变量。四套主题只覆盖颜色不覆盖这些标尺，所以自动继承。
- **按 GPUI 指南做界面体检（2026-09-14）**：用户给了 https://gpui-kit.com/zh-CN/docs/design-guides/ （Zed 的 UI 框架设计指南），要点存在记忆库 `research/2026-09-14-GPUI 桌面应用设计指南要点.md`。逐条体检出 27 处违反（8 处严重），全部修掉：
  **无障碍与九态**：全站原来 0 处 `:focus-visible`、0 处 `:active`，补上统一焦点环（`--ring` 从 16% 提到 40% 才算「高对比」）和按下态（scale .985，`prefers-reduced-motion` 下不缩放）；补 `prefers-reduced-motion`（保留透明度与颜色过渡，只砍位移，靠动画表达「正在进行」的改成静态可辨）；三个设置开关对屏幕阅读器只读出「switch, checked」——`Row` 组件改成用 `useId` + `aria-labelledby` 自动关联标签与控件；任务条目 `role="button"` 补空格键；图标按钮补 `aria-label`（`title` 只给鼠标）。
  **最危险的一处**：全局 Enter 监听会在焦点停在「打回」「忽略」等按钮上时抢过去执行主操作——而主操作可能是发 Slack 或合并分支这类不可逆动作。加了「焦点已在可聚焦控件上就不抢」的判断。
  **对齐轴**：三栏原来五个 content inset（页头 32 / 列表 40 / 详情 28/44 / 页面 44），标题和它标注的列表差 8px，收起导航后还是差 8px（把缺陷复制了一遍）。统一到 `--s-8`，实测三者左边缘都落在 232px。分组头与列表项的 8px 原来靠三条规则打架凑出来，改成一处声明。`.li__bar`（活动条）原来参与流式布局，终端一忙整条列表跳 9px，改成绝对定位贴行底。
  **状态不只依赖颜色**：七种状态原来全是同尺寸同形状的 7px 圆点只换颜色。「进行中」改空心圈、「完成」改小一号实心；选中态除了灰度差再加一条左侧竖线（只有当前选中那条有，不会连成栅栏——上一轮给每条都加竖条被否过）。**这条竖线 2026-09-14 已按用户要求去掉**（`.li--on::before` 整段删除）：选中 `--bg-4` 与 hover `--bg-2` 的底色差已经够区分，竖线是多余装饰。
  **Elevation**：`.fx` 和 `.fx__foot` 是同级却各背一层 45% 不透明的 dialog 级阴影。改成基础面平（`--shadow-card` 只剩顶部高光），真正浮起的（右键菜单、回到底部）用新的 `--shadow-pop`，四套阴影配方统一成两套。
  **字号 token**：原来 108 处硬编码对 25 处 token，`11px`/`12.5px`/`13.5px` 各有一份字面量和 token 重复，`12px`（31 次）和 `13px`（22 次）根本没有 token。补 `--t-page/--t-sm/--t-xs`，88 处字面量换成 token；按 Apple tracking 表加 `--tr-*` 字距（字号越小越正、越大越负）。
  **其他**：等宽数字 `tabular-nums`（原来 0 处，计数和耗时会抖）；`.switch` 的 `cursor: pointer` 改箭头（桌面约定只有链接用手形）；打开弹层的命令加省略号（「看一眼再发…」「打回…」「编辑…」）；`disabled` 四种透明度统一成 `--o-disabled`；折叠块补展开指示（原来 `list-style: none` 抹掉三角又没给替代）；同步按钮留 `min-width` 防文案切换时推动同行；「待回复」Badge 从语义青改中性（它不是 success/warning/danger）；空状态补「下一步是什么」。
- **证据优先（2026-09-14）**：用户确认过界面的真正目标——「工作要对产出负责，不能全交给 agent」，所以要解决的不是「更快清掉」而是「让你敢下判断」，需要的是**可核对的证据**而不是好看的摘要。判断依据见记忆库 `research/2026-09-11-界面的真正目标是让人敢下判断.md`。三处改动：
  ① **对方原话从最底下的折叠提到卡片最上面**（`.fx__source`，标题之下、情境之上）：带频道名、逐条列出、每条 hover 出「在 Slack 打开」。原来那个底部的「Slack 原文」折叠删掉了，不再重复。**空消息也显示**（标成「这条没有文字，可能是图片或表情」）——Friday 可能正是因为读到空消息才判断错的，藏起来用户就看不出。
  ② **证据不足要明说**（`evidenceCheck`，`.fx__evidence`）：只做能确定的检查，拿不准就不报（误报比不报更伤信任）。两条规则：一条带文字的都没有 → 「Friday 没有可依据的内容，这条草稿是猜的」（amber）；草稿说「内容没显示出来」但线程里其实有带文字的消息 → 「和原文对不上」（red）。**后者会把主按钮从「看一眼再发…」换成「改一下再发…」**——证据和草稿对不上时默认动作应该是改而不是发。
  ③ **后果预览**（`consequence`，`.fx__consequence`，在操作栏内、按钮上方）：`slack_reply` 说清「以你的身份 + 发到哪（私聊还是回在谁那条下面）+ 撤不回但会记进操作记录」；`git_merge` 说「合完可以在操作记录里撤销」。原来除了 slack_reply 的确认框，点「通过并执行」之前完全不知道会发生什么。
  数据支撑：库里 110 条任务 57% 来自 Slack，当前待决定的 5 件全是「回复某人」；准备过 56 条草稿只发出 10 条，所以次按钮保留「我自己回」的位置。
- **主题预设**：`settings.theme`（graphite / warm / navy / light，`THEME_OPTIONS`；light 是 2026-09-09 加的浅色，写死的颜色都已收进 token：`--ok` `--bad` `--shadow-card`），设置页「外观」分段切换，`lib/theme.ts` 把值写到 `<html data-theme>` 并缓存 localStorage 防闪，设置窗改完 `emit("friday://theme")` 广播给工作台即时换色。每个预设只是 `:root[data-theme=…]` 一组变量，布局不动；浅色主题未做。设置页 `.settings` 自身滚动（全局 html/body 是 overflow hidden）。
- 首屏问候用 `settings.name` + 本地时段，不再调 `/desk`（前端 `DeskView` 已删）。
- 验收方式：core `FRIDAY_PORT=7791 FRIDAY_DATA_DIR=<临时目录> FRIDAY_NO_SCHEDULER=1` + `VITE_FRIDAY_PORT=7791 vite --port 1421`，浏览器直开 vite 页面（`coreBaseUrl` 无 Tauri 时回退到本机端口；CORS 放行所有本机 origin），用 agent-browser 截图。

## 会话归任务（2026-09-09）：没有独立的会话抽屉

- 起因：用户"老是对不齐哪个任务对应哪个会话"。根子是任务板、抽屉、终端三个有独立状态、靠两套规则松耦合（抽屉有时跟任务走，⌘N 自由模式又不跟）。换左右边解决不了，所以把抽屉删了，**任务是唯一的锚**。
- `views/Thread.tsx`：一段会话的消息流 + 输入框 + 附件 + 流式跟随，`forwardRef` 暴露 `load / reset / send / focus`；滚动：切会话 / 自己发消息强制落底，用户在底部才跟着新内容滚，往上翻了就不打扰，右下角浮「↓」（有没看到的新回复时变「有新回复 ↓」）；`conversationId` 为 null 时第一句走 `resolve(prompt)` 决定落到哪。空闲时每 8 秒对一次消息（终端里 Claude 的交付 / 卡住会追加进来）。
- **主从布局（2026-09-09）**：用户说展开式看不到哪些任务在跑 / 做完了。Board 的 queue / doing / all 视图改成 `.split`：左栏 `.split__list`（分组：待我决定 / Friday 在做 / 待办 / 最近完成；`all` 按状态分组）每条 `.li` = 状态点（attention 优先）+ 标题两行 + 一句状态（needs / doingRight / queuedRight），左栏排序按活跃度：终端在输出 / Friday 在回的排最前，其次最近更新倒序（待我决定里有待审动作的仍优先）；**关注**（`task.pinned`，`POST /tasks/:id/pin`，条目悬停出 ☆、卡片状态行 ☆ 关注）单独一组放最顶上，默认焦点也先看它。右栏 `.split__detail` 是 flex 列：Focus 的 `.fx` 卡片自己滚动（meta sticky），`.fx__foot` 操作栏在卡片外、钉在右栏底部一直可见（独立一条带边框底色）。左栏条目在终端 busy 或该任务会话生成中（Chat 传 `runningConvs`）时显示青色活动条 `.li__bar`；导航底部有「N 个终端在跑」。旧的 `Row` 组件删了；ledger 视图仍是单列页面。
- **任务卡单列，从上到下按优先级**：标题 → 情境 / 建议 / 报告 → `.fx__talk`「和 Friday 聊这条任务」（`<ChatThread conversationId={task.source.conversationId}>`，高 clamp(300px, 44vh, 480px)，resolve = 新建会话 + `taskBindConversation` + 把 `taskContext(t)` 拼在第一句前）→ 「终端在做」动作流（卡片里不再内嵌终端，2026-09-20 起终端是外部 Ghostty 窗口）。**2026-09-14 起这条只做开合，不写状态**：原来标签上写「终端 · 已断，展开可重新打开」，和左栏那条「终端已断 · 点开重新打开」是同一件事说两遍，措辞还更吓人——终端断掉是常态（sidecar 一重启 PTY 就没了），不该在卡片里反复强调。删掉 `TERM_LABEL`，只留「终端」+「展开/收起」，开合本身做明显（inset 边框 + 底色 + hover + `aria-expanded` + 焦点环，原来没底色没边框没 padding 看不出是控件）。连带删掉因此变成死代码的 `liveBusy` / `onTermOutput`（那套 xterm 输出流判忙闲只用来算标签上的「在输出/空闲」）和 `Terminal` 的 `onOutput` 参数→ 账 → 按钮。用户的心智是「先看 Friday 怎么说，不放心再展开终端自己看」，左右两栏试过被否。「在会话里讨论」按钮删了——讨论一直在卡上。回车 = 主动作在 `.thread` 内不触发。
- **输入框的 Esc 与发送按钮（2026-09-14）**：两个用户报的问题。①**Esc 退出了全屏**：`Thread` 的 keydown 里处理了 Escape 但**没有 `preventDefault()`**，事件冒到浏览器就触发了原生的退出全屏。补上之后 Esc 只做它该做的：Friday 在回时中断生成、正在路由时取消路由、都不忙时交给 `onEscape`（「问 Friday」视图里是回工作台）。②**发送按钮看不出为什么不能点**：原来四种情况（Friday 在回 / 附件在传 / 正在路由 / 没写内容）都是同一个灰掉的箭头。现在分开：Friday 在回时按钮变成三点动画且**可点，点了就中断**（和 Esc 一个效果，title 写明「点一下中断（Esc 也行）」）；附件上传中和路由中显示转圈；没写内容时 title 说「写点什么再发」。三点动画在 `prefers-reduced-motion` 下停掉但保持半透明实心，仍看得出在忙。
- **「问 Friday」是一个视图**（`view === "ask"`，侧栏第一项，`⌘N`）：全宽 Thread，`resolve` 走 `POST /route`（接旧 / 新开），命中旧会话时 `.route-hint` 显示「接着：… · 理由」+「其实是新话题」；页头右侧 新对话（`⌘⇧N`）/ Skill / 模型。Esc 回工作台。`openAsk(pending)` 把要做的事排队，Thread 挂上后的 effect 执行（视图切换是异步的）。「会话历史」点一段 → 在这个视图打开。`take_pending_chat` / `friday://open-conversation` 也落到这里。
- 已删：`.drawer*` 全部 CSS、`syncDrawerToTask`、free 模式标志、`Board.onDiscuss`。「聚焦终端」现在是 `POST /jobs/:id/focus` → 按 `ghostty_id` 把那个窗口拉到前台。

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

## token 成本（2026-09-14 量过一轮）

用户说消耗太大，量了每个调用点的实际提示词大小和近 7 天真实频率后发现**大头不在后台任务**：`triage` ~1400 字符/批、`brief` ~1600、`route` ~600、`continuation` ~470，近 7 天加起来约 13 万字符；而会话 1071 条消息每轮都把记忆库全文塞进 system prompt，量级差两个数量级。

做了三件事：

- **记忆库按需读**（`memory/context.ts`）：`projects.md` 留着内联（判断「说的是哪个项目」几乎每次都要拿名字和别名对一遍），`people.md`（实测 3746 字符）和 `decisions.md`（2178）改成提示里说一句「需要时 `memory_read` 读，不要凭印象编」。按真实记忆库实测**每轮 system prompt 从 12644 降到 6840 字符，省 46%**。文件为空时不提那句，免得让它去读空文件。实测问「拂晓是谁」它会自己去读 people.md，问待办则直接用内联块不多跑一轮。
  `MemoryContext` 因此从 `{projects, decisions, people, todos}` 变成 `{projects, todos, hasPeople, hasDecisions}`。待办块顺带从 `todos` 表改读 `tasks`（记待办已统一建任务，原来注入的是陈旧内容）。
- **`route` 与 `continuation` 换 Haiku**（`claude-haiku-4-5`，实测可用）：两个都是「输出一个 JSON 做二选一」的小任务，判错代价也小（route 接错有「其实是新话题」可点，continuation 判不准时提示词要求答 false 偏保守）。**`triage` 和 `brief` 留 Sonnet**——要读懂中文语境、写能直接发出去的草稿，brief 更是界面的核心输出，降级会明显变差。
- **Skill 模式开关补成本说明**：「开着时每轮都要读 skill 文档、最多跑 30 轮，一次提问可能到 $1；不常用 skill 就关掉」。**默认值没动**（仍是 `skills: true`）——那是使用习惯，留给用户自己决定。

## 用量展示（2026-09-16，左栏底部）

- 起因：用户问"这些处理要消耗多少 token"。量下来后台七个调用点近 7 天加起来不到 $1，大头在派到终端的 Claude Code；但之前**一条都没记过账**——SDK 的 `result` 消息本来就带 `total_cost_usd` / `modelUsage` / `num_turns`，`claude.ts` 只是 `console.log` 掉了。
- 采集：`AskOptions` 加 `label`（ask / triage / brief / route / continuation / intake / review / handbook / hot / desk），`askStream` 在 `result` 事件把每个模型一行写进 `usage` 表。**一次调用的多行共享 `call_id`**——`modelUsage` 是 `Record<model, …>`，拿时间戳去重会把同一毫秒的两次并发调用（brief 最多 3 个并行）算成一次。
- `modelUsage` 在一次 `query()` 里是累计值，每个 result 带的是「到此为止的总数」，所以直接落这一条、不跨 result 相加；Friday 的多轮走 `resume` 开新 `query()`，各自独立计数。
- 接口 `GET /usage?range=today|7d|30d`（`memory/usage.ts` 聚合，按调用点和按模型各一份）。前端 `views/Usage.tsx` 挂在左栏底部：收起是一行「今天 $x · N 次」（每分钟刷一次），点开向右弹出面板——三档分段、总计、按调用点、按模型，底部说明「走的是订阅，这里按 API 标价折算，不是账单」。
- **终端任务不计在内**：`claude -p` 和 PTY 里的 Claude Code 不走 `askStream`，用量在它自己的 session jsonl 里。用户明确说这版不做。

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

提交信息用中文，每完成一个功能点提交一次。git author 直接用仓库配置（`.git/config` 已设 `TOM <chemwenxin@163.com>`），**不要用 `-c user.name=... -c user.email=...` 覆盖**——全局配置是工作邮箱，这条规则就是靠仓库级配置拦住它，不需要谁再记一遍。
