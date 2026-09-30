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
第二版（已完成）：`POST /run` 在 Friday 里开项目终端跑交互式 Claude Code（tmux 会话，见「终端：tmux 持有进程、详情就是终端」）；独立打包（`.app` 内嵌 core 产物与依赖，不依赖仓库目录，node 仍用系统的）。
第三版（已完成，2026-09-21 重做）：Slack 关联源——见下文「Slack：关联源」一节。原「Slack 收件」那套（triage 分类 → 按人聚合线程 → 情境卡 → 起草回复 → 置信度闸门 → 经验闭环）已整体删除，约 1667 行。
未做：项目智能匹配、自动更新、内嵌 node、Slack 发送。结构预留位置即可，不要提前实现。

## Slack：关联源（2026-09-21 重做）

**定位**：Friday 不替代 Slack，你照旧在 Slack 里看和回。Slack 在 Friday 里只是「关联源」——把对话挂到你已有的任务上，让四端（Slack / Meegle / 终端 / 浏览器）彼此知道对方的存在。

**为什么推翻第三版**：那套围着「Friday 起草、你审」建，而这个前提你 2026-09-17 就否了（草稿不可用、重复建任务、待办抽象不对）。库里 `lessons` 与 `thresholds` 从投产起一条没有，情境卡每天花一块多算出来没人看，前端早已零入口。

- **只挂靠，不评判**。消息进来只做三件事：`connectors/noise.ts` 挡噪音 → `agent/slack/attach.ts` 挂靠 → 带疑问信号的过一道查询分类。不判断要不要回、不起草、不自建任务、不发通知。
- **挂靠复用 `links` 表**（`memory/links.ts`），没有新建表。两级硬信号零模型调用：①消息里的 Meegle 工单号（`memory/infer.ts` 的 `meegleIdsIn`）②同人同频道 48 小时内挂过的任务。都没中且有候选才问一次 Haiku，记成 `guess` 边。`user > rule > guess` 只升不降，`unlink` 写否决边且自动推断不会再连回来——「纠正以后不能再错」落在这里，不需要额外的映射表。
- **对话单位是 Slack 原生粒度**：有 `thread_ts` 的整个 thread 算一段，否则单条算一段。键 `channelId:thread_ts|ts`，`conversationKey` 在 `packages/shared` 前后端共用。
- **唯一的起草场景**：私聊或 @ 我、且带疑问信号（`？?` / 怎么 / 哪里 / 为什么 / 能不能 / 是不是 / 有没有）的消息，`agent/slack/query.ts` 判一句「读代码就能答吗 + 哪个项目」，是就 `startQueryJob` **在后台**起一个**只读**的 `claude -p` 去查。产出 `## 概要 / ## 依据（文件:行号）/ ## 回复草稿`，任务进 review 挂 `slack_reply` 待审。
- **后台跑，不弹窗口**（你明确要求：主动点的时候才弹出来）。所以不弹任何窗口：查询任务走 `openSession`（`kind: "query"`，tmux 里的后台会话，不建 worktree、cwd = 主仓）、输出落 `<runs>/<id>.log`、退出时 `/jobs/:id/exit` 回调 `onJobExit`。想看就在任务详情里看终端；Claude 退出后 `resumeInSession`（仅会话 `exited` 时，`/jobs/:id/reopen` 对还在跑的回 409）用 `--resume` 在同一会话里接回；接回时 `resumeInSession` 按会话 `kind` 重写 hook，查询会话照样挂只读 deny，只读不会在接回时丢。你在 Slack 里回掉之后 `settleQueryTasks` 走 `finishTask` 收工，会话一起 kill。任务详情对查询任务同自主任务一样：面板顶上是待审的回复草稿，查询结果（概要 / 依据）在会话里 Friday 那条消息，右上「看终端」切过去。
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

## Friday 自己开自主任务（2026-09-28）

到这天为止自主任务（`claude -p` 在 worktree 里改完交审）**从没跑完过一次**：历史上只有 09-22 回车 bug 误触发的 3 条，25 秒内窗口就没了；平时唯一入口是任务卡上手点「交给 Friday 改」/「重新开工」（`POST /tasks/:id/retry`）。`intake` 判成 start 也只是排队。手册只内联进自主任务的提示词，而活都在交互式终端里干，等于学了两周没人用。

