# 终端内嵌：tmux 持有进程、任务详情就是终端

日期：2026-09-29 · 分支：`feat/tmux-terminal` · 起因：外部 Ghostty 窗口和任务生命周期脱节（09-20 起 45 次开窗、43 次重开），Friday 自主任务是黑盒

**设计稿是验收依据**：在线版 https://claude.ai/artifact/Y379Q3E9qoHrPiysJ6nx5o ，源文件存在 `./2026-09-29-tmux-session-terminal-design/`（四张画板 `Main / Drawer / Card / States.dc.html`，浏览器直接打开就能看）。上一版实现和设计稿偏差很大，这次每一步 UI 改动做完都要按 §12 逐条对图，对不上不算完成。

## 0. 背景与证据

- 账本（09-20 至 09-29）：交互式终端任务 25 条、Friday 自主 / 后台 7 条（跑完 1 次）；`terminal_round_done` 93、`terminal_opened` 45、`terminal_reopened` 43（原因全是「终端窗口关掉了但任务还没做完」）；`git_merge` 审批执行 0 次。
- 结论：用户的主用法是「自己在 N 个终端里干活，Friday 做统筹和记录」。终端是主工作面，却在另一个应用的窗口里靠 AppleScript 遥控；窗口活不过一次关机，任务活好几天。
- 09-11 那版内嵌 PTY 死因：PTY 与 sidecar 共生（重启即丢，18 个僵尸）、忙闲靠输出流判不准。不是渲染。
- 参照：Orca（Electron，xterm.js + 自建 PTY daemon + headless xterm 存 scrollback，`pty-*` 三十余模块，另有一份治「死 PTY / 幽灵 tab」的 RFC）；cmux（Swift + libghostty 原生，仍提供 opt-in `local-tmux` 扛 quit / crash / update）。libghostty 对第三方尚未稳定（官方原话：主要给 macOS app 自用），IME / 字体 / 快捷键在 Swift 层不在库里，Tauri WebView 内嵌需要原生叠层，本轮不走。

## 1. 已定决策

| 决策 | 选择 |
|---|---|
| 进程归属 | tmux（前置依赖，`brew install tmux`；未安装时内嵌终端不可用，其余功能照常） |
| 渲染 | xterm.js 6 内嵌在任务详情里；sidecar 用 node-pty 跑 `tmux attach` 当客户端 |
| 会话单位 | 根任务 = worktree = tmux session = 分支，四者一一对应；缺陷不建 session，进所属需求的 |
| 三种任务 | 交互式 / 自主 `claude -p` / Slack 后台只读查询全进 tmux，同一种对象 |
| worktree | **由终端里的 Claude 按项目规则建**，Friday 不算路径；任何进 git 的名字不带 `friday` |
| 详情形态 | 你在做的：详情就是终端，统筹信息在「详情」弹窗；Friday 自主的：详情是交付卡 + 会话框，「看终端」可切 |
| 状态位 | 只取终端里的现实（在问你 / 干活中 / 等你输入 / 待你决定 / 卡住 / Claude 已退出），「看过」靠终端可见 |
| 动作 | 标记完成 / 完成当前节点 / 忽略 / 合并 / 打回一律可对 Friday 说；按钮收进弹窗「···」 |
| 会话 | 每条任务建立时就有且只有一段 Friday 会话；弹窗底部、自主卡底部、顶栏「会话」视图是同一个组件 |
| 弹出到 Ghostty | 不做按钮；设置页写明 `tmux -L friday attach -t <session>` |
| 不做 | 闲置休眠、浏览器、diff 视图（留位）、本机文件资料（留位）、归属规则收严（B）、顶栏收纳与每日自学（C） |

## 2. 对象模型

### 2.1 `sessions` 表（新）

