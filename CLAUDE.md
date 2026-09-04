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

## 两种形态：启动器与会话窗

- **启动器**（窗口 `main`，透明毛玻璃、置顶、失焦即收）只做一次性动作：空闲态是输入框 + 引导面板（AI 热点 / 待办 / 记一条待办 / 跑项目 / 打开会话窗 / 设置，↑↓ 选、回车执行）+ 一行状态；结果就地显示，`Esc` 清空再 `Esc` 收起。每次呼出都是干净的。
- **会话窗**（窗口 `chat`，普通 macOS 窗口，可拖可缩放，`tauri-plugin-window-state` 记位置）承载多轮对话：左侧会话列表 + 「今天」侧栏开关，中间消息流 + 底部输入框，右侧可展开「AI 热点」面板（同 `/hot`，可重新拉取）。`⌘N` 新对话，`⌘W` 关窗。
- **进入会话**：启动器里 `⌘↵` 直接带着问题开会话窗；或者一问一答后再输入，视为追问，整段搬进会话窗继续。启动器每次呼出会为本次动作懒建一个 conversation，搬过去时沿用它的 id。
- 会话窗开着时应用切到 `ActivationPolicy::Regular`（有 Dock 图标、可 `⌘Tab`），关掉后回到 Accessory。热键在会话窗可见但未聚焦时优先聚焦它，否则切换启动器。
- 会话窗刚创建时前端还没就位，`open_chat` 把参数放进 `PendingChat` 状态，前端 mount 后调 `take_pending_chat` 取；已存在的窗口走 `friday://open-conversation` 事件。
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