- **门禁看「这次交付被直接收下的概率」，不看时间**（`agent/autostart.ts`）：worktree + 守卫 + 合并前审核已经把破坏面压到零，白干的代价只剩 token 和一份废报告。条件同时满足才开：Meegle **缺陷**（需求一律不接，要先对方案）、`source.intake.kind === "start"` 且 `confidence ≥ 80`（intake 的 prompt 要求「只能从标题推断给 50」，这个阈值正好挡住标题党）、`task.project` 已定且和 intake 判的一致（归属来自所属需求的容器，不是猜的）、卡上没挂着问题、阶段还是「未开始」（2026-09-29 补：同步会把流到测试的缺陷推到「测试中」，不挡的话门槛一调低就会去改已经在测的缺陷）、进来满 15 分钟（缺陷刚建时描述常被反复改）。并发 1（2026-09-29 用户要求去掉「每天 3 条」上限：并发 1 本身就控制节奏，成本看用量面板）。`intakeWorkItem` 现在把判断结果落在 `source.intake`，门禁和卡片都看它。
- **判成能开工就自己做，项目判错能整体回退（2026-09-30，用户定）**：卡上没项目时门禁用 intake 判的项目（须在 `projects.md` 注册表里），开工时写到卡上并标 `source.projectBy: "friday"`；你定过的项目（`projectBy: "user"`）门禁不再拿 intake 去比。这类任务在 `GET /tasks` 里带 `autostart: { at, behind }`，详情是排队卡、不走「还没开工，差一步」的空态；会话里说「先别做 / 这条我来」写 `source.autostartOff`。**改项目按谁干的活决定，不按项目是谁选的**（`agent/reproject.ts` 的 `requestProjectChange`，任务卡选择器和会话 `task_update.project` 都走它）：还没开工直接改；你自己终端里干的关终端、worktree 留着；Friday 自主干的（`autonomous` 且不是后台查询、会话是它自己的）挂一条 `reproject` 待审动作列清单，说「撤掉」才执行 `rollbackAndRestart`——关会话、`worktree remove --force` + `branch -D`（只删它这次建的、先核对是这个仓库登记过的 worktree 且不是主仓）、runs 记 `rejected`（「项目判错：A → B」，进学手册的结果证据）、撤下交付与待审合并、阶段退回未开始，然后在新项目上重开；改回原项目 = 撤清单；已合进主干的拒绝。远端数据不在自动回退范围。
- **autostart 不碰你的交互式会话（2026-09-30）**：缺陷的根会话是 `interactive` 且没 closed 就跳过（打一行日志、不记 `autostart` 账），不往你正在用的会话里敲字。
- **每轮 Meegle 同步后跑 `autostartTick`**，总开关 `settings.autonomous`（**默认关**，设置页「让 Friday 自己开工」），开工记账 `autostart` 并发通知。前两周看合并时「没被你改过 / 被改过 / 被打回」三档，收下率过半再放宽。
- **手册进交互式终端**：`terminalBridgePrompt(project)` 内联该项目手册 + `_global`，`SessionLaunch.project` 从 `openSession`（`startInteractiveJob` / `/run` / `run_claude`）传进来，`resumeInSession` 接回时同样带上；自主任务（headless）不重复带，`autonomousPrompt` 里已经有。
- **Ghostty 偶发「command 不执行」（09-28）已随 Ghostty 层一起删除**：开窗口 / 聚焦 / 重开全走 tmux 会话，没有 AppleScript、没有窗口 id，这条排查手段不再适用。
- `playbooks/` 目录（09-17 Slack 旧链路的回复类别）已删，代码里早无引用。
- **模型不继承你的默认**（2026-09-28）：一次 6 分钟的自主任务花了 $4.46——Claude Code 默认被切成 Fable 忘了切回，而 `claude -p` 不传 `--model` 就继承它。现在 headless（自主 + 后台查询）一律 `--model opus`（`agent/claude.ts` 的 `HEADLESS_MODEL`）；交互式终端不传，那是你自己在用。**所有模型一律写别名**（`opus` / `sonnet` / `haiku`，Claude Code 解析到当前最新版本；只有 Fable 没别名、写全 id），出新模型不用改代码。设置里以前存的 `claude-sonnet-5` 这类版本号，读的时候自动换成别名。
- **碰远端数据的规矩**：陪跑那次它直接 POST canary 接口改了造数标的（最后还原了），守卫只拦 git 和 rm，拦不了这个。`autonomousPrompt` 第 6 条：只碰工单里给的造数数据、没给就不写、改过的一律还原并把还原步骤和回读结果写进「测试过程」、生产一律不写。
- **结果账本 `runs`**（`memory/runs.ts` + `agent/runLog.ts`）：一次自主运行 / 后台查询一行（id = jobId），交互终端每轮 `friday_done` 一行（`jobId#随机`）。三处记账——①开工 `startAutonomousJob` / `startQueryJob` 写 trigger（retry / autostart / approve / slack）和 intake 把握；②收尾 `friday_done` / `friday_blocked` / `onJobExit` 写 exit（report / blocked / window_closed / no_report，先到的口径算数）、分支、tip sha、相对主干分叉点的 diffstat、成本（transcript 最后一条 `cost-state`；交互轮次记的是相对上一轮的增量）；③结局：`git_merge` 执行前比对分支头和交付时的 tip——没动 `merged_as_is`、多了提交 `merged_modified`（写明几次）、tip 已不在分支上（amend / rebase）也算 `merged_modified` 并写「分支被改写，无法比对」；打回 `rejected` 带原因；`finishTask` 收工时（你多半是在 MR 里合的，不经 Friday）去**本地**主干（main / master / origin/*，不 fetch）找交付时的 tip：找到记 `merged_*`（分支已删就只能确认提交进了主干，记 `merged_as_is` 并写明），找不到记 `closed_unverified`（squash、还没 pull、或真没合——不当收下也不当白干），**只有忽略才算 `abandoned`**；Meegle Reopen 把 `merged_*` 和 `closed_unverified` 都改成 `reopened`。成本：`friday_done` 那一刻 `claude -p` 还没退出、最后一条 `cost-state` 往往没落盘，`onJobExit` 再补一次；还读不到的在汇总里单独计 `costUnknown`，面板写明「另有 N 次没读到成本」，不当成 $0。后台查询调 `friday_done` 不记交互轮次。
- **面板**：用量面板「Friday 干的活」按项目 + 类型列次数、成本、原样收下 / 改过再收 / 打回 / 待定、中位耗时（`GET /runs/summary?range=`）。门禁阈值（把握默认 80 / 并发 1）**不自动调**；把握门槛在设置页「自主开工」可拖（50–100，`settings.autonomousMinConfidence`），拖的时候实时显示「排队里判成能开工的缺陷 N 条，按这个值能放进 M 条」（`GET /autostart/preview?min=`，不看等稳定期和并发），一个项目攒够 10 次再议。顺带修了面板向上弹出顶出窗口（用量条 `56fb97c` 挪到页头后就一直是坏的）。

## 从 Claude Code 历史学（2026-09-15）

冷启动问题：Friday 的经验闭环（lessons / playbooks）只能等用户一次次干预慢慢攒，而用户在 Claude Code 里已经说过几百条约定了。实测近 30 天 673 个会话里有 2244 条用户原话，本地预筛出 322 条带纠正信号的（17.5 万字符），全量提炼约 $0.6——**大头不是模型钱，是别学错**。

- **取料** `agent/history.ts`：扫 `~/.claude/projects/**/*.jsonl`，只取 `type: "user"` 且 `isMeta`/`isSidechain` 都不为真的文本块（sidechain 是 subagent 的 prompt，不是用户说的）。预筛正则只用来把两千条缩到三百条，「这算不算可复用约定」交给模型——正则判不了「改成 No photo yet」是一次性文案还是长期口径。
- **项目归属看 jsonl 自带的 `cwd`**，不要反解目录名（`whale-console` 里的连字符和路径分隔符编码后长得一样，解不回来）。先对 `projects.md` 的 `- 目录：` 做前缀匹配（仓库内 worktree 天然覆盖，嵌套取最深），不中再看路径段里有没有项目名——**orca 把 worktree 放在 `~/orca/workspaces/<仓库>/<分支>`，跟项目目录毫无关系，实测 6 条 fe-wealth-admin 的原话全被丢进「通用」**。
- **挡掉 Friday 自己写的 prompt**（`isOwnPrompt`）：`cwd` 在记忆库目录下的会话是 Friday 自己调 Claude（情境卡、intake、提炼），那些"用户消息"是它自己写的。实测混进来 3 条（「这之前，与千一的私聊里聊的是…」「工单信息：Meegle Defect #…」），学回来是自我强化的回音室。
  **项目目录里的 Friday 话术（2026-09-28）**：自主任务、终端注入的 cwd 在项目 worktree 里，按 cwd 挡不住——近 30 天 372 条候选里 59 条是 Friday 自己写的（「新建分支 friday/…」「用户已逐项确认你上一轮列的 N 条验证点」），学成了手册里的假规则。现在一律**按记录精确排除，不猜**：`entrypoint` 为 `sdk-*` 的整条不算；Friday 拉起的自主 / 后台会话按 `jobs.claude_session_id` 整份跳过（`fridaySessionIds`）；交互终端的第一句是 `jobs.task`、之后 `say()` 敲进去的每句记在 `terminal_inputs` 表，原话和这些一字不差就挡。代价：你在终端里手敲出和注入记录一模一样的句子也会被挡。
- **提炼** `agent/handbook.ts`：按项目分批喂 Sonnet，**每条规则必须跟一行 `>` 开头的原话出处**——手册里一条「member_id 一律用 string」没有出处，用户就没法判断是不是模型编的（同「证据优先」）。~~重写整份~~（2026-09-28 起改成规则表 + 四种操作，见下文「规则结构化」）。输出 JSON：`ops` / `conflicts` / `decisions` / `people` / `aliases`，解析层对越界字段一律钳掉。历史原文过 `untrusted()`（里面混着 Slack 原文和网页抓取）。
- **不直接写记忆库**：提炼结果建一条 `kind: "handbook"` 的 review 任务（`plan` 是分项目的草稿全文），挂 `handbook_apply` 待审动作，用户点「通过并执行」才落盘 → 规则表、重新渲染 `handbooks/<项目>.md`、追加 `decisions.md` / `people.md`、`addProjectHints` 补别名。整个 apply 记一条账，`undo: restore_memory` 存 apply 前的规则表快照整体还原。
- **注入**：`autonomousPrompt` 和交互终端的 `terminalBridgePrompt(project)` 都内联该项目 + `_global` 的规则（`memory/rules.ts` 的 `handbookBlock`：**只带规则正文不带出处**——出处是给你核对的不是给模型的；按最近确认倒序、各 1500 字整行截，原来按文件前 1500 字截，whale-console 手册 5.9K、后面的规则从没被注入过；手写笔记放得下才整段带）。会话的 `friday()` **不内联**，只说一句「handbooks/ 下有这几份，需要时 `memory_read handbook:<项目名>`」——不破坏记忆库瘦身那 46%。
- **节奏**：一条代码路径，游标为空扫近 30 天（冷启动），有水位从水位往后扫。`historyDue` 跟 `learnDue` 一个思路，只看离上次跑过了多久（存 `sync_state` 的 `history:ran`，重启不丢），每周一轮；候选不足 8 条不弹，但照样推进「跑过」时间，否则每半小时重扫同一批。
- 入口：`POST /tasks/learn-history`、会话工具 `learn_history`、设置页「项目手册」分组的「现在学一轮」；开关 `settings.learnHistory`（默认开）。手册在设置页「规则…」**逐条**改或退役（`GET /rules?project=`、`PATCH /rules/:id {text}|{retire}`，退役必须写一句原因）；`PUT /handbooks/:slug` 已删，markdown 是生成物，手改会被覆盖。


### 规则结构化（2026-09-28）

整份重写跑到第二轮就露了问题：原话出处被截成 `…`、你手改的那行下一轮可能被抹掉、同一条规则在 `_global` 和项目手册各抄一份、删了什么审核卡上看不出来。跑十轮手册会变成一篇模型润色过的文章，出处形同虚设。

- **表**（`memory/rules.ts`）：`rules`（id `r-` + 8 位 hex、project、section 四选一、text、status active/retired、origin history/manual/outcome、created_at、last_confirmed_at、retired_*）+ `rule_evidence`（quote、at、kind utterance/outcome、ref 会话 id 或任务 id）。证据只增不改，`last_confirmed_at` 取**证据里最新的时间**（你最近一次这么说），不是写入时间。`handbooks/<项目>.md` 由 `renderHandbook` 生成，每条带 `<!-- r-xxxxxxxx -->`；手写段落（如 fe-wealth-admin「ref 是系统级还是租户级」的判断方法）不是规则，原样存 `handbooks/notes/<项目>.md`，渲染时附在末尾。
- **迁移**（`memory/rulesMigrate.ts`，启动时跑、表非空就跳过）：旧手册逐条迁，原文件留 `.md.migrated`；去空格后相同的规则出现在两个以上项目就归 `_global`；证据时间用旧文件 mtime（旧格式里原话没有日期）。真实数据 105 条 → 103 条。
- **提炼协议**：喂给模型的是「当前规则（带 id、`[手改]`、`⚠ 久未确认`）」+「编号候选」+「Friday 的硬约束（守卫黑名单 + 分支规则）」，输出四种操作 `add / confirm / revise / retire`。**引证只能填候选编号**，不许自己写引文——解析层丢掉编号越界 / 非整数 / 空证据的、改动 `[手改]` 规则的、退役不给理由的，丢弃数显示在卡上。和硬约束冲突的规则列进 `conflicts`（今天就撞过：提示词要建 draft MR、守卫拦所有 push）。8 周没新证据的只要求有新证据时 confirm，**不许因为「久」就退役**，卡上问一句「还算吗」。
- **从结果里学**：`runs` 里 rejected / merged_modified / reopened 的原因作为 `kind: outcome` 候选（「【Friday 的交付被你打回】改错页面了（任务：…）」），只有一条也单独跑提炼；全是结果证据的新规则 `origin: outcome`。这是学习链路第一次学「Friday 自己干得怎么样」，原来只学你说的话。
- **通过与撤销**：通过时逐条复查规则现状——卡挂着期间你手改或退役了的，revise / retire / confirm 一律跳过并写明「跳过 N 条」。撤销只还原**这次 apply 动过的规则和它新加的**（快照按 id 取，`scoped`），之后你手改的别的规则、下一轮加的规则都留着。
- **审核卡**是 plan 文本，按「新增 / 改写（旧 → 新）/ 退役（为什么）/ 确认 / 冲突 / 久未确认 / 因引证无效丢弃」分段，每条附候选原文。没做逐条勾选：要否掉其中一条只能整份打回，或通过后去设置页退役。

## OKR 周报（2026-09-25）

Friday 起草、你审、你点头后 Friday 逐条提交，跟 Slack 回复一个审核模式。

- **凭证不另存**（`connectors/okr.ts`）：每次调用现读 `~/.claude.json` 的 `mcpServers.okr`（测试用 `FRIDAY_CLAUDE_JSON` 换临时文件），走 JSON-RPC `initialize → tools/call` 直连 okr MCP 端点，兼容普通 JSON 和 SSE 响应体。连不上（`fetch failed`）、15 秒超时、响应体解析不了也一律翻成 `OkrError`，否则起草时不会落成 blocked 卡而是直接抛出去。`submit` 拿不到平台返回的 id 就回查一次——接口没说清成功时一定带 id，撤销要靠这个 id。
- **周口径**（`agent/weekly/week.ts`）：周一到周日，`id` 形如 `2026W0921-0927`（年 = 周一所在年）；周五 16:00 起到周日算本周，其余算上周。
- **素材收集**（`agent/weekly/collect.ts`）**不用 `--since/--until`**：rebase/cherry-pick 会让某个祖先的提交日期比子孙新，git 一碰到超范围的提交就提前停止遍历，把范围内更早的提交也一起漏掉；改成 `--all` 取全量按 `%aI` 在 JS 里自己按周过滤。扫 `~/workspace/*` 和 `~/workspace/*/*`、两个邮箱域名都认，per-repo 10s 超时 + 32MB maxBuffer，扫不动就跳过并打日志。**异步、4 个仓库一组并发**（`mapLimit`）——原来 `execFileSync` 逐个跑，47 个仓库 3.4 秒整个 core（HTTP / SSE / hook）都卡着；合并后按时间倒序截断 300 条，`--exclude=refs/stash` 挡掉 stash 的「WIP on …」。任务素材只取本周更新且非 ignored 的，排除 `okr_weekly`/`handbook` 自身；**还在待办里没动过的（`collected`/`understood` 且阶段是 `todo` 或空）也不算**——Meegle 同步每 15 分钟会把所有开着的工单 `updatedAt` 刷一遍，光看时间会把排队的待办全当成本周工作。
- **起草钳制**（`agent/weekly/draft.ts`）：一次 Sonnet `oneShot` 调用，KR 列表、上周正文、素材全部过 `untrusted()`；解析层强制 `objectId` 必须是自己的 KR、进度**永不低于上周**且封顶 100、`used` 引用的素材 id 必须存在、一条素材都对不上的条目直接丢弃；解析失败重试一次再抛。
- **一周一张卡**（`agent/weekly/index.ts`）：`kind: okr_weekly`、`source.okrWeek` 定位卡片。行按 `existing`（平台上该周已有报告，**绝不覆盖不重交**）/ `empty` / `draft` 分类；重新起草时 `submitted` 的行原样保留，不会被冲掉。OKR 平台连不上或起草报错 → 卡片直接 `blocked` 并写清原因。`autoDraftTick` 每 30 分钟跑一次，`settings.okrWeekly` 关掉就不跑，游标 `okr:drafted:<week>` 防重复起草。**自动模式下平台上这周只要有任意一条自己的报告就跳过**（说明用户已经在别处动手填了），跳过时同样写游标，免得每半小时再查一次；手动起草不受这条限制。周报 / 手册卡**没有开发阶段**：`memory/db.ts` 补 stage 的迁移排除这两种 kind（之前被补成 `testing` 的启动时清掉），卡上不渲染 StageBar——否则点「已上线」会把没提交的周报卡直接收工。
- **提交与撤销**（`agent/weekly/submit.ts` + `pipeline.ts` 的 `okr_submit` 分支）：只提交勾选、未锁定（非 existing/submitted）、非空的行，逐条 `submit`。**部分失败不抛**——抛出去会把旧 payload 放回待审动作，已经交成功的行会被当成没交而重复提交；成功的先记账，剩下失败的重新挂一条「重试剩下的 N 条」待审。**每一轮提交前都先查一遍平台**（不只是重试）：用户可能在起草后自己去平台填了，上一轮的失败也可能是超时、报告其实已经建成。命中时只有「这行上一轮是 Friday 交失败的、平台正文 trim 后一字不差」才认成 Friday 交的（标 submitted、进撤销列表）；其余命中一律标 `existing`、取消勾选、不交也不进撤销——**宁可少撤一条也不能撤销时删掉用户自己的报告**。预查本身失败就这一轮一条都不交，要交的行标 failed。预查发现了 existing 的这轮不收工，卡片留在 review 让用户看到哪几条没交上去。**一条都没得交**（全没勾 / 全空）且之前也没交过任何一条 → 抛「没有要提交的条目：勾上至少一条再提交」，动作原样放回；已经交过几条、剩下的都取消勾选时照旧允许收尾。前端可交条数为 0 时主按钮置灰，后果预览写明「共 N 条」；按钮文案不带省略号（点了直接提交，不弹框）。记账失败这条单独处理，不能走通用 catch（那里放回去的是没更新过的旧 payload）。撤销 `delete_okr_reports` 逐条删、删一条就把剩余 id 落一次库，中途失败可以从断点续删；被锁定的报告删不掉，报错里说明去平台上改。
- **入口**：会话工具 `okr_weekly`、`POST /tasks/okr-weekly {week?}`（手动起草）、`PUT /tasks/:id/okr-draft {rows}`（编辑草稿）、设置页「现在起草一份」；开关 `settings.okrWeekly`（默认开）。前端 `views/OkrWeekly.tsx` 编辑防抖自动保存，保存失败保留编辑并报错，提交前必须先 flush 成功；这类卡片回车不触发提交，只能点按钮。
- **`strictMcpConfig` 没动**：okr MCP 走的是 Friday 自己实现的 HTTP JSON-RPC 客户端，不经 Agent SDK 的 MCP 装配，跟 `/ask` 那边收紧 MCP 配置的改动无关。

## 自主任务在 worktree 里跑（2026-09-15）

原来 `startAutonomousJob` 直接在项目主目录里 `claude -p` 建分支改代码，两个后果：占着主仓（用户没法同时在那儿干活）、`worktreeDirt()` 要求主仓干净才肯开工，用户手上有未提交改动时 Friday 直接 blocked。

- ~~开工前 `git worktree add --detach <项目>/.claude/worktrees/friday-<id8>`（`fridayWorktree` / `addWorktree`）~~ **已被两段脚本的「准备段」取代（2026-09-29）**：worktree 由终端里的 Claude 按项目规则建、路径和分支名都不带 friday、建在主仓兄弟目录，见「终端：tmux 持有进程、详情就是终端」。`git.ts` 里的 `fridayWorktree` / `addWorktree` 只剩测试在用。
- `worktreeDirt()` 只剩「得是个 git 仓库」这一条。主仓脏不脏跟 Friday 无关了，这正是用 worktree 的意义。
- **清理（2026-09-29 起改）**：`finishTask`（done / ignored）只 `kill-session`；worktree 目录还在就记账 `worktree_kept`，进 `GET /worktrees/leftover`。设置页「终端」一节逐条列路径、分支、有无未提交改动、所属任务，点「删掉」才 `git worktree remove`，**分支只用 `git branch -d`**（没合并 git 会拒绝，那是安全阀：目录删了、分支留着并写明）；有未提交改动的行要二次确认、带 `force` 才删（`POST /worktrees/remove {path, force?}`，`path` 必须在遗留列表里，`repoDir` 取记录不取请求）。遗留列表排除还在用的路径：任何未 closed 会话的 `worktree`、任何开着的任务的 `source.worktree`。终端里的 Claude 调 `friday_finish` 时自己合 MR、删 worktree 与分支。`cleanupTaskWorktree` 已删。
- **收工 = 关终端 + 收 worktree，只走 `finishTask` 一处**（2026-09-23）：Meegle 那几条自动收工（流转到 RESOLVED、完成当前节点、需求容器收尾、FE 发布走完）原来直接 `updateTask` 标 done，终端和 worktree 都漏关，「N 个终端在跑」就是这么攒的。交互式终端的 `friday_done` 反过来**不再关窗口**——一个任务常要来回好几轮，交付一轮就关、每次追问都得「重开终端」。自主任务的 `friday_done` 也不关（2026-09-30）：`claude -p` 交付完自己退出，会话留到任务收工，供「看终端」翻 scrollback。
- **终端里调完 Friday 工具后别换成英文（2026-09-29）**：实测一个会话里，Claude 每次调完 `friday_progress` / `friday_done` / `friday_blocked` 或等完后台 agent，下一段就换成英文，用户纠正两次还复发——你全局的 `language: chinese` 压不住工具调用之后那一刻。现在两处补：`terminalBridgePrompt` 点名这两个时刻；这三个工具的返回末尾带一句「接下来跟用户说话一律用中文」。语言现读 `~/.claude/settings.json` 的 `language`（`agent/lang.ts`，测试用 `FRIDAY_CLAUDE_SETTINGS` 换临时文件），没配就「跟随用户说话用的语言」。已开着的终端是旧提示词，要重开才生效。
- **终端只在 MR 合并、本地 worktree 清理完才关**（2026-09-23 下午，用户定）：上一条让 Meegle 自动收工也走 `finishTask`，结果提测、RESOLVED、FE 发布一走完终端就被关——这些都不等于 MR 合了。现在 Meegle 那五处传 `keepTerminal: true`，只改状态不碰终端和 worktree。关窗口只剩三个入口：用户标完成 / 忽略（照旧）、手动关终端、终端里的 Claude 调新工具 **`friday_finish`**（它自己合完 MR、删完 worktree 最清楚，Friday 不去 `git fetch` 猜）。已经开着的终端是旧的工具列表，要重开才看得到 `friday_finish`。
- **顺带修了一个一直没被发现的 bug**：`getTaskByJob` 读 `task.source.dir`，而 `TaskSource` 根本没有 `dir` 字段，一直拿到空串 → `currentBranchSync("")` 返回空 → **`git_merge` 待审动作从来没挂上过**。现在 `TaskSource` 加了 `repoDir`（主仓）和 `worktree`（Friday 开的那个），分支名去 worktree 读，合并在主仓做（分支正被 worktree 检出着，在 worktree 里 merge 不了）。

## 终端：tmux 持有进程、详情就是终端（2026-09-29）

09-20 的外部 Ghostty 整层删掉（`agent/ghostty.ts`、`launchClaude` / `reopenTerminal` / `focusTerminal`、`/jobs/:id/focus`、`Task.terminal` / `TerminalState` / `Job.ghosttyId`；`jobs.ghostty_id` 列留在老库里，不再读写）。起因是账本：09-20 至 09-29 交互式终端任务 25 条、`terminal_reopened` 43 次（原因全是「窗口关掉了任务还没做完」）——终端是主工作面，却在另一个应用的窗口里靠 AppleScript 遥控，窗口活不过一次关机而任务活好几天。09-11 那版内嵌 PTY 的死因是 PTY 与 sidecar 共生（重启即丢，攒了 18 个僵尸）、忙闲靠输出流判不准，不是渲染；这次进程归 tmux，Friday 只是观众。

- **进程归属**：`tmux` 是前置依赖（`brew install tmux`），没装时 `/health.tmux` 为 `null`、设置页提示，开工入口抛「内嵌终端需要 tmux：brew install tmux」，任务状态不动，其余功能照常。所有命令 `tmux -L friday -f <dataDir>/tmux.conf`（配置每次启动由 Friday 覆盖写，`agent/tmux.ts`：前缀键关掉、鼠标开、`history-limit 50000`、`set-clipboard on`、`allow-passthrough on`），会话 / 窗口目标一律精确匹配（`=<name>`、`=<name>:<idx>`），用绝对路径调 tmux（Finder 拉起的 PATH 极简）。**清理只用 `tmux -L friday kill-server`，不碰默认 socket。**
- **会话单位**：根任务 = worktree = tmux 会话 = 分支，一一对应（表 `term_sessions`——`sessions` 表已被 `/ask` 日志占用；HTTP 路由仍是 `/sessions/:id/*`，`:id` = 根任务 id）。缺陷不建会话，进所属需求的：`task.source.rootId` 指向根，`resolveRoot` 兜底按 `linkedStoryId` 找 `meegleId` 相同的需求；**根已完成 / 忽略时缺陷自己当根**（已写的 `rootId` 留着但不用，`liveRootId` 统一判，`taskSession` 与 `closeTaskTerminal` 都看它），免得缺陷开工把收工的需求复活。三种任务（交互式 / 自主 `claude -p` / Slack 后台只读查询）都进 tmux，同一种对象；查询任务不建 worktree，cwd = 主仓，只读靠 `WRITE_TOOLS` deny hook。`jobs` 仍是「一次拉起」的记录（`--resume` 一次一条，多 `session_id`），`runs`、历史学习、`terminal_inputs` 依赖的 jobId 语义不变；会话不存 `claude_session_id`，用 `jobs.claude_session_id`。
- **两段脚本**（`runner.ts` `buildSessionScript`）：Claude Code 的 cwd 拉起时就定死，所以 worktree 必须在干活的 Claude 之前建好。①**准备段** `claude -p --model sonnet` 按项目自己的规则（CLAUDE.md / 项目 skill / CONTRIBUTING / 现有分支惯例，没有才用 `BRANCH_RULE`）建分支和 worktree（主仓兄弟目录 `../<repo>-<分支简称>`）、装依赖，把绝对路径写进 `<runs>/<id>.worktree`，挂 guard hook，**任何进 git 的名字不带 friday**；②**干活段** `script -q <id>.log claude <flags> <task>`，退出后 `curl /jobs/:id/exit`，`exec zsh -il` 留壳，会话留到根收工。准备段没产出路径 / `code=2` → 根标 `blocked`，原因指向 `<id>.log`，会话留着让你进去看；`POST /jobs/:id/worktree` 回报路径（已被别的会话占用、**是主仓本身或主仓里的目录**（去尾斜杠、`realpath` 后比，`/var` 与 `/private/var` 算同一个）、或 `rev-parse --git-common-dir` 跟主仓对不上 / 读不到——即不是这个仓库的 worktree——一律回 409：会话 exited、owner blocked、账本记 `claude_code_blocked`）后会话改名 `<repo>-<worktree 目录名>`（经 `safeName`）。`resumeInSession` 在同一会话里 `send-keys` 一条 `claude --resume <id> || claude`，复用原 job 行（`reviveJob`），不新建 job；接回哪个 job 由调用方定（`/jobs/:id/reopen` 接回的就是那个 `:id`，缺省是会话自己的 `jobId`），hook 按**被接回的 job 的 owner 任务**写（`headless` = 只读，`autonomous` = Bash 守卫 + 拒答，其余交互式不挂；没有 owner 才看会话 `kind`）。**自主入口（retry / 审批开工 / autostart）遇到根会话 `exited`** 不接回聊天，而是 `runInSession`：同一会话、同一 worktree 里 `send-keys` 起一次新的 `claude -p --model opus`（新 job 行、`createRun` 照记）。**会话的 `kind` 是「归谁驾驶」，建好后不变**；owner 不是根本身（缺陷在需求会话里跑）时也不改会话的 `jobId`——2026-09-30 修：原来改成缺陷那次的，autostart「根会话是交互式就跳过」从此认不出、同需求别的缺陷会在你的需求 worktree 里被无人值守地跑 `-p`，需求自己的「接着聊」也会接回缺陷的对话。对账收会话时，这个会话里所有 running 的 job 一起收（不只会话自己的 `jobId`）；没有 worktree（准备段失败过）才回落 `openSession`。**同一个根重开会话**时 `createTermSession` 的 upsert 连 `created_at` 一起刷新，否则老行不受 `FRESH_SESSION_MS` 保护，对账落在 kill→new-session 那一秒里会把新行标 closed、对新 job 跑 `onJobExit(-1)`、新 tmux 会话成孤儿。**同名 tmux 会话**：`openSession` 建之前先查，属于同一个根（`term_sessions` 行的 `tmuxName` 相同）就先 `kill-session`，否则名字加 4 位随机后缀——准备段失败 / 409 拒收后会话名没改、留着孤儿，原来再开工必撞 duplicate、永远开不了。**旧任务已有非主干分支**（`source.branch`，根优先）时准备段提示词换成「为已有分支 `git worktree add <路径> <branch>`，不新建分支；已在另一个**非主仓**的 worktree 里检出就复用那个；检出在主仓里时不许在主仓 `git switch` / `checkout` 切走，直接说「分支正被主仓检出，无法另建 worktree」、不写路径文件、非零退出（落到 prepareFailed）」（`SessionLaunch.existingBranch`）。两种提示词都写明路径文件里不许写主仓本身或主仓工作区里的普通目录（嵌在主仓里的真 worktree 可以）；脚本在 `cd` 进去后还有一道本地闸门 `[ "$PWD" -ef <repoDir> ]`，是主仓就按准备段失败回报 `/jobs/:id/exit {code:2, phase:prepare}` 并 `exec zsh -il`，core 连不上也不会在主仓起干活的 Claude——2026-09-30 修：老任务的分支多半检出在主仓，`git worktree list` 第一行就是主仓，原来照提示词会把主仓路径交上来，Friday 照单全收，Claude 直接在你的主仓里干活。
- **活着与否靠对账**：启动时、每 60 秒、工作台窗口聚焦时（`POST /jobs/sweep`）对一遍 `list-sessions`，库里 `preparing / running / exited` 而 tmux 里没有的标 `closed`、running job 走 `onJobExit(id, -1)`（「会话已不在」）；原来 `reapStaleJobs` 的盲标 done 已删。`list-sessions` 只有 `no server running` 和 `error connecting … (No such file or directory)` 算「没有会话」，Permission denied 等一律返回 undefined、这一轮不收尸。对账里的「卡住的 Friday 任务」排除 `source.rejectedAt` 不早于那次运行结束的——打回会写这个时间，不写的话一分钟内对账就把打回的任务重新收成 review 并挂回合并。**旧版没有 `session_id` 的 running job 在 `migrate()` 里一次性收成 done（exit_code -1），对应 processing 任务写「旧版终端已不可接回，需重新开工」**（`db.test.ts` 有测）。
- **注入**：`send-keys -l <text>`，200ms 后 `Enter`，写 `last_input_at`、`recordTerminalInput`（xterm 里直接打字不再按回车记输入——Esc 中断、斜杠命令、空回车都不会有 Stop，会永久「干活中」；改由 `UserPromptSubmit` hook 记，`Notification` 的 `idle_prompt` 当 Stop）；`say()` 的 `no-terminal` = `has-session` 为假，会话在 `preparing` 时排队、准备段回报后 `flushQueued`。窗口操作（新窗口 / 关 / 切 / 分屏）走 `/sessions/:id/windows` 等一组接口，最后一个窗口不杀；只有根收工才 `kill-session`。
- **内嵌终端**（`views/Terminal.tsx` + `api/sessions.ts` + `agent/attach.ts`）：sidecar 用 node-pty 跑 `tmux attach` 当客户端，SSE 推输出、`POST /sessions/:id/input|resize` 回写；前端卸载或断流只 kill 这个观众，进程不受影响；tmux 客户端退出（pty exit）或观众被收时 SSE 流随之结束，前端据此进重连；输入 POST 只在 404 且仍是发起时那个 attachId 时才清掉它。node-pty 的 `spawn-helper` 必须可执行（打包后要检查；根 `postinstall` 和 `scripts/bundle-core.sh` 都按 `*node-pty*/…/spawn-helper` 补可执行位，1.2 的 `prebuilds/darwin-*/spawn-helper` 也覆盖到）。**node-pty 钉在 `1.2.0-beta.15`（2026-09-30）**：1.1.0 在 macOS 上每拉起一个 pty 就多开一个 master fd 不还（kill / destroy / 进程退出都不收，只有 core 退出才释放），每次打开终端、每次重连都永久占一个 `/dev/ptmx`，迟早耗尽整机 511 的上限；1.2.0-beta.15 同样测试（拉起 `/usr/bin/true` 20 次）剩 0。升降版本前先跑一遍这个检查。attach 之前先 `has-session`，不拉 pty 的两种回法：会话行 `closed`（或没有这一行）回 `404 {gone}`，前端判「会话已不在」停止重连；行还没 closed 而 tmux 里暂时找不到回 `503 {retry}`，前端按原退避继续重连（计入 30 次上限）——2026-09-30 修：「开始做」会先 kill 同名会话，`findClaude` 跑 `zsh -ilc` 约一秒后才 new-session，前端 0.5 秒的重连正好撞上，原来一律 gone、永久「会话已不在」要切走再切回。真没了的由对账标 closed 后才变 gone。终端组件以任务的 `jobId` 为 key，开出新会话（新 job）时重新挂载、清掉 dead。xterm 6 + webgl / unicode11 / fit / web-links / clipboard，字体读你的 Ghostty 配置（`GET /terminal/prefs`，只读字体不依赖 Ghostty 运行）。**tmux 客户端在 xterm 里处于 alt screen，历史在 tmux 手里：不做 `capture-pane` 灌历史，滚轮进 tmux copy-mode，`⌘F` 用 copy-mode 的 `search-backward`（不用 `addon-search`）。** 复制：tmux 选区经 OSC 52 → `addon-clipboard` → `POST /clipboard`（`pbcopy`）；按住 Option 拖选走 xterm 本地选区。**中文输入法**：组合期间 `attachCustomKeyEventHandler` 返回 false，组合结束由 `onData` 一次送出，改这里必须真机测。
- **快捷键**：终端聚焦时 ⌘ 组合归终端层（`⌘T` 新窗口、`⌘W` 关窗口、`⌘1…9` 切、`⌘D` / `⌘⇧D` 分屏、`⌘F` 搜历史、`⌘K` 清屏、`⌘+ - 0` 字号）；Friday 全局只留 `⌘N`（会话）、`⌘\`、`⌘↑` / `⌘↓`（切任务），Friday 搜索是 `⌘P`（原 `⌘K`）。页面上不显示快捷键提示，只写在设置页「终端」一节；同一节写明外部接回 `tmux -L friday attach -t <会话名>`（会话名在任务详情的分支那行），不做「弹到 Ghostty」按钮。
- **状态位**（`agent/sessionState.ts`，服务端算，列表和详情共用）：只取终端里的现实——在问你（未解除的 AskUserQuestion / permission_prompt）> 干活中（`last_input_at > last_stop_at`）> 等你输入（`last_stop_at > seen_at`，终端可见且窗口聚焦时前端 `POST /sessions/:id/seen`）> 待你决定（`pending.length > 0`，「等了 N」自最早 `pending.at`）> 卡住 > 空闲 / Claude 已退出（列表行、详情头、右键菜单都有「接着聊」→ `POST /jobs/:id/reopen`，只对有 worktree 或查询会话给）。`taskSession` 对 closed 的会话不给名字，前端「开始做」条件是没有会话或会话 `exited`。准备段期间 core 重启、`/jobs/:id/worktree` 没送到：干活段 SessionStart hook 带 `cwd`，会话还在 `preparing` 就按它走 `worktreeReady` 补上。`turnFinished` 不再往任务会话追加「这轮说完了」、不再写 `attention: "review"`；`task.progress` 只存最新一条、不拼「之前：」。
- **旧入口全部并到会话上**：`run_claude`、`POST /run`、「跑 <项目>」、HUD relay 一律 `startInteractiveJob`（没有任务就先建一条 `kind: code` 的再开）；`/jobs/:id/reopen` = `resumeInSession(job.sessionId, _, :id)`，会话已不在回 404「会话已不在，重新开工」；`/jobs/:id/focus` 已删。
- **Ghostty 时代的两个坑已随它消失**：`command` 属性按 shell 规则拆词（路径里的「Application Support」被拆成两段）、`ghostty_id` 得等 `createJob` 之后才能写，都不再适用；`cleanEnv` 仍在 `agent/env.ts`，脚本里的 `UNSET_CLAUDE_ENV` 照旧。
- **验证时的进程安全（2026-09-29 事故后）**：禁止 `pkill` / `killall` / 按模式匹配杀进程，只 `kill` 自己用 `$!` 记下的 PID；不结束用户的 App 和别的工作树的 dev server；真机验证前后各看一次 `lsof -nP 2>/dev/null | grep -c /dev/ptmx`，涨到几十立即停。
- **工作台现状（同一批改动）**：任务列表在右、详情一次一条，页头没有统计卡；搜索 `⌘P`、`⌘↑` / `⌘↓` 切任务；你在做的任务详情就是终端，统筹信息在「详情」弹窗（按钮收进「···」），Friday 自主的任务（含排队要自己开工的）面板以会话为主体：顶上是要你拍板的待审动作或「什么时候开」，下面一行收起的详情（点开是单列、最多半屏，弹窗里仍是两列），其余全给会话，没有交付报告卡——交付看会话里 Friday 那条消息（概要 / 测试结果 / 请你验证 + 截图，`agent/delivery.ts`），头部只有「看终端」和「···」（2026-09-30 用户定）；还没开工的是空态 + 会话（空态写清还差什么和 Friday 为什么没自己动手；开工在会话里说，会话工具 `task_start` 与「···」菜单的开始做 / 交给 Friday 改共用 `agent/taskStart.ts`），Friday 排队要自己开工的是排队卡（2026-09-30，设计稿 Idle / Queued / Rollback）；每条任务建立时就有且只有一段 Friday 会话（`createTask` 同时建会话并写 `source.conversationId`，`/tasks/:id/conversation` 已删），弹窗底部、自主卡底部、顶栏「会话」视图是同一个组件。


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
- **点通知定位任务（2026-09-25）**：`Notice` 带 `taskId`，壳把它编进通知标识（`friday-<毫秒>:<taskId>`），`notify.rs` 给 UNUserNotificationCenter 挂一个 delegate 接点击 → `window::open_task` → 前端切「全部任务」选中那条。**只有打包版生效**：dev 走 Tauri 通知插件，macOS 上收不到点击。顺带修了 Board 的滚动劫持：跨二十张卡的平滑滚动要 870ms，原来写死 700ms 的保护期挡不住，选中会落到途经的相邻那张（搜索跳任务也一直有这问题）。
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
- **会话能查自己的数据（2026-09-28）**：用户让 Friday 建任务，它读完手册就回「已建到工作台」，其实根本没调 `task_add`（账本里没有这条）；用户追问「你查下数据」，它又没有任何读任务板的工具，只能继续编。补了三个只读工具：`tasks_list`（按 open/done/all、关键字、项目、阶段筛任务板）、`task_get`（一张卡的完整内容 + 这条任务上的账，id 给前 8 位即可）、`audit_list`（Friday 自己的操作记录，可按 action / 任务筛）；`task_add` 返回值带 id。系统提示加一条：说「已建 / 已开 / 已改」之前这一轮必须真调过对应工具并看到成功，用户问「有没有建」先查再答。
- 三级权限落地：只读直接做；可逆直接做并记账、可撤销（记待办、更新 people.md）；不可逆挂成任务的 `pending` 动作等用户点「通过并执行」（发 Slack 回复 `slack_reply`、合并分支 `git_merge`）。用户已同意审核通过后由 Friday 发 Slack。
- **账本** `audit` 表：Friday 每个动作一条（action / why / how / evidence / risk / reversible / status / undo）。`GET /audit`，`POST /audit/:id/undo`。账本视图在会话窗「工作台 → 账本」。
- **自主改代码**（`agent/pipeline.ts`）：情境卡建议 run_claude 且能定位项目 → `startAutonomousJob`：tmux 会话里先跑准备段建 worktree、再 `claude -p`（`autonomousPrompt`：新分支按项目规范起、不带 friday、跑类型检查与测试、界面改动用 agent-browser 截图到 `<runs>/<id>.shots/`、交付报告写到 `<runs>/<id>.report.md`，禁止 push/merge/提问）。任务退出 → `onJobExit` 用 `agent/report.ts` 解析报告与截图（存附件）→ 任务进 review，附 `git_merge` 待审核动作。
- **分支名按项目规范起（2026-09-14）**：原来自主任务写死 `friday/<jobId 前 8 位>`，用户指出这不对——项目有自己的分支命名规范（`~/.claude/skills/harua-dev`：新功能 `feat/<topic>`、修缺陷 `fix/<bug>`、杂活 `chore/<topic>` 或 `style/<topic>`）。改成**让终端里的 Claude 自己起名**：它有完整上下文（任务标题多是中文，Friday 这边做 slug 会变成乱码，而且它才知道这次算 feat 还是 fix）。`autonomousPrompt` 给规则和例子（`feat/export-center`、`fix/withdrawal-rule-tabs`），并要求起好后第一时间用 `friday_progress` 把分支名回报。
  **2026-09-28 补**：规则顺序是「先查项目自己的（CLAUDE.md / 项目 skill / CONTRIBUTING / 现有分支惯例），没有才用 feat/fix/chore 语义化命名」，明确不许 friday 开头——worktree 目录叫 `friday-<id8>`，Claude 会照着目录名起分支。自主任务和交互终端共用 `prompt.ts` 的 `BRANCH_RULE`。
  配套改了三处判据：`onJobExit` 不再拼分支名，改用 `git.currentBranchSync(dir)` 读实际值，读不到或在 main/master 上就不挂 `git_merge` 待审动作（免得挂个假的）；分支相对主干一个提交都没有（`commitsAheadSync`，2026-09-30：Claude 发现改错仓库没动代码，照样挂了个空合并）也不挂，`friday_done` 与 `onJobExit` 两处都查；`bridge.friday_done` 里「是不是 `friday/` 开头」的判断换成「不是主干就算功能分支」；`prompt.ts` 的系统提示同步。
- **交付报告**（`DeliveryReport`）是验收的唯一依据：概要、改动、测试过程、测试结果、截图、请你验证。用户明确要求：功能长什么样 + 测试过程，用截图和文本，不要视频。这条对 Friday 派出的任务和改 Friday 本身都适用。
- 接口：`GET /tasks`（板 + 计数）、`POST /tasks`（口头 / 文档）、`POST /tasks/:id/approve/:actionId`、`/reject`（带原因，退回 processing 并作废 pending）、`/done`、`/ignore`。
- 前端：会话窗默认视图是「工作台」（任务板六列 + 任务详情：理解 / 方案 / 进展 / 交付报告 / 等你点头的动作 / 打回 / 在会话里讨论；账本可按任务筛、可撤销）；启动器第一项「工作台」、状态带 `review N`。
- **内嵌终端**（2026-09-11 做，09-20 删，09-29 以 tmux 持有进程的形态重做）：见上文「终端：tmux 持有进程、详情就是终端」。
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

## 终端任务（会话 ↔ tmux 的关联）

- 每次 `run_claude` / `POST /run` / 「开始做」都经 `openSession` 建 `jobs` 记录和 `term_sessions` 行，并在 tmux 里起两段脚本（`agent/runner.ts`，见上节）。干活段 `script -q <runs>/<id>.log zsh -c 'claude --dangerously-skip-permissions --settings <id>.settings.json …'` 录整个终端会话，退出后 `curl POST /jobs/:id/exit {code}`。
- `--settings` 注入 Stop hook（`<id>.hook.sh`，用 sidecar 自己的 node 绝对路径，因为 tmux 里没有 nvm PATH），每轮回答结束读 stdin 的 `last_assistant_message` POST 到 `/jobs/:id/message`；错误写 `<id>.hook.log`。
- 退出回报时：状态改 done/failed，若 job 带 conversationId（`run_claude` / `POST /run` 经 `openSession` 的 `conversationId` 选项写入；别的开工路径不带）则往那段会话追加一条 run 消息，并进通知队列「任务结束 · 项目」。会话里有 `jobs_list` 工具。10 秒内同目录同任务的重复启动直接复用（`recentDuplicate`）。
- 从会话往终端里说话：`terminal_say` → `say()` → `send-keys`；会话不在（`has-session` 为假）才回 `no-terminal`。


## 工作台（2026-09-08 重设计）：一屏只回答「现在要我决定什么」

> **现状（2026-09-29）**：列表在右、详情一次一条、页头无统计卡；搜索 `⌘P`、`⌘↑` / `⌘↓` 切任务；统筹信息收进「详情」弹窗；每条任务建立时就有一段会话。下面的队列 / 六列 / 抽屉叙述是当时的设计，细节以代码和「终端：tmux 持有进程、详情就是终端」为准。

- 起因：用户看六列看板与纵向分组两版都"迷茫、乱、没重点、配色差"，要求先研究再改。研究笔记在记忆库 `research/2026-09-08-工作台配色与层级.md`（Radix/Geist/Linear/Apple HIG/Refactoring UI/Superhuman triage）。
- 设计系统：`styles.css` `:root` 用 Radix Slate 深色 12 级（`--bg-1..5` 底与组件、`--line-1..3` 边框、`--fg-1..4` 四级文字），旧变量名（`--page`/`--card`/`--label-*`）映射到新 token。唯一主按钮 `.b--primary` 近白底深字；青色 `--live` 降饱和只标活动态与焦点；状态只用 `.dot--*` 小圆点（等你决定 amber / 卡住 red / 进行中 cyan / 完成 green）。一种边框、圆角 8，列表用分隔线不套卡片。
- 布局（`views/Chat.tsx` + `views/Board.tsx`）：无顶栏、无常驻侧栏。页头 `.q__head`（可拖动，留红绿灯）右侧只有「问 Friday ⌘N」。主区 = 待我决定队列：`review`/`blocked` 任务按有待审动作 → 优先级 → 等待时长排序，队首展开成 `Focus`（情境 / Friday 的建议 / 通过前请确认 / 测试结果，折叠：交付报告、链接、内嵌终端、这条任务的账；按钮 [通过并执行 ↵][打回][忽略] + 在会话里讨论），其余一行一条 `Row`（需要你：…），点哪条就在原位展开（不提到队首）。Slack 来源的任务右栏列「对方给的链接」（`extractUrls` 从线程原文提取，`<url|标题>`/`&amp;`/`<@U…>` 先由 `decodeSlack` 还原），底部折叠「Slack 原文」逐条可点、可跳 Slack。处理完自动跳下一条（`act` 里状态变了就清 `selectedId`）。「Friday 在做」「最近完成」折叠在下方。
- 侧栏 `.rail` 固定在最左（200px，2026-09-09 起；之前是靠边缘滑出的浮层），`⌘\` 收起 / 展开并记 localStorage `friday:rail`；收起时 `.chat--norail` 让页头和列表给红绿灯留位。项：待我决定（amber 计数）/ Friday 在做 / 全部任务 / 操作记录 / AI 热点，底部问 Friday、状态行。
- 快捷键：`⌘N` 问 Friday（自由对话，见下条）、`⌘⇧N` 直接开新对话、`⌘\` 侧栏、回车 = 队首主动作（输入框 / 抽屉 / 终端聚焦时不触发）。
- **唯一入口是对话（2026-09-08）**：「＋交代一件事」已删，`POST /tasks` 只剩程序化调用。`⌘N` 弹出抽屉进入自由对话模式（不建会话、不跟任务板的 `onFocusChange` 走），第一句发出时 `POST /route`（`agent/route.ts`，Sonnet，只给最近 20 条非生成中会话的标题 + `projects.md` 项目名/别名）判断接旧会话还是新开，规则偏保守默认新建；命中旧会话时抽屉顶部 `.drawer__route` 显示「接着：标题 · 理由」+「其实是新话题」（换新会话把那句重发）。`/ask` 只在 transcript 还在时才带 `resume`（`transcriptPath` 已修成 Claude Code 真实编码：非字母数字全换 `-`）。系统提示改为：涉及改代码先说判断（项目 / 改哪里 / 方案）等用户点头再 `run_claude`，用户明确说“直接做”可跳过。「在会话里讨论」进入的是任务会话，退出自由模式。
- **Friday ↔ 终端双向管道（2026-09-08）**：终端不再脱节。①终端 → Friday：`api/mcp.ts` 在 `POST /mcp/:jobId` 挂最小 MCP（JSON-RPC：initialize / ping / tools/list / tools/call），`runner.ts` 起 claude 时统一 `claudeFlags`：`--settings`（SessionStart + Stop hook）、`--mcp-config <id>.mcp.json`（指回该端点）、`--append-system-prompt`（`prompt.ts` `terminalBridgePrompt`）。工具在 `agent/bridge.ts`：`friday_context`（任务理解/方案/原话/Slack 原文/项目/人物）、`friday_progress`（写 task.progress）、`friday_done` / `friday_blocked`。**任务完不完成由用户说**：交互式终端里这两个工具只表示「这一轮」的结果——任务留在 processing（**不算「Friday 在做」**，见下条），写 `task.attention`（`review` 这轮做完了等你看 / `blocked` 卡住），Row 的点和 Focus 状态行按 attention 变色（amber / red），等你看的排到组首，通知「这轮做完了，等你看」+ 绑定会话追加 run 消息；用户再给指示（terminal_say、在 PTY 里敲回车）或终端 `friday_progress` 开新一轮时清掉 attention；用户点「标记完成」才 done。只有 Friday 自主派出的 `-p` 任务（`startAutonomousJob` 写 `source.autonomous: true`）friday_done 才直接进 review + friday/ 分支挂 git_merge 待审、friday_blocked 才改 status blocked。交互式终端进程退出也不改任务状态，只记进展。job 没任务时补建。②Friday → 终端：`agent/terminal.ts` 忙不忙直接看 PTY 最近 3 秒有没有输出（`pty.ts` `lastOutputAt`；Claude Code 干活时 spinner 每 100ms 重绘，空闲时静止）——之前用 Stop hook + 输入时序两个方向都漏（xterm 自动应答 Ink 的查询会被当成输入；重开后又全判空闲）。空闲才直接敲，忙则排队、每秒轮询等安静再送，Stop hook 到了也试一次；文本与回车分两次写（间隔 200ms），否则被当成粘贴不提交。会话工具 `terminal_say(text)` 找当前会话绑定任务的 jobId（或 run_claude 从该会话开的 job），只对内嵌 PTY 有效，会往会话追加「→ 已转达给终端：…」run 消息并记账 `terminal_say`。hook 脚本现在回传 `event`/`source`。③Friday 读 transcript：`agent/transcript.ts` 尾读 300KB jsonl，把 assistant 的 text/tool_use（`describeTool` 挑关键参数）和 user 的 tool_result 成败压成动作流；`GET /jobs/:id/activity`、会话工具 `jobs_activity`；任务卡 Focus「终端在做」（`.fx__doing`，processing 时 5 秒拉一次，圆点绿 ✓ / 红 ✗ / 青闪 = 进行中）。系统提示：会话绑着带终端的任务时，“让它…/告诉它…”用 terminal_say 转达，“做到哪了”用 jobs_activity。**会话绑着任务时 `/ask` 每轮把卡片此刻的内容（`api/ask.ts` `taskBlock`：contextFor + 终端状态 + attention + 最近交付）注入系统提示「【当前任务】」，Friday 以它为第一上下文；前端不再把背景拼进第一句。** PTY 输入接口带回车时清 attention。已知：空目录首次进会卡在 Claude Code 的目录信任确认，需要在终端里选 Yes。
- **会话结论回流任务卡 + 发消息前先看原文（2026-09-09）**：会话工具 `task_update`（`agent/taskUpdate.ts` `updateTaskFromChat`）能改状态（用户说“做完了”→ done、“不用管了”→ ignored、“先放着”→ review；收工时清 attention 和待审动作）、理解 / 方案 / 进展、改写或新挂待审的 Slack 回复草稿（`updatePending` 同时改 `detail` 和 `payload.text`）、`dropReply` 撤掉；系统提示要求讨论改了方案或回复就同步。Thread 每轮结束广播 `friday:tasks-changed` 让卡片刷新。待审动作是 `slack_reply` 时主按钮叫「看一眼再发」，点开 `.fx__confirm`：发给谁（私聊 / 原线程）、可编辑的原文、⌘↵「就这么发」/ Esc；`POST /tasks/:id/approve/:actionId` 接受 `{ text }` 覆盖后再执行。有待审动作时旁边还有「完成，不发 / 完成，不执行」（`/done` 清 pending），收工但不外发。`executePending` 失败会把动作放回待审（之前会被吞掉）。状态行显示「卡片更新于」，报告带 `at`。
- **实时推送（2026-09-09）**：`src/bus.ts` 进程内总线，`GET /events`（`api/events.ts`，SSE）把 `tasks`（`createTask`/`updateTask` 后）、`terminal`（`agent/terminal.ts` 每 500ms 对比忙闲，变了才推；`pty.resize` 后 1.5 秒内的重绘不计活动）、`conversation`（`runs.ts` 生成开始 / 结束）推给前端；前端 `lib/events.ts` 转成 `friday:event` / `friday:tasks-changed`，Board 合并终端实时值、200ms 合并拉取，轮询只剩 30 秒兜底。**「通过前请确认」可勾选且落库**（`report.checked`，`POST /tasks/:id/verify`，`bridge.setVerified`）：全部勾完 = 这轮验收通过——记账 `verified_all`；processing 且有终端、无待审动作 → `terminal_say` 让终端继续下一步（提交 / 建 draft MR，做完 friday_done）并清 attention；有待审动作 → 会话里提示点「通过并执行」；`/ask` 的任务块带「验证点已确认 n/N」。**终端弹交互式提问 = 阻塞**：hook 加 `PreToolUse` / `PostToolUse`（matcher `AskUserQuestion|ExitPlanMode`）与 `Notification`（`permission_prompt`），hook 脚本多回传 `toolName / toolInput / message / notificationType`；`bridge.terminalAsking` 把问题整理成一句（`describeQuestion`：问题 + 编号选项 / plan 摘要）→ `attention: question`（红点呼吸）、进展「终端在问：…」、系统通知「终端在等你回答」、会话里留问题原文；前端把它算进「待我决定」并排最前（`needs` 显示「马上回：…」）。`PostToolUse` / 用户回车 / Stop 解除。Friday 的任务块知道终端在等答案，用户说选哪个就 `terminal_say` 敲编号或文字。**终端每轮说完**（Stop hook 带 `text`）→ `bridge.turnFinished`：非自主任务标 `attention: review`、进展换成它说的话、往任务会话追加「终端里的 Claude 这轮说完了：…」（10 秒内刚 friday_done 过的不重复）——用户不用去翻终端。
- **任务标完成 / 忽略时关掉它的终端**（2026-09-10，`terminal.closeTaskTerminal`）：杀 PTY 整个进程组（zsh → script → claude，只 kill PTY 会留孤儿）、`finishJob`、记账 `terminal_closed`；入口 `/done` `/ignore`、`task_update` 的 done / ignored、待审动作全部执行完。不留孤儿 claude 进程和「运行中」的 job。
- **关终端（2026-09-14）**：用户看到状态行「18 个终端在跑」。查下来 18 个里 12 个的任务已 done、1 个已 ignored——**不是关终端的逻辑没跑，是重启后的僵尸没人收**：PTY 只活在 sidecar 内存里，进程重启后数据库里还标着 running 的必然已经死了，越攒越多。三件事：
  ① **启动收尸**（`memory/jobs.ts` `reapStaleJobs`，`index.ts` 里 `initMemory()` 之后调）：把所有 running 的 job 标成 done（exit_code -1），打一行日志。实测一次清掉 18 个。
  ② **手动关**：`closeTaskTerminal` 抽出底层的 `closeJobTerminal(jobId, why, taskId?)`（手动关时任务不一定还在，taskId 可选）。接口 `POST /jobs/:id/close` 关单个、`POST /jobs/close-all` 关全部（body `{onlyFinished: true}` 只关任务已 done/ignored 的）。**返回值语义保持不变**：`closeJobTerminal` 的 true 表示「真的杀掉了一个活进程」，job 收尾不算——接口自己按 job 状态统计处理数。
  ③ **前端与会话**：左栏状态行的「N 个终端在跑」变成可点按钮，点开是确认框（标题写决策「关掉这 N 个终端？」，说明只补后果「里面跑着的 Claude Code 会一起停掉，任务本身不动」，按钮用结果词「全部关掉」不是「确认」——GPUI 的确认框规范）。会话工具 `close_terminals`，默认只关已收工的，说「全部关掉」才全关。
- **回车只作用于选中的那张卡（2026-09-25）**：09-18 改成轮播后每条任务都渲染一个 `Focus`，而「回车 = 主动作」的监听挂在 `Focus` 里，于是**按一次回车会把屏幕外所有卡的主动作一起执行**——09-22 你对一条需求点「开始做」，另外三条挂着开工提案的缺陷同一秒自主开工，35 秒后又一次回车把它们在 Meegle 里流转成 IN PROGRESS。账本里那句「你点了开工」是写死的文案，不是证据。现在 `Focus` 带 `active`，只有选中那张挂监听，并忽略长按的 `e.repeat`。浏览器里复现过：修前一次回车三条全标完成，修后一次一条。
- **「Friday 在做」= Friday 全权在跑（2026-09-25，用户不止一次强调）**：只放 `isFridayRun(source)`（`autonomous || headless`，即自主 `-p` 和后台查询）的任务。你自己开交互式终端驱动的 processing 任务单独一组「你在做」，**判据看来源，不看 `status === "processing"`**。「全部任务」视图原来按 status 分组、processing 一律叫「Friday 在做」，交互式任务终端关了几天还挂在里面。
  同时修了收尸漏洞：`sweepClosedTerminals` 发现窗口没了只把 job 标结束，从不调 `onJobExit`，任务永远停在 processing（09-22 三条自主任务开工 25 秒窗口就没了，进展一直写着「Claude Code 正在…处理」）。现在窗口没了一律走 `onJobExit(id, -1)`（-1 文案是「终端窗口已关闭」），并兜底扫一遍「自主任务还是 processing、job 早已不在跑」的历史残留；启动时也走这条。
- **Meegle 工单进任务**（`agent/meegle.ts`）：调度器启动 8 秒后、之后每 15 分钟 `syncMeegleOnce`：`MeegleConnector.fetchWorkItems()`（`mywork todo` + `workitem get --fields priority`）→ 每条分派给我的工单建 `kind: meegle` 任务（`source.meegleId/url`，理解里写节点、状态、优先级、截止），一律 `understood` 排队不占「待我决定」；已有的更新标题/优先级/截止，用户标完成或忽略的不再动；不在分派列表里的自动 done 并记账 `meegle_done`；Friday 里已 done / ignored 但 Meegle 状态含 Reopen 且又在分派列表里的，拉回 `understood` 并记账 `meegle_reopened` + 系统通知（只认 Reopen 状态，用户在 Friday 里主动标完成的不翻回）。项目按标题里出现的项目名/别名（≥3 字）匹配。同时仍写 `todos` 表供会话上下文。`POST /tasks/sync-meegle` 手动触发：左栏「待办」分组头有「↻ Meegle」按钮（同步完显示 +新增 / 重开 / 完成 数，4 秒后消失），会话工具 `meegle_sync` 同一件事；「待我决定」分组头同样有「↻ Slack」（`POST /inbox/sync`）+ 会话工具 `slack_sync`。前端「待办」分组（understood/collected：分派给用户、Friday 没在做、不需要拍板的事）默认展开，按截止日 → 优先级 → 创建时间排序；「Friday 在做」只剩 processing，排在待办之前。Friday 目前不会主动接待办里的工单，待定策略见 2026-09-08 讨论：先由 Friday 判断可做性挂「开工」待审动作。
- **缺陷的终态按名称认，跟你的 Meegle 视图一致（2026-09-29）**：用户视图是「当前负责人是我 & 缺陷状态不属于 已解决 / 已关闭 / 已终止 / WON'T FIX」，Friday 板上却多挂着 5 条——连接器只收 Open / Reopened / In Development，掉出分派列表后要靠 `CLOSED|RESOLVED|DONE|CANCELLED` 这几个 key 才收工，而 WON'T FIX 的 key 是随机码 `TPivPPL9-`、已终止是 `systemEnded`，永远对不上；缺陷又没有「FE 发布」节点，就一直挂着。现在 `isDoneStatus(key, name)` 名称和 key 都认、中英文都认；流到 **In Testing**（当前负责人已是测试）的缺陷发强信号 `meegle_in_testing` 推到「测试中」，不再算待办。遗留问题 / 打包部署 / 开发评估影响范围这类没勾的状态不动。
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
  ③ **后果预览**（`consequence`，`.fx__consequence`，在操作栏内、按钮上方）：`slack_reply` 说清「以你的身份 + 发到哪（私聊还是回在谁那条下面）+ 撤不回但会记进操作记录」；`git_merge` 说「合完撤不回，要退得自己 revert」（原来写「可以在操作记录里撤销」，但 `git_merge` 的账没有 undo，2026-09-30 改掉）。原来除了 slack_reply 的确认框，点「通过并执行」之前完全不知道会发生什么。**右键菜单不放待审动作的执行项**（2026-09-30 删了「通过并执行：合并 / 提交 OKR / 应用手册 / 开工审批」）：这些已交给会话，会话有整句同意的闸门，右键一点就执行等于绕过它；「开始做」「交给 Friday 改」「接着聊」这类明确标注的发起动作保留。
  数据支撑：库里 110 条任务 57% 来自 Slack，当前待决定的 5 件全是「回复某人」；准备过 56 条草稿只发出 10 条，所以次按钮保留「我自己回」的位置。
- **主题预设**：`settings.theme`（graphite / warm / navy / light，`THEME_OPTIONS`；light 是 2026-09-09 加的浅色，写死的颜色都已收进 token：`--ok` `--bad` `--shadow-card`），设置页「外观」分段切换，`lib/theme.ts` 把值写到 `<html data-theme>` 并缓存 localStorage 防闪，设置窗改完 `emit("friday://theme")` 广播给工作台即时换色。每个预设只是 `:root[data-theme=…]` 一组变量，布局不动；浅色主题未做。设置页 `.settings` 自身滚动（全局 html/body 是 overflow hidden）。
- 首屏问候用 `settings.name` + 本地时段，不再调 `/desk`（前端 `DeskView` 已删）。
- 验收方式：core `FRIDAY_PORT=7791 FRIDAY_DATA_DIR=<临时目录> FRIDAY_NO_SCHEDULER=1` + `VITE_FRIDAY_PORT=7791 vite --port 1421`，浏览器直开 vite 页面（`coreBaseUrl` 无 Tauri 时回退到本机端口；CORS 放行所有本机 origin），用 agent-browser 截图。

## 会话归任务（2026-09-09）：没有独立的会话抽屉

> **现状（2026-09-29）**：会话不再懒建——`createTask` 同时建会话并写 `source.conversationId`，`/tasks/:id/conversation` 已删；弹窗底部、自主卡底部、顶栏「会话」视图是同一个组件。

- 起因：用户"老是对不齐哪个任务对应哪个会话"。根子是任务板、抽屉、终端三个有独立状态、靠两套规则松耦合（抽屉有时跟任务走，⌘N 自由模式又不跟）。换左右边解决不了，所以把抽屉删了，**任务是唯一的锚**。
- `views/Thread.tsx`：一段会话的消息流 + 输入框 + 附件 + 流式跟随，`forwardRef` 暴露 `load / reset / send / focus`；滚动：切会话 / 自己发消息强制落底，用户在底部才跟着新内容滚，往上翻了就不打扰，右下角浮「↓」（有没看到的新回复时变「有新回复 ↓」）；`conversationId` 为 null 时第一句走 `resolve(prompt)` 决定落到哪。空闲时每 8 秒对一次消息（终端里 Claude 的交付 / 卡住会追加进来）。
- **主从布局（2026-09-09）**：用户说展开式看不到哪些任务在跑 / 做完了。Board 的 queue / doing / all 视图改成 `.split`：左栏 `.split__list`（分组：待我决定 / Friday 在做 / 待办 / 最近完成；`all` 按状态分组）每条 `.li` = 状态点（attention 优先）+ 标题两行 + 一句状态（needs / doingRight / queuedRight），左栏排序按活跃度：终端在输出 / Friday 在回的排最前，其次最近更新倒序（待我决定里有待审动作的仍优先）；**关注**（`task.pinned`，`POST /tasks/:id/pin`，条目悬停出 ☆、卡片状态行 ☆ 关注）单独一组放最顶上，默认焦点也先看它。右栏 `.split__detail` 是 flex 列：Focus 的 `.fx` 卡片自己滚动（meta sticky），`.fx__foot` 操作栏在卡片外、钉在右栏底部一直可见（独立一条带边框底色）。左栏条目在终端 busy 或该任务会话生成中（Chat 传 `runningConvs`）时显示青色活动条 `.li__bar`；导航底部有「N 个终端在跑」。旧的 `Row` 组件删了；ledger 视图仍是单列页面。
- **任务卡单列，从上到下按优先级**：标题 → 情境 / 建议 / 报告 → `.fx__talk`「和 Friday 聊这条任务」（`<ChatThread conversationId={task.source.conversationId}>`，高 clamp(300px, 44vh, 480px)，resolve = 新建会话 + `taskBindConversation` + 把 `taskContext(t)` 拼在第一句前）→ 「终端在做」动作流（卡片里不再内嵌终端，2026-09-20 起终端是外部 Ghostty 窗口）。**2026-09-14 起这条只做开合，不写状态**：原来标签上写「终端 · 已断，展开可重新打开」，和左栏那条「终端已断 · 点开重新打开」是同一件事说两遍，措辞还更吓人——终端断掉是常态（sidecar 一重启 PTY 就没了），不该在卡片里反复强调。删掉 `TERM_LABEL`，只留「终端」+「展开/收起」，开合本身做明显（inset 边框 + 底色 + hover + `aria-expanded` + 焦点环，原来没底色没边框没 padding 看不出是控件）。连带删掉因此变成死代码的 `liveBusy` / `onTermOutput`（那套 xterm 输出流判忙闲只用来算标签上的「在输出/空闲」）和 `Terminal` 的 `onOutput` 参数→ 账 → 按钮。用户的心智是「先看 Friday 怎么说，不放心再展开终端自己看」，左右两栏试过被否。「在会话里讨论」按钮删了——讨论一直在卡上。回车 = 主动作在 `.thread` 内不触发。
- **输入框的 Esc 与发送按钮（2026-09-14）**：两个用户报的问题。①**Esc 退出了全屏**：`Thread` 的 keydown 里处理了 Escape 但**没有 `preventDefault()`**，事件冒到浏览器就触发了原生的退出全屏。补上之后 Esc 只做它该做的：Friday 在回时中断生成、正在路由时取消路由、都不忙时交给 `onEscape`（「问 Friday」视图里是回工作台）。②**发送按钮看不出为什么不能点**：原来四种情况（Friday 在回 / 附件在传 / 正在路由 / 没写内容）都是同一个灰掉的箭头。现在分开：Friday 在回时按钮变成三点动画且**可点，点了就中断**（和 Esc 一个效果，title 写明「点一下中断（Esc 也行）」）；附件上传中和路由中显示转圈；没写内容时 title 说「写点什么再发」。三点动画在 `prefers-reduced-motion` 下停掉但保持半透明实心，仍看得出在忙。
- **「问 Friday」是一个视图**（`view === "ask"`，侧栏第一项，`⌘N`）：全宽 Thread，`resolve` 走 `POST /route`（接旧 / 新开），命中旧会话时 `.route-hint` 显示「接着：… · 理由」+「其实是新话题」；页头右侧 新对话（`⌘⇧N`）/ Skill / 模型。Esc 回工作台。`openAsk(pending)` 把要做的事排队，Thread 挂上后的 effect 执行（视图切换是异步的）。「会话历史」点一段 → 在这个视图打开。`take_pending_chat` / `friday://open-conversation` 也落到这里。
- **路由不进任务会话（2026-09-30）**：`routeCandidates` 排除绑了任务的会话（`source.conversationId`）。任务会话里能批准不可逆动作，自由会话一句「好」被接进去就可能误批。
- 已删：`.drawer*` 全部 CSS、`syncDrawerToTask`、free 模式标志、`Board.onDiscuss`。「聚焦终端」按钮与 `POST /jobs/:id/focus` 已随 Ghostty 层删除：终端就在任务详情里。