```
sessions(
  id TEXT PK,                 -- = 根任务 id
  project TEXT, repo_dir TEXT,
  tmux_name TEXT,             -- 初始 <repo>-<id8>，准备段回报后改 <repo>-<branch-slug>
  worktree TEXT, branch TEXT, -- 准备段回报；branch 在每次 Stop 时用 currentBranchSync(worktree) 刷新
  claude_session_id TEXT,     -- 干活段 SessionStart 回传
  kind TEXT,                  -- interactive | autonomous | query
  status TEXT,                -- preparing | running | exited | closed
  last_input_at, last_stop_at, seen_at, created_at, updated_at
)
```

- `jobs` 保留为「一次拉起」的记录（`--resume` 一次就是新一条），加 `session_id`；`runs`、历史学习、`terminal_inputs` 依赖的 jobId 语义不变。`ghostty_id` 列不再写，下一版删。
- `TaskSource` 加 `rootId`：缺陷 = 所属需求任务 id（迁移时按 `linkedStoryId` 找 `meegleId` 相同且开着的需求任务补齐）；根任务不设。`sessionOf(task) = sessions[task.source.rootId ?? task.id]`。
- `PendingAction` 加 `at`（挂上的时刻），「等了 N」只从它算。
- `createTask` 同时 `createConversation` 并写 `source.conversationId`，不再懒建；`/tasks/:id/conversation` 接口删除。
- `docs` 从四槽 `{req,tech,design,meegle}` 改为 `Array<{ url, title?, from: "meegle" | "user" }>`（B 再加 `slack`），按归一化 URL 去重，Meegle 同步只增不删用户加的。`kind: link | file` 留位，`file` 本轮不实现。

### 2.2 状态位（`sessionState(taskId)`，服务端算，列表和详情共用）

按优先级取第一个命中：

| 状态 | 判据 | 消失 |
|---|---|---|
| 在问你 | job 上有未解除的 AskUserQuestion / permission_prompt（现有 PreToolUse / Notification hook） | PostToolUse / Stop |
| 干活中 | `last_input_at > last_stop_at`（输入来自 xterm 的回车或 `say`） | Stop 到 |
| 等你输入 | `last_stop_at > seen_at` | 终端面板可见且窗口聚焦（前端 `POST /sessions/:id/seen`），或有输入 |
| 待你决定 · 等了 N | `task.pending.length > 0`，N 自最早 `pending.at` | 通过 / 打回 |
| 卡住 | `task.status === "blocked"` | 解除 |
| Claude 已退出 | session 在、claude 进程退了（`status: exited`），旁边给「接着聊」 | 再拉起 |
| （无） | 没有 session 的待办 | |

元信息行固定：`阶段 · 来源 · 项目 · 排期 · 最近一轮 HH:mm`（最近一轮 = `last_stop_at`）。删除「更新于」和基于 `updatedAt` 的「等了 N」。`task.attention` 的 `review` 档不再由 Stop hook 写，`question` / `intake` / `blocked` 保留。`task.progress` 只存最新一条、不再拼「之前：」，卡上不展示，只供列表灰字、`/ask` 任务块、通知正文。

## 3. tmux 层（`agent/tmux.ts`，替代 `ghostty.ts`）

- 启动检测 `tmux -V`，结果进 `/health` 和设置页；没装时 `startInteractiveJob` 等入口返回明确错误「内嵌终端需要 tmux：brew install tmux」，任务不改状态。
- 全部命令带 `-L friday -f <dataDir>/tmux.conf`。配置文件由 Friday 写、每次启动覆盖：

```
set -g prefix None
unbind C-b
set -g mouse on
set -g history-limit 50000
set -g status off
set -g default-terminal "tmux-256color"
set -ga terminal-overrides ",xterm-256color:Tc"
set -s escape-time 0
set -g focus-events on
set -g allow-passthrough on
set -g set-clipboard on
set -g window-size latest
set -g remain-on-exit off
```

