# 外部工具注册处与风险分级（设计稿）

2026-10-23。路线里的第一块（底座），后面的「审批与自主度」「口径对齐」「第二道质量保障」「提测 / MR / 发布」都建在它上面。

## 一、为什么做

用户重新定了 Friday 的定位：**Friday 是 agent helper，开发者的活（需求分析、开发、自测）交给它，用户只审批**。Friday 本体是一条流水线加记忆与学习；Slack、Meegle、Lark、OKR、浏览器、内部网关、发布系统都是流水线上用到的**外部工具**，应该「找个地方注册进去」，而不是 Friday 自带。

现状正好相反：

- 外部系统的客户端写在 `connectors/`，而它们的规则散在 Friday 业务代码里。core 约 65 个非测试文件、前端 14 个文件出现 Meegle / Slack / Lark / OKR 字样：Meegle 的终态名（含 WON'T FIX 的随机 key）、缺陷类型键、`_field_linked_story`、Slack 的 Block Kit、噪音规则、窗口标题四种形态、`SELF_HOSTS`、`meegleIdsIn` 正则……
- 数据模型里也写死了：`TaskSource` 十几个 `meegle*` / Slack 字段，`TaskKind` 有 `slack` / `meegle`，`LinkKind` 有 `meegle` / `slack` / `thread` / `channel`，库里有一张 Slack 专用的 `inbox` 表。
- 操作分级 `agent/permission.ts` 至今只有类型；不可逆动作的闸门各写各的（`slack_reply`、`git_merge`、`okr_submit`）。
- **现存漏洞**：Friday 驾驶的终端会话（`agent/runner.ts` 的 `claudeArgs`）只传 `--mcp-config`、没传 `--strict-mcp-config`，于是自主任务里的 Claude 会加载用户 `~/.claude.json` 里的全部 MCP——包括 coral 网关的 `deployApi` / `deleteApi`、inner-gateway 的 `applyRpc` 等写操作——又开着 `--dangerously-skip-permissions`，守卫拦不住。`/ask` 那边已有 `strictMcpConfig: true`，只有终端会话漏了。

## 二、目标、非目标、反目标

**目标**

1. Friday 业务代码不再含任何外部系统的规则；外部调用一律经注册处的统一入口。
2. 每个外部工具的每个操作有风险等级，**在调用这一刻**按等级放行 / 记账 / 挂待审，替代散落的闸门。
3. 接新工具 = 在对话里说一句，Friday 自己找直连方式、列操作、提议等级、起草使用场景，用户确认后生效。
4. 模型驱动的会话按需加载工具，不把全部工具定义常驻上下文。
5. 堵上终端会话加载全局 MCP 的漏洞。
6. （第二步）任务数据里的来源字段统一成通用的外部引用，Friday 的数据模型不再认识具体来源。

**非目标**

- 不把现有接入挪成外部进程。注册处不关心工具怎么跑，内置模块和外部 MCP 一视同仁；哪个工具以后真要外移，只改它自己那条登记。
- 不为假想的第二个来源设计角色接口。角色接口照 Friday 今天对 Meegle / Slack 的实际用法来定，名字中性即可。
- 本机能力不进注册处：git、tmux、worktree、守卫、`localDev`（lsof）、`stageWatch`。
- 「访问真实产出」（canary 登录方式、项目环境描述）这次不做，已搁置；但注册处要能容纳「登录方式」作为一种工具。
- 不改审批界面与审批体验（那是下一块「审批与自主度」），这次只把分级落到调用点。
- 不做口径对齐、二道保障、提测发布等任何新流水线能力。

**反目标**（技术上做完了也算失败）

- 同步行为退化：Meegle 新建 / 更新 / Reopen 拉回 / 关单待撤 / 自动收工、Slack 挂靠 / 查询 / 已读已回对账，任何一条行为和改前不一致。
- Friday 驾驶的会话能在没有用户点头的情况下，执行**已登记工具**的任何不可逆操作——无论经 `tool_call` 还是经 Bash 直接跑它底下的命令行。（未登记的命令行是已知旁路，见 4.6。）
- 用户自己驾驶的终端（项目页）失去他平时用的 MCP。
- 第二步迁移弄坏或丢失在办任务的数据。