## 窗口形态（2026-09-07 晚重排）：只有工作台

- **点 ✕ 是藏起窗口、Dock 图标留着**（2026-09-29，像 Claude / Slack）：`CloseRequested` 拦下只 `hide()`，激活策略保持 `Regular`，点 Dock 图标走 `RunEvent::Reopen` → `show_main` 原样回来（窗口不销毁，停在原来的视图）。试过两版都被用户当成「退出」：销毁窗口（Dock 图标跟着收回菜单栏模式）、藏窗口同时退回 `Accessory`（Dock 图标也没了）——**关键是 Dock 图标不能消失**。真退出走 ⌘Q 或菜单栏「退出 Friday」。
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
- `跑 <项目> [任务]` 或 `/run <项目> [任务]` → `POST /run`：按 `projects.md` 解析项目，没有任务就先建一条 `kind: code` 的，再走 `startInteractiveJob` 在 tmux 会话里起交互式 Claude Code（准备段先建 worktree）。干活段用 `whence -p claude` 拿到的绝对路径并显式加 `--dangerously-skip-permissions`（Friday 只是透传用户指令，权限策略与用户平时用 claude 一致）；Claude 退出后会话里留一个交互 shell。
- `Esc` 关闭（生成中则中断），`⌘,` 打开设置。
- 呼出热键默认 `⌘⇧Space`（`⌥Space` 被 Raycast 占用，`⌃Space` 被输入法占用），可在记忆库目录 `settings.json` 里写 `{"hotkey": "..."}` 覆盖。