- **建 session**：`new-session -d -s <repo>-<id8> -c <repoDir> -x 200 -y 50 /bin/zsh <runs>/<id>.sh`。脚本见 §4。准备段回报 worktree 后 `rename-session -t <old> <repo>-<branch-slug>`（slug = worktree 目录名去掉 `<repo>-` 前缀；tmux 名里 `.` 与 `:` 替 `-`）。
- **活着与否**：`has-session -t <name>`；**对账**：启动时和每 30 秒 `list-sessions -F '#{session_name}'`，`sessions.status ∈ {preparing, running, exited}` 而 tmux 里没有的 → 标 `closed`、对应 running job 走 `onJobExit(id, -1)`（文案改为「会话已不在」）。`reapStaleJobs` 的「盲标 done」删除。
- **注入**：`send-keys -t <name> -l <text>`，200ms 后 `send-keys -t <name> Enter`；写 `last_input_at`、`recordTerminalInput`。`say()` 的 `no-terminal` 语义改为 `has-session` 为假。
- **窗口**：`new-window -t <name> -c <worktree>`、`kill-window -t <name>:<idx>`（最后一个窗口不杀）、`select-window`、`split-window -h|-v -t <name> -c <worktree>`、`list-windows -t <name> -F '#{window_index}|#{window_name}|#{window_active}'`。接口 `GET/POST /sessions/:id/windows`、`POST /sessions/:id/windows/:idx/select`、`DELETE /sessions/:id/windows/:idx`、`POST /sessions/:id/split {dir}`。
- **kill**：`kill-session -t <name>`，只在根收工（`finishTask` 的 done / ignored）时调。
- 后台查询（只读）任务同样进 tmux，但**不建 worktree**：cwd = 主仓，只读靠现有 `WRITE_TOOLS` deny hook。

## 4. 启动脚本：两段（`runner.ts` `buildScript`）

Claude Code 的 cwd 在拉起那一刻定死（文件工具、transcript 路径、`--resume` 都跟它），所以 worktree 必须在拉起干活的 Claude **之前**建好，而建 worktree 又要按项目规则、归终端里的 Claude。折成两段，都在 tmux session 里跑，用户看得见：

```
cd <repoDir> || exit 1
<UNSET_CLAUDE_ENV>
# 准备段：按项目规则建分支和 worktree，把路径写进文件
claude -p --model sonnet --dangerously-skip-permissions --settings <id>.prep.settings.json \
  --mcp-config <id>.mcp.json '<prepPrompt>'
if [ ! -s <runs>/<id>.worktree ]; then
  curl -X POST /jobs/<id>/exit -d '{"code":2,"phase":"prepare"}'; exec zsh -il
fi
cd "$(cat <runs>/<id>.worktree)" || exit 1
curl -X POST /jobs/<id>/worktree -d "{\"path\":\"$PWD\"}"
printf '\033]0;%s\007' "$(basename "$PWD")"
# 干活段：和现在一样
script -q <runs>/<id>.log /bin/zsh -c '<claude flags> <task>'
code=$?
curl -X POST /jobs/<id>/exit -d "{\"code\":$code}"
exec zsh -il          # session 留着，直到根收工
```