## 三、用户已经定了的

- 外部工具注册进 Friday 自己的注册处，**不能**直接用 `~/.claude.json` 当注册处（否则终端里的 Claude 能绕过审批）。`~/.claude.json` 只是 Friday 发现连接方式的地方之一。
- 接入方式：用户说要接什么，Friday 自己查有没有能直连的方法。
- 能力装成 MCP（或包装成操作的命令行），skill 只做可选的使用说明——风险分级只能管住经 Friday 转发的调用。
- 每个工具带一段使用场景描述，Friday 据此知道何时加载它。
- 堵漏洞（`--strict-mcp-config`）并进这次一起做。
- 分两步：**第一步拆代码**（字段不动），**第二步迁数据**（统一外部引用）。理由：同时改出问题分不清是哪边错，在办任务全部依赖这些数据。
- 生产环境不给 Friday 驾驶的会话任何登录态；测试环境和 canary 是同一个（与本稿相关处：将来「登录方式」工具只登记 canary）。

## 四、设计

### 4.1 一条登记包含什么

| 字段 | 说明 |
|---|---|
| `name` | 唯一名，如 `meegle`、`slack`、`coral`；业务代码按角色找工具，不写死名字 |
| `transport` | `builtin`（core 进程内模块）/ `mcp_http` / `mcp_stdio` / `cli` |
| `connection` | 按 transport：builtin 的模块名；mcp 的 `~/.claude.json` server 名（**不复制凭证**，每次现读，同 `connectors/mcp.ts` 现在的做法）或 stdio 命令；cli 的可执行文件名 |
| `ops` | 操作清单：名字、说明、参数 schema、**风险等级**、等级是谁定的（`friday` 提议 / `user` 确认） |
| `scenario` | 使用场景描述：解决什么问题、在流水线哪一环、什么信号出现时该用。≤300 字 |
| `skill` | 可选：附带的 skill 名，多步用法的门道 |
| `projects` | 可选：只对哪些项目可用；空 = 全部 |
| `roles` | 可选：它实现了 Friday 的哪些角色（见 4.4），只有 builtin 会有 |
| `binaries` | 它底下用到的可执行文件（如 `meegle`、`lark-cli`），守卫据此拦 Bash 直调，见 4.6 |
| `enabled` | 开关 |
| `health` | 最近一次健康检查的时间与结果 |

存储：SQLite 新表 `tools` + `tool_ops`（我的决定：要带撤销和账本，结构化存比 markdown 合适；同 `schedules` 的做法）。

### 4.2 风险等级与统一入口

等级沿用 `PermissionLevel`：`read` / `reversible` / `irreversible`。