## token 成本（2026-09-14 量过一轮）

用户说消耗太大，量了每个调用点的实际提示词大小和近 7 天真实频率后发现**大头不在后台任务**：`triage` ~1400 字符/批、`brief` ~1600、`route` ~600、`continuation` ~470，近 7 天加起来约 13 万字符；而会话 1071 条消息每轮都把记忆库全文塞进 system prompt，量级差两个数量级。

做了三件事：

- **记忆库按需读**（`memory/context.ts`）：`projects.md` 留着内联（判断「说的是哪个项目」几乎每次都要拿名字和别名对一遍），`people.md`（实测 3746 字符）和 `decisions.md`（2178）改成提示里说一句「需要时 `memory_read` 读，不要凭印象编」。按真实记忆库实测**每轮 system prompt 从 12644 降到 6840 字符，省 46%**。文件为空时不提那句，免得让它去读空文件。实测问「拂晓是谁」它会自己去读 people.md，问待办则直接用内联块不多跑一轮。
  `MemoryContext` 因此从 `{projects, decisions, people, todos}` 变成 `{projects, todos, hasPeople, hasDecisions}`。待办块顺带从 `todos` 表改读 `tasks`（记待办已统一建任务，原来注入的是陈旧内容）。
- **`route` 与 `continuation` 换 Haiku**（`claude-haiku-4-5`，实测可用）：两个都是「输出一个 JSON 做二选一」的小任务，判错代价也小（route 接错有「其实是新话题」可点，continuation 判不准时提示词要求答 false 偏保守）。**`triage` 和 `brief` 留 Sonnet**——要读懂中文语境、写能直接发出去的草稿，brief 更是界面的核心输出，降级会明显变差。
- **Skill 模式开关补成本说明**：「开着时每轮都要读 skill 文档、最多跑 30 轮，比关掉贵不少；不常用 skill 就关掉」。**默认值没动**（仍是 `skills: true`）——那是使用习惯，留给用户自己决定。