- `prepPrompt` 要点：①先查项目自己的规则（CLAUDE.md、项目 skill、CONTRIBUTING、现有 worktree 与分支惯例），没有才用通用规则：分支按 `BRANCH_RULE`，worktree 建在主仓兄弟目录 `../<repo>-<branch-slug>`；②基线：`base` 任务的分支或默认分支，先 `git fetch`；③按项目方式装依赖（前端仓库可 `cp -c` 从主仓克隆 `node_modules` 再 `pnpm install --prefer-offline`）；④把 worktree 绝对路径写进 `<runs>/<id>.worktree`，不改任何业务代码，不 push；⑤**任何名字不带 friday**。挂现有 guard hook（push / merge / rebase / reset --hard / rm -rf 一律 deny）。
- 准备段失败（文件没生成或 `code=2`）：根标 `blocked`，原因指向 `<runs>/<id>.log`，session 留着让用户进去看。
- 缺陷开工不走这段：`/tasks/:id/start` 和 `startAutonomousJob` 先解析 `rootId`，根有 session 就 `say` 进去（现有 `handOffToStory` 泛化为 `joinRootSession`，判据从「story 的终端此刻活着」改为「根的 session 存在」；session 处于 `exited` 则先 `resumeInSession` 再 `say`）；根没 session 就先给根开（根没 `project` 时从缺陷继承并写回）。
- `--resume` 接回：`resumeInSession(sessionId)` 在同一 session 里 `send-keys` 一条干活段命令（`claude <flags> --resume <claude_session_id> || claude <flags>`），新建 job 行；替代 `reopenTerminal`。
- 自主任务：干活段是 `claude -p --model opus …`（`autonomousPrompt` 不变），退出后 session 留着（shell），用户可「看终端」进去翻 scrollback。`onJobExit` 照旧解析报告。

## 5. worktree 生命周期

- **建**：根第一次开工时，由准备段的 Claude 建（§4）。不在任务建立时建。
- **记**：`sessions.worktree` / `branch`；`task.source.worktree` / `repoDir` 继续写在根任务上供 `git_merge` 用。
- **收**：终端里的 Claude 调 `friday_finish` 时自己合 MR、按项目规则删 worktree 和分支（工具描述补这一句）。**Friday 自己从不删 worktree**：`finishTask`（done / ignored）只 `kill-session`；之后若 `worktree` 路径仍存在，记账 `worktree_kept` 并留在 `GET /worktrees/leftover` 列表里，设置页「遗留的 worktree」逐条显示路径、分支、脏不脏，用户点删才 `git worktree remove`。有未提交改动的 worktree 默认拒绝，只有用户在设置页二次确认（「连改动一起删掉」，带 `force`，账本记 `irreversible`）才连改动一起删；分支一律只用 `git branch -d`（拒绝就留分支并说明）。`fridayWorktree` / `addWorktree` / `cleanupTaskWorktree` 删除；`removeWorktree` 保留给手动删。
- 老的 `<项目>/.claude/worktrees/friday-*` 一并出现在遗留列表里。

## 6. 内嵌终端（前端 `views/Terminal.tsx`，后端 `api/pty.ts`；从 `1668499^` 捡回骨架）