- **`reversible` 必须声明怎么撤**：登记时指明撤销用哪个操作及参数怎么来——取自调用的返回值（如 create → delete 用返回的 id），或取自**调用前的一次只读快照**（如 Meegle 流转：调用前先读当前状态，撤销 = 流转回这个状态，即现在 `meegle_state` / `meegle_node` 回滚的做法）。外部系统上说不清怎么撤的，一律算 `irreversible`。（我的决定：否则「可逆」只是一句空话。）
- **默认拒绝**：工具升级后 `tools/list` 冒出来的新操作，没定级前不暴露给任何调用方，Friday 在主对话里提一句让用户定级。
- **统一入口** `invokeTool(caller, tool, op, args)`，所有外部调用只走这里。`caller` 分四类：
  - **Friday 自己的代码**（同步、门禁、依赖判定、执行待审动作）：`read` / `reversible` 直接执行（`reversible` 记账带 undo）；`irreversible` **必须带一个已批准的待审动作 id**，否则抛错。这让「不可逆必须你点头」从约定变成调用点上的硬约束。
  - **用户在界面上直接点的**（如 `POST /tasks/:id/transition`）：点击本身就是点头，各等级都直接执行；`reversible` 照样记账带 undo。
  - **模型驱动的会话**（主对话 `/ask`、HUD、经 bridge 的终端 Claude）：`read` 直接执行；`reversible` 执行并记账；`irreversible` **不执行**：
    - 会话属于某条任务（终端 job 的 owner、或主对话里点名了 `#N`）→ 挂一条待审动作（新类型 `tool_call`，payload 存 tool / op / args / 发起的会话），返回「已挂待审，等用户点头」，批准走现有的 `task_approve` 与卡片按钮，界面不变。
    - 主对话里没点名任务 → 不挂待审，走 `worktree_remove` 那套两步同意：第一次调用只返回后果说明让 Friday 转告，用户在之后新说的一句里整句同意，且 tool / op / args 与问的那次一致，才执行。（我的决定：不新增存储，也不改审批界面。）
  - **定时任务的 `call` 执行方**（无人值守）：登记定时任务时用户已原样确认过 tool / op / args（现有规则），视为对**这一组参数**的长期同意，各等级照执行；参数和登记时不一致一律拒。`validateSchedule` 改为校验注册处（工具已登记、已启用、操作已定级），不再直接看 `~/.claude.json`。升级时已有的 `call` 定时任务若指向未登记的 server，暂停并在主对话里说明「先登记工具 X 再打开」。（我的决定。）
- 现有的不可逆待审动作（`slack_reply` 发送、`okr_submit`、`meegle_update` 等）在执行时改为经 `invokeTool` 带上自己的动作 id 调用；待审动作的类型与界面不变。
- 每次调用写 `activity`（已有表）；`reversible` / `irreversible` 写 `audit`（已有表），`evidence` 记调用方和发起它的那句用户原话（有会话时，同 `selfTools.ts` 的 `saidLast`）。

### 4.3 接入流程（对话里）

新增会话工具（`agent/selfTools.ts` 一族，分级规则同「对话里管自己」）：

1. `tool_discover(name)`：按顺序找直连方式并返回候选——`~/.claude.json` 的 http MCP → stdio MCP → PATH 里的命令行（`which` + `--help`）→ 已装的 skill（只有 skill、底下也没有 CLI 的，报告「Friday 调不了，只能交给终端里的 Claude」）。MCP 候选顺带 `tools/list` 拿到操作清单。
2. `tool_register(…)`：写一条**草稿**登记：操作清单 + Friday 提议的等级（按操作名和描述判断，`get` / `list` / `index` / `describe` 类提议 `read`，写类提议 `irreversible`，拿不准的一律 `irreversible`）+ 起草的场景描述。返回一份清单让 Friday 转告用户。
3. 用户确认（可以改等级、改场景）后 `tool_update` 定稿并 `enabled`。定稿要整句同意（`agent/consent.ts`），同 `worktree_remove` 的两步法：先问、后一句用户新说的话里同意才生效。
4. `tool_update` / `tool_remove` / `tools_list`。记账 `tool_registered` / `tool_updated` / `tool_removed`，`undo: restore_tool` 存改前快照。定时会话里一律拒（同其他写配置的工具）。

CLI 的操作包装：`cli` 工具的每个操作是「命令模板 + 参数 schema + 输出按 JSON 解析」。模板由 Friday 读 `--help` 起草、用户确认。`execFile` 传参，不经 shell。

设置页加一节「外部工具」：只读列表（名字 · 连接方式 · 健康 · 各等级操作数 · 开关）。增删改走对话。（我的决定：同「对话里管自己」的原则，页面上能看、对话里能改；改等级这种需要讲清后果的事放对话里更稳。）`/health` 带每个工具的健康结果。

### 4.4 Friday 代码怎么调：角色

Friday 自己的代码按**角色**找工具，设置里 `roles: { workItems: "meegle", chat: "slack", docs: "lark", web: "web" }` 绑定。角色是 core 里定义的 TS 接口，只有 builtin 工具实现（MCP / CLI 工具不实现角色）。