## HUD 呼出慢在 thinking，不在取数（2026-09-23 量过）

- **大头是 Sonnet 5 默认的 adaptive thinking**：transcript 里带 thinking 的呼出 10–13 秒、不带的 3–4 秒；频道那次改前 37.6 秒直接撞上 35 秒超时出了空卡。`askStream` 加 `oneShot`（不挂工具、`maxTurns: 1`、`thinking: disabled`），summon 用它；挂着工具时它还会自己去调 `slack_inbox` 多跑一轮。实测私聊 29.4s → 7.9s、频道 37.6s → 5.9s，判断质量肉眼无差。
- **零模型那段平时只要 0.6 秒**（频道 search 0.5s、私聊有缓存 0.7s），「窗口停留时预取」省不了多少还得处理旧消息，没做。慢的只有重启后第一次私聊呼出（扫私聊花名册 2.4s + `auth.test` 0.5s，都只活在内存里），改成启动时 `warmSlack()` 预热。`slackSelfId` 失败不再缓存空串——开机自启时网络可能还没起来。
- **还剩约 2 秒是 SDK 每次拉起 Claude Code 子进程**，模型本身 3.4–4 秒。再要快得从这里下手。

## /ask 的大头是 skill_listing，不是多轮上下文（2026-09-22 量过）