- 后端：`POST /sessions/:id/attach {cols, rows}` → node-pty spawn `tmux -L friday attach -t <name>`，返回 attach id；`GET /sessions/:id/stream?attach=` SSE 推输出；`POST /sessions/:id/input {data}`、`POST /sessions/:id/resize {cols, rows}`；前端卸载或 SSE 断开 → kill 该 node-pty（只是断一个观众，进程不受影响）。首次 attach 前先 `capture-pane -p -e -J -S -3000 -E -1 -t <name>` 灌进 xterm 作历史，再 attach（attach 只重绘当前屏，不会重复）。
- 输入 `\r` 时写 `last_input_at`；xterm 容器可见且 `document.hasFocus()` 时 `POST /sessions/:id/seen`（visibilitychange / focus / 切任务时各发一次）。
- xterm：`@xterm/xterm` 6 + `addon-webgl`（失败回退 canvas）+ `addon-unicode11` + `addon-fit` + `addon-web-links` + `addon-search`。`allowProposedApi: true`，字体和主题读用户 Ghostty 配置（`~/.config/ghostty/config` 的 `font-family` / `font-size` / `theme`，读不到用 JetBrains Mono 13 + 当前主题）。
- **中文输入法**：监听 xterm textarea 的 `compositionstart/end`，组合期间 `attachCustomKeyEventHandler` 返回 false 不让 xterm 编码按键；组合结束由 `onData` 一次性送出。这是 Orca 专门修过的地方（其 `terminal-ime-composition-tracker` / `native-text-forwarder`），必测。
- **快捷键**（终端聚焦时 ⌘ 组合归终端层，Friday 全局只留 `⌘N` 会话、`⌘\` 收列表、`⌘↑↓` 切任务；**Friday 搜索改为 `⌘P`**）：`⌘T` 新窗口、`⌘W` 关窗口、`⌘1…9` / `⌘⇧[` `]` 切窗口、`⌘D` / `⌘⇧D` 分屏、`⌘F` 搜 scrollback、`⌘+ - 0` 字号、`⌘C / ⌘V` 复制粘贴。终端顶上一排窄标签显示 tmux 窗口（`1 · claude / 2 · pnpm dev / ＋`）。页面上不显示快捷键提示，写进设置页。
- 弹出：设置页「终端」一节写明 `tmux -L friday attach -t <session>`；`settings.terminal` 字段保留但只影响这条提示的示例。

## 7. 界面（任务页；顶栏改动见 C）

- **列表**（右栏，位置不变）：分组照旧（关注 / 阶段），缺陷嵌在需求下缩进一级。每行：状态点 + 标题 + 一句灰字。你在做的写 `状态位 · 最近一轮 HH:mm`；Friday 自主的写 `交付了 · N 个文件 · 测试全过 · $x`；缺陷写 `缺陷 #id · 阶段 · 在需求的会话里改`。「Friday 推断」的挂靶列在需求下带虚线框，「是它，进会话 / 不是这条」两个动作。底部「已完成 N ›」。顶部那排统计卡（TERMINALS / 进行中…）删除。
- **详情 · 你在做的**：状态行 + 标题（旁一个带面板图标的「详情」小按钮）+ 一行灰字（worktree 路径 · 分支）+ tmux 窗口标签 + 终端占满余下高度。没有页签、没有输入框、没有操作条、没有快捷键提示。
- **详情 · Friday 自主的**：同样的头（灰字多 `Friday 自主 · opus · $x · N 分钟`，右侧「看终端」切到同一 session 的终端），主体是卡片，段落按审核顺序：交付报告 + 截图 → 等你点头的动作 + 验证点 → 改动（文件列表 + 增删行数，相对主干；diff 视图留位）→ 阶段条 + Meegle；右列资料、Slack 讨论、操作记录链接。底部是这条任务的 Friday 会话。
- **详情弹窗**（点「详情」，整页居中、背景毛玻璃，`Esc` / × 关）：标题行（任务名 · 详情 · ··· · ×）；左列阶段条（可拨）、Meegle 节点 / 优先级 / 排期、名下缺陷（各带阶段；「Friday 推断」项带「是它，进会话 / 不是这条」）、理解；右列资料、Slack 里的讨论（人名换成显示名）；底部这条任务的 Friday 会话。「···」里：标记完成 / 完成当前节点 / 忽略 / 操作记录。
- **资料**：无类型链接列表，`＋ 贴一个链接`；标题异步取：飞书域走 `lark-cli`（具体子命令实现时看 `lark-cli docs --help`），其他取 `<title>` / `og:title`，取不到显示域名 + 末段路径；只显示标题，hover 全 URL，右键复制 / 打开（`LinkMenuHost`）。编辑只有加和删。
- **会话组件**：`Thread` 的紧凑模式，弹窗底部、自主卡底部、顶栏「会话」视图三处同一份代码；消息两列（`你 / Friday` 标签 + 正文），底部一个输入框，右侧灰字「@ 引入文件」。`@` 弹层三类：文件（`git -C <worktree> ls-files` + 未跟踪，模糊匹配）、资料（本任务 `docs`）、截图（本任务附件）；选中后文件内容经 `agent/content.ts` 作 text / image 块随 `/ask` 送出（文本 10 万字截断），消息里 `@name` 高亮。会话里可说的动作：标记完成 / 忽略 / 完成当前节点 / 拨阶段 / 挂靶纠正（现有 `task_update` + 新增 `task_approve` / `task_reject` 批准或打回待审动作；`slack_reply` 类不可逆的先贴原文，用户说「发」才发）。Friday 说「已 …」之前必须真调过工具。
- **删除**：「终端在做」（`fx__doing`；`GET /jobs/:id/activity` 与 `jobs_activity` 工具保留给 Friday）、「这条任务的账」展开、PROGRESS 块、SCHEDULE 独立块（排期并进元信息行）、四槽 DOCS 编辑器、底部操作条、「重开终端 / 打开终端」按钮、任务卡里「和 Friday 聊」中段、页头统计卡。