**builtin 工具同时给模型会话暴露 `ops`**（我的决定）：至少覆盖今天模型会话里在用的读能力——`meegle` 取一条工单、`lark` 读文档、`web` 读网页、`slack` 取一段对话的前文；写操作按等级暴露（`slack` 发送为 `irreversible`）。这样建卡提示词里「用 lark-doc skill 读 PRD」改成「`tool_call lark read`」，守卫拦 `lark-cli` 后建卡不退化。主对话里那些 **Friday 自己的动作**型会话工具保留原样：`meegle_add`（建任务）、`meegle_sync` / `slack_sync`（触发一轮同步）、`okr_weekly`（起草周报）——它们是「让 Friday 做某件事」，不是「调外部工具」，内部改为经角色调用即可。

接口照今天的实际用法定，返回**归一化**的结果：

- `workItems`：列出分派给我的、取一条、按意图流转（`transition(id, "in_progress")`，用哪条流转由工具自己决定）、从 URL / 文本里认出工单号。归一化字段至少有：`kind`（story / defect / other）、`state`（open / in_progress / testing / done / reopened）、`stateLabel`（原文，给界面显示）、`parent`（缺陷挂的需求）、`docs`、`schedule`、`tags`。终态判定、In Testing 判定、类型键、关联需求字段都在工具里。
- `chat`：增量收件（@ 我 / 私聊，已挡噪音、已取 Block Kit 正文、已拼对话键）、取前文、已读 / 已回状态、频道最近消息、私聊最近消息、按窗口标题认出当前会话（HUD 用；四种标题形态的解析在工具里）、账号名换显示名、发送、撤回。发送 / 撤回是 `irreversible`。
- `docs`：读文档正文与版本号、取标题、从 URL 认出是不是它的文档。
- `web`：读网页（分段）、读前先按 host 注入登录态（即现在的 Chrome Cookie 那套，整体挪进这个工具）。

URL 分类（`connectors/urlSource.ts`）改成：先问每个启用工具的「这是不是你的 URL」，都不认再走 Friday 自己的 `local_dev` / `project_page` / `other`。`gitlab_mr` 目前没有工具认领，留在 Friday 当 `other` 前的一条规则，第五块「提测 / MR / 发布」接 GitLab 时再挪。

### 4.5 模型驱动的会话：按需加载

- 主对话、HUD、终端 Claude 平时只看到一个**目录**：每个可用工具一行「名字 · 场景描述」（按 `projects` 过滤到当前项目）。主对话放进 system，终端放进 `terminalBridgePrompt`。
- 两个通用工具：`tool_describe(tool)` 返回该工具已定级、已启用的操作与参数 schema；`tool_call(tool, op, args)` 走 `invokeTool`。主对话经 `agent/tools.ts` 的进程内 MCP 提供，终端经 bridge（`/mcp/:jobId`，`bridgeToolsFor` / `callBridge`）提供。
- **开工预选**：开工 / 建卡时 Friday 按项目和任务所处环节把可能用到的工具的操作定义直接写进提示词，省一轮 `tool_describe`。第一版的预选规则：工具登记了 `projects` 且命中当前项目，就预选。（更细的「按环节预选」留给后面几块按需加。）
- 已有的专用桥接工具（`friday_web_read` 等）改成 `tool_call` 的薄封装或直接删掉、改由目录提供，由实现者按兼容成本定；`/ask` 的 `web_read` 同理。

### 4.6 堵漏洞