2026-09-17 的 `2e3143f 去掉多轮会话` 把 $233 的账算在 resume 头上，方向判错了。扒 transcript 里
`type: "attachment"` 各项的体积才看出来：**Skill 模式每轮注入的整份 skill 目录（`skill_listing`）
一项就 51KB，占注入量六成**；而带 resume 那轮反倒是唯一一次真正命中缓存的（cache_read 18k），
同一轮内部的工具调用之间 cache_read 本来就是 0。

- **resume 已恢复**（`api/ask.ts`）：没有上下文的代价是用户贴个链接下一轮就不认得，得重问一遍。
  保留「transcript 文件还在才带」的判断（de94529），文件被清掉时 resume 会直接报错。
- **skill 放行清单**：SDK 的 `skills?: string[] | "all"` 是个上下文过滤器——没列出的 skill 不进
  模型看到的清单、Skill 工具也调不动，但**文件还在磁盘上，Read / Bash 照样够得着，所以它不是沙箱**。
  默认只放 `DEFAULT_SKILL_LIST`（`packages/shared`）那 14 个助理类的（飞书各件、meegle、
  agent-browser、harua-work-summary）——改代码的 skill 归终端里的 Claude Code，Friday 用不上。
  `settings.json` 的 `skillList` 可覆盖，设置页「放行哪些 skill」能切「精选 / 全部」。
  **空数组当没配处理**，否则等于一个都不放，Skill 模式会静悄悄失效。