## 8. 归属（本轮范围）

- 只做「缺陷进所属需求的 session」这条已有规则的落地：`/tasks/:id/start`、`startAutonomousJob`、自动开工都先解析 `rootId`（§4）。
- `guess` 级（Friday 推断）的 Slack 挂靶**不自动进会话**：任务建到需求下、列表和弹窗里标「Friday 推断」，用户点「是它，进会话」才 `say`。指纹、文档链接 / 角色成员信号、会话 `attach` 工具、跨来源 `merge` 归 B。

## 9. 依赖、打包、迁移

- node-pty 回到 `apps/core` 依赖，`bundle-core.sh` 恢复 `spawn-helper` 的 `chmod +x`（09-20 删掉的那两行）。tmux 不打进 .app。
- 数据迁移（启动时）：①`docs` 四槽 → 数组；②给 `linkedStoryId` 的缺陷补 `rootId`；③没有 `conversationId` 的开着的任务各建一段会话；④升级后第一次启动，把仍标 running 且没有 `session_id` 的旧 job 标 done(-1)，任务 `progress` 写「旧版终端已不可接回，需重新开工」——Ghostty 层删掉后无法再问窗口在不在，一次性收掉。
- CLAUDE.md：工作台几节改成现状（顶栏、列表在右、详情即终端），「终端：外部 Ghostty」一节改写为 tmux。

## 10. 实施顺序

1. tmux 层 + 两段脚本 + `sessions` 表 + 对账（先让交互式任务在 tmux 里跑起来，前端仍无终端，用 Ghostty attach 验）
2. node-pty 客户端 + SSE/POST + xterm 组件 + IME + 快捷键 + 窗口标签
3. 状态位 `sessionState` + seen + 列表灰字 + 元信息行
4. 详情翻转：你在做的（终端）/ Friday 自主的（卡片）/ 详情弹窗 / 删块
5. 会话：建任务即建会话、`Thread` 紧凑模式三处复用、`@` 引入、`task_approve / task_reject`
6. 资料列表 + 标题解析 + 迁移；worktree 遗留列表；`friday_finish` 描述
7. 删 `ghostty.ts` 及一切引用、迁移旧 job、CLAUDE.md

每步一个 commit，UI 步骤（2、4、5）完成时按 §12 对图截屏。

## 11. 测试

- 单测：tmux 命令构造、两段脚本、`sessionState` 状态机（七种状态与优先级）、`rootId` 解析与 `joinRootSession`、docs 迁移与去重、`PendingAction.at` 的「等了 N」。
- 手动（`FRIDAY_PORT=7791 FRIDAY_DATA_DIR=<临时> FRIDAY_NO_SCHEDULER=1` + vite 1421，agent-browser 截图）：①点一条需求「开始做」→ tmux 里出现 session，准备段在主仓建出 `../<repo>-<branch-slug>`，干活段起在里面，列表行状态变「干活中」；②`kill` sidecar 再起 → xterm 重新 attach，历史在，session 名和状态对得上；③给同需求的缺陷点「开始做」→ 消息 `say` 进同一 session，不开新的；④Claude 说完 → 「等你输入」；切走再切回、窗口聚焦 → 清掉；⑤在 xterm 里用中文输入法敲一句完整中文，字不丢不重；⑥`⌘T` 开窗口、`⌘W` 关、`⌘D` 分屏；⑦从 Ghostty `tmux -L friday attach` 接同一 session，两边同屏；⑧标记完成 → session 消失，worktree 若脏出现在遗留列表；⑨`⌘P` 搜索仍可用，终端聚焦时 `⌘K` 到达 shell。
- 工作量：2–3 天。B、C 另估。