- Friday 驾驶的会话（`kind !== "interactive"`：自主、查询、建卡、冷启动）`claudeArgs` 加 `--strict-mcp-config`，只加载 Friday 自己的 MCP。用户驾驶的项目终端不变。
- 守卫补一条（**用户定**）：Friday 驾驶的会话里，Bash 直接调用**已登记工具底下的可执行文件**一律拦下，提示「经 `tool_call` 调用」。范围包括 `cli` 工具的可执行文件，也包括 builtin 工具底层用的命令行（`meegle`、`lark-cli`、`agent-browser`）——每条登记带一个 `binaries` 列表，规则由注册处生成进守卫脚本。否则用户全局 skill 会教 Claude 绕过 bridge 直接跑命令行。
- **已知旁路，接受**：没登记的命令行（`glab`、`curl`、`harua-deploy` 等）不拦。只要还允许 Bash 就封不死；用户选择「登记一个收紧一个」，不关全局 skill（会失去 `harua-dev` / `harua-deploy`，测试阶段缺陷推 canary 那条路会断），也不做 Bash 白名单。
- 主对话 `/ask` 的 Skill 模式不动（Bash + skill 放行是用户要求的，且那是用户在场的对话）。

### 4.7 第一步：拆代码（字段不动）

把现有接入改成登记的 builtin / mcp 工具，代码放在 `apps/core/src/connectors/<工具名>/`（沿用 `connectors/` 目录，注册处在 `connectors/registry.ts`；不用 `tools/`，免得和会话工具 `agent/tools.ts` 混淆）。首次启动自动登记这几个内置工具，操作等级预置好，用户不用逐个接入。

| 现在 | 去向 |
|---|---|
| `connectors/meegle.ts` + `agent/meegle.ts` 里的 Meegle 规则（终态名、In Testing、类型键、关联需求字段、流转选择、`parseMeegleRef`）+ `memory/infer.ts` 的 `meegleIdsIn` + `memory/projectHints.ts` 的 `SELF_HOSTS` | builtin `meegle`，实现 `workItems` |
| `connectors/slack.ts`、`noise.ts`、`keychain.ts`（`friday-slack` 凭证）、`memory/roster.ts`、`agent/summon/slack.ts` 与 `match.ts` 的标题解析 | builtin `slack`，实现 `chat` |
| `connectors/lark.ts`、`agent/docTitle.ts` 里调 `lark-cli` 的部分 | builtin `lark`，实现 `docs` |
| `agent/web.ts`、`agent/chromeCookies.ts` | builtin `web`，实现 `web` |
| `connectors/okr.ts` | 登记为 `mcp_http` 工具 `okr`（server 名 `okr`）；周报流程不实现角色，直接 `invokeTool("okr", …)`，`submit` / `delete` 定 `irreversible`，经 `okr_submit` 待审动作的 id 调用 |

业务侧（任务语义）留在 Friday：同步建卡 / 更新 / Reopen / 关单待撤 / 自动收工、挂靠、查询、对账、理解卡、门禁、周报流程。它们改为只认归一化结果。**业务文件第一步不改名**（如 `agent/meegle.ts`、`agent/slack/*`），改名放第二步和数据一起做，免得两边同时动造成大量无意义 diff。

顺手删死代码：`GET /desk`、`api/desk.ts`、`agent/desk.ts`；`/todos` 路由、`Connector.fetchTodos` 接口、`connectors/index.ts`、`memory/todos.ts` 的读写、Meegle 同步写 `todos`、前端 `syncTodos` / `openTodos`。**`todos` 表本身不删**（库里的数据删了撤不回，不读不写即可）。

### 4.8 第二步：迁数据

- `TaskSource` 的来源字段收成一个 `external?: ExternalRef`（这条任务从哪来）：`{ tool, type, id, url?, kind?, state?: { key, label }, parent?: { id, name }, schedule?, tags?, attrs? }`。**业务代码只读核心字段**；只有工具自己认识的值（Meegle 空间 key、节点 key、Slack 的 channelId / threadTs 等）进 `attrs`，由工具解释。`mergedMeegleIds` / `merged` / `storyContainer` / `meegleClosed` 这类是 Friday 自己的语义，改成中性名留在 `TaskSource`。字段对照表由实现者在计划里列全，每个现有字段都要有去处。
- `TaskKind` 的 `slack` / `meegle` 改成 `conversation` / `work_item`；`TaskCategory` 的 `slack` 改成 `conversation`。
- `links`：`meegle` / `slack` / `thread` / `channel` 改成一种 `ext`，`ref = <工具>:<类型>:<id>`。表上有 `CHECK` 约束，要重建表。
- `inbox` 表改成通用收件表，加 `tool` 列，Slack 专属列进 `attrs`。
- 前端 14 个文件、`packages/shared` 跟着改。
- **迁移规程**：一次性、带版本标记（`sync_state` 的 `migration:external-refs`），整体在事务里；迁移前用 `VACUUM INTO` 或 SQLite 备份接口留一份备份（**不要 `cp` 库文件**：WAL 没落盘会误判，踩过）；迁移后核对每类实体的条数一致。先在真实库的副本上跑、核对、再上真库；重复执行是 no-op。