- **`strictMcpConfig: true`**：`settingSources: ["user"]` 会把用户 `~/.claude.json` 里的 MCP server
  一起带进来，实测 `okr` 一家挂 33 个工具。这个开关让 SDK 只认显式传进去的 `mcpServers`（Friday 自己那台），
  忽略用户设置、项目 `.mcp.json`、插件。**okr 本身没动**——那是用户平时在 Claude Code 里用的，
  只是 Friday 不该把它拉进来。工具 schema 不进 attachment，所以按 attachment 分项量不出它的重量，
  得看 cache_write。
- **实测**（同一句话、同一模型，Opus，逐步叠加）：
  | | skill_listing | attachment 总 | cache_write | 单轮 |
  |---|---|---|---|---|
  | 原样 | 51780 | 84KB | 97k | ~$0.98 |
  | + skill 精选 | 7958 | 34KB | 56k | $0.57 |
  | + strictMcpConfig | 7958 | 34KB | **18k** | **$0.19** |
- **还剩的**：34KB attachment 里 CLAUDE.md 占 8KB、SessionStart hook 占 12KB（superpowers）。
  没动——那些是用户自己的配置，Friday 不该替他裁。
- **再遇到「Friday 太贵」**：先按 `attachment.type` 分组量 `~/.claude/projects/<编码过的 dataDir>/<session>.jsonl`
  的体积，别先怀疑会话轮数。