## 12. 设计稿对照清单（完成 UI 步骤时逐条勾，附截图）

对着 `./2026-09-29-tmux-session-terminal-design/` 四张画板。**每条都要在真实界面上核对，不是看代码**。

**Main.dc.html · 你在做的任务**
- [ ] 详情区从上到下只有：状态行、标题行（标题 + 「详情」小按钮 + 灰字提示「N 条缺陷 · N 份资料 · N 段 Slack 讨论」）、分支行（worktree 路径 · 分支）、tmux 窗口标签条、终端。没有页签、输入框、操作条、快捷键提示、弹出按钮。
- [ ] 状态行文案顺序：`● 状态位 · 阶段 · 来源 · 项目 · 排期 MM-DD · 最近一轮 HH:mm`，右端「★ 已关注」。状态位颜色：在问你 / 卡住 红、干活中 青（带光晕）、等你输入 / 待你决定 琥珀、Claude 已退出 空心灰。
- [ ] 窗口标签条：`1 · claude`（选中态有底色）、其他窗口灰字、末尾「＋」。
- [ ] 终端占满余下高度，圆角 8，深底 `#05080c`。
- [ ] 右栏列表：搜索框（`FIND` + 占位文字，无快捷键角标）→ 分组（关注 / 进行中 / 测试中 / 未开始）→ 每行状态点 + 标题 + 灰字；缺陷缩进、小一号灰点；底部「已完成 N ›」。无统计卡、无页头问候。

**Drawer.dc.html · 详情弹窗**
- [ ] 整页居中，宽约 1040，背景整页毛玻璃模糊（含列表和终端）。
- [ ] 标题行：任务名 · 「详情」灰字 · 右端「···」「×」，互不重叠。
- [ ] 左列顺序：阶段条（五个 chip，可点）+ 「Friday 推的，原来在…」→ Meegle 一行 → 名下的缺陷（每条：点、标题、`#id · 阶段 · 一句`；推断项虚线框 + 「是它，进会话」「不是这条」）→ 理解。
- [ ] 右列顺序：资料（标题右端「＋ 贴一个链接」；每条 `来源灰字 + 标题`，无类型槽位）→ Slack 里的讨论（`与 X 的私聊 · 依据` + 「不是这条」；正文 `人名：内容`，人名是显示名不是 ID）。
- [ ] 底部横跨两列：「和 Friday 聊这条任务」标签 → 消息列（`你 / Friday` 两列对齐）→ 输入框（左 `›`，右灰字「@ 引入文件」）。
- [ ] 「···」菜单里有：标记完成 / 完成当前节点 / 忽略 / 操作记录。

**Card.dc.html · Friday 自主任务（2026-09-30 改：去掉交付报告卡，详情直接铺在面板上）**
- [x] 头部同 Main，标题行右端只有「看终端 / 看详情」切换和「···」（标记完成 / 完成当前节点 / 忽略 / 归到项目… / 操作记录），没有「详情」按钮；按钮不折行。分支行 `worktree · 分支 · Friday 自主 · 模型 · $成本 · 耗时 · N 个文件 +a −b`。
- [x] 面板从上到下：等你点头（琥珀框，写明做什么、后果、在会话里说哪句执行）/ 排队中的「什么时候开 + Friday 的判断」→ 详情弹窗的两列（阶段条 + Meegle、项目 / 并入、名下缺陷、理解、工单描述 ‖ 资料、Slack 讨论、操作记录）→ 会话。
- [x] 交付看会话：Friday 的交付消息写概要、测试结果、请你验证（后台查询多写依据），截图挂在这条消息下面；friday_done 交付的截图在退出时补一条。卡上不再有交付报告、验收勾选、改动文件列表。
- [x] 看终端时，Claude 已退出就在终端上方给一行「Claude 已退出 · 接着聊」。
- [x] 底部会话组件与弹窗里的是同一组件；交付内容都在会话里，会话占余下高度，详情最多 42%。