## 五、约束

- 遵守 `CLAUDE.md` 全部约定：core 能脱离壳独立跑和测；外部文本进 prompt 过 `untrusted()`；中文提交、每个功能点一提交、不覆盖 git author。
- 真机验证用现成规程：`FRIDAY_NO_SCHEDULER=1`、临时 `FRIDAY_DATA_DIR`、`FRIDAY_TMUX_SOCKET=friday-verify`、假 `claude` 脚本、`PATH` 前置记调用的假 `meegle`；只 kill 自己 `$!` 记下的 PID，验证前后看 `/dev/ptmx` 数。
- 做完更新 `CLAUDE.md`：「架构（已定，不要更改）」一节改成「Friday 本体 + 注册的外部工具」；`connectors/` 目录约定改写；Slack / Meegle 各节里提到的文件路径同步。

## 六、验收

**第一步**

- 在 `connectors/` 之外 grep 不到外部系统的规则：Meegle 状态名 / 类型键 / 字段键、Slack API 方法名与 URL、`lark-cli` / `meegle` / `agent-browser` 的直接调用、`SELF_HOSTS`。（`TaskSource` 字段名例外，第二步处理。）
- 现有测试全过；Meegle / Slack 同步、挂靠、查询、对账的行为测试改为针对角色接口，覆盖反目标里列的每一条。
- 真机：用假 `meegle` 跑一轮同步，结果与改前一致；在主对话里接入 coral 网关（`tool_discover` → `tool_register` → 用户同意 → 定稿），然后在一个 Friday 驾驶的终端会话里：目录里看得到 coral、`tool_call` 一个只读操作成功、调一个 `irreversible` 操作得到「已挂待审」且没有真的执行；同一会话里 `claude` 加载的 MCP 列表不含用户全局的 coral / inner-gateway / okr；Bash 直接跑 `meegle`、`lark-cli` 被守卫拦下；建卡会话经 `tool_call lark` 读到 PRD 正文。
- 用户驾驶的项目终端仍能用他的全局 MCP。

**第二步**

- 在真实库副本上迁移：任务、links、收件各自条数前后一致；随机抽 20 条在办任务，前端详情、来源链接、Slack 讨论、缺陷挂需求都显示正确；再跑一次迁移是 no-op。
- 迁移后 Meegle / Slack 同步跑一轮，不新建重复任务、不误收工。
- grep 不到 `meegle` / `slack` 作为 Friday 类型里的字段名或枚举值（工具目录内除外）。

## 七、留给实现者

- `tool_ops` 的具体列、`ExternalRef.attrs` 的形状、字段对照表。
- stdio MCP 客户端的实现（仓库里已有 `@modelcontextprotocol/sdk` 1.30，可用；要显式加进 core 依赖）以及进程复用方式。第一步没有 stdio 工具要接，可以只把接口留好、用一个测试替身验证。
- `friday_web_read` / `web_read` 是封装还是删。
- 健康检查的频率与方式。
- 第一步内部的提交切分（建议：注册处 + 统一入口 + 堵漏洞 → 每个工具一提交 → 删死代码）。

## 八、估时

第一步 3–4 天，第二步约 1 周（含前端与迁移验证），合计约 2 周。