## 用量展示（2026-09-16，左栏底部）

- 起因：用户问"这些处理要消耗多少 token"。量下来后台七个调用点近 7 天加起来不到 $1，大头在派到终端的 Claude Code；但之前**一条都没记过账**——SDK 的 `result` 消息本来就带 `total_cost_usd` / `modelUsage` / `num_turns`，`claude.ts` 只是 `console.log` 掉了。
- 采集：`AskOptions` 加 `label`（ask / triage / brief / route / continuation / intake / review / handbook / hot / desk），`askStream` 在 `result` 事件把每个模型一行写进 `usage` 表。**一次调用的多行共享 `call_id`**——`modelUsage` 是 `Record<model, …>`，拿时间戳去重会把同一毫秒的两次并发调用（brief 最多 3 个并行）算成一次。
- `modelUsage` 在一次 `query()` 里是累计值，每个 result 带的是「到此为止的总数」，所以直接落这一条、不跨 result 相加；Friday 的多轮走 `resume` 开新 `query()`，各自独立计数。
- 接口 `GET /usage?range=today|7d|30d`（`memory/usage.ts` 聚合，按调用点和按模型各一份）。前端 `views/Usage.tsx` 挂在左栏底部：收起是一行「今天 $x · N 次」（每分钟刷一次），点开向右弹出面板——三档分段、总计、按调用点、按模型，底部说明「走的是订阅，这里按 API 标价折算，不是账单」。
- **终端任务不计在内**：`claude -p` 和 PTY 里的 Claude Code 不走 `askStream`，用量在它自己的 session jsonl 里。用户明确说这版不做。

## settings.json（记忆库目录下，可选）

```json
{ "hotkey": "CmdOrCtrl+Shift+Space", "model": "claude-sonnet-5" }
```

壳只读 `hotkey`；core 读写 `model`（`terminal` 字段仍在 schema 里，但设置页的切换控件已删、没有任何行为读它）（空串 = 跟随 Claude Code 默认，候选见 `packages/shared` 的 `MODEL_OPTIONS`），`PUT /settings` 写回时保留其他键。模型对 `/ask` 与 `/hot` 全局生效，设置页和会话窗标题栏都能切。

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