**States.dc.html · 状态位与列表行**
- [ ] 七种状态的点形状与颜色和表一致；只有「待你决定」带「等了 N」。
- [ ] 需求行右端显示分支名灰字；缺陷行缩进、`#id · 阶段 · 一句`；「Friday 推断」行带两个动作。

**Idle / IdleReady.dc.html · 没开工（2026-09-30 补）**
- [x] 还没开工、也不归 Friday 自己做的任务，主区是虚线空态，不铺旧卡：「还没开工，差一步」/「可以开工了」+ 逐条待办（项目、Friday 要问你、等你点头、工单描述）+ 一句怎么开工。没有按钮，「选项目…」只是打开详情弹窗。
- [x] 状态行里项目没定标琥珀色「项目没定」；分支行写「还没有 worktree · 开工时按项目规则建」。
- [x] 详情弹窗左列在 Meegle 那行下面多「项目」「并入」两行（原来只在旧卡上，藏了旧卡就没处选）；缺陷的工单描述放在「理解」下面。

**Queued.dc.html · Friday 判成能自己做（排队中）**
- [x] 开关开着、门禁除「等描述稳定」和并发外都满足的，不走「差一步」：状态行「排队中 · HH:mm 开工」+ 虚线圈点；列表灰字「Friday 会自己开工 · HH:mm」。
- [x] 主区同自主任务的卡：什么时候开 / Friday 的判断（把握、为什么、项目、打算）/ 阶段条 + Meegle；底部会话框，占位「先别做 / 这条我来 / 项目不对，是 …」。
- [x] 卡上没项目时用 intake 判的（须在注册表里），开工时写到卡上并标 `projectBy: friday`。

**Rollback.dc.html · 改项目 = 看谁干的活**
- [x] 还没开工：直接改。你自己终端里干的：关终端、worktree 留着进遗留列表。Friday 自主干的：挂一条「项目判错」待审动作，清单列出要删的 worktree、分支、没提交的文件数，说「撤掉」才执行，删完记成打回（项目判错）并在新项目上重开；改回原项目 = 撤掉清单。已合进主干的拒绝，让你自己 revert；远端数据不在自动回退范围。
- [x] 卡上「项目」行把旧项目划掉；会话占位「撤掉 / 算了，还是 X」。

## 13. 后续（不在本轮）

- **B 归属**：根 + 指纹（工单号 / 文档链接 / 人 / 频道 / 别名）、确定性梯子（文档链接、唯一角色成员两条新信号；频道名字面匹配降为候选）、会话 `attach` 工具与 `task_add.parent`、跨来源 `merge`、Meegle 容器出现时对现有根提议并入。
- **C 顶栏与自学**：顶栏只留 `FRIDAY · [会话 | 任务]` + 右上状态簇（终端数 · 用量 · 模型 · ···），操作记录 / 会话历史 / 用量 / 设置收进「···」与 `⌘P`；删「全部任务」页与页头统计；删 AI 热点整条链路；`learn-history` 改每天 12:00，审核卡逐条「要 / 不要」，无候选也出卡。
- 独立小修（先做）：Slack 前文按 ID 换显示名（私聊两人零调用、频道走花名册、前文行存 `userId`）；私聊标题「张亮 与 张亮 的私聊」去重。
- diff 视图、本机文件资料、浏览器能力（agent-browser 专属 profile）、闲置休眠、libghostty 渲染层。
