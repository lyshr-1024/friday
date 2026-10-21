# 需求流程与知识库（2026-10-21）

## 起因

用户想让 Friday 自己开动更多需求。到今天为止自主开工只接缺陷，`intake` 的提示词写死「需求类一律 queue——需求通常要先对方案」。缺陷有现场（报错、页面、复现步骤），需求只有一段产品描述，Friday 得知道「这个产品长什么样、哪块归哪里、这类功能以前怎么做的」才敢动手。`projects.md` 只记目录、别名、环境链接；手册规则只记「怎么写代码」；中间缺一层「这个项目里有什么」。

和用户逐步对过一条需求从诞生到上线的流程，结论如下。

## 原则（用户定的）

- **主流程只认 Friday 自己的卡。Meegle 是来源适配器**，负责把工单翻成卡上的字段（截止日、是需求还是缺陷、文档链接、负责人、缺陷关联哪张需求）、把卡的进展回写过去。主流程里的任何判断——什么时候理解、能不能开工、怎么交付——只看卡，不看 Meegle 的节点、排期、工单类型。Meegle、Slack、口头三个来源进来是同一种卡。别人不推进 Meegle 不卡 Friday，Friday 也不替用户补单。
- **知识库里的功能是锚。** 缺陷一定属于某个功能；需求也落在功能上。
- **需求是一次发布的单位，缺陷永远挂在一张需求下。** 一个功能同一时间最多一张在办需求：有就把缺陷挂上去，没有就以这个功能开一张。修复的单位是需求不是缺陷：Friday 一轮把名下攒着的缺陷都改掉、过一遍需求的用例、交一份报告。缺陷自己没有理解卡、门禁、分支、发布单。
- **五档阶段不变**：未开始 → 进行中 → 测试中 → 待发布 → 已上线（`Stage` 已有 `accepted` = 待发布）。理解和方案压在「未开始」里。
- **接口齐了才开工**。前端是最后出结果的地方，要对完整流程负责，不拿 mock 凑。等的时候不能干等，Friday 要会催办。
- **没有现成测试用例就自己写**。验收清单是理解的产出之一，自测和交付报告都按它逐条过。
- **方案是理解的一部分**，不是单独一步。要不要用户审按项目定。
- **发布：准备归 Friday，合并归用户。** 盯 Slack 里产品验收通过的通知才进「待发布」；Friday 备齐发布单挂待审，用户严格审完它才建 MR；MR 由用户在 GitLab 上合，Friday 不合。发布分几步 Friday 不管。
- **知识库由 Friday 收工时自己写**，用户不维护。

## 流程

```
诞生 → 认功能、挂需求 → 理解（四栏 + 用例清单 + 方案）→ [送审] → 等依赖 / 催办 → 开发 → 联调 → 提测（名下缺陷一组修）→ 等验收通知 → 发布单待审 → 建 MR、你合 → 上线 → 收工写知识库
```

今天已有的：诞生（三个入口）、开发、`slack_accepted` 信号提问转「待发布」、收工 `finishTask`、缺陷进需求会话（2026-10-16，只覆盖「测试中」那一档）。本稿新增五块：**知识库**、**缺陷归属**、**理解卡**、**等依赖与催办**、**发布单**。退役两样：缺陷的把握分门禁（`intake` 的 start / confidence 路径）、本地 `git_merge` 待审动作。

## 范围与顺序

五块按依赖排，各自可独立交付：

1. **知识库**：表、收工写入、冷启动、注入、项目页列表。
2. **缺陷归属**：缺陷认功能 → 挂需求 / 开需求；缺陷进需求会话推广到需求全程。
3. **理解卡**：四栏 + 用例 + 方案，送审分档，统一的开工门禁。
4. **等依赖与催办**。
5. **发布单**。

不做：知识库的手动编辑表单（删一条可以，改走会话）；Slack 之外的催办渠道；为任何测试平台 / 发布平台写连接器（跟定时任务同一条原则，项目级知识里写「去哪、怎么找」，交给终端里的 Claude 用 skill / MCP 解决）；发布分步；Friday 合 MR。

## 名词

- **功能**：知识库里的一条，用户在界面上能叫出名字的东西（「基金筛选」「提现规则页」）。
- **需求卡**：`category: "story"` 的任务卡，落在一个功能上（`featureId`），是一次发布的单位。
- **缺陷卡**：`category: "defect"` 的任务卡，`featureId` 必填，`rootId` 指向它挂的需求卡。
- **category** 是卡的属性，任何来源都能标：Meegle 适配器按工单类型填，口头 / Slack 的由 Friday 判（有「报错 / 不对 / 复现」这类现场的是缺陷，其余是需求），用户可改。现有 `taskCategory(source)` 从读 `meegleType` 改成读这个字段，`meegleType` 只在适配器里用。

## 一、知识库

### 两层

| 层 | 内容 | 谁写 | 存哪 |
|---|---|---|---|
| 项目级 | 这个项目的流程惯例：验收用例去哪找、发布怎么走、什么需求要先看方案、催办提前几天 | 用户（会话里说一句，Friday 用 `memory_write` 写） | `projects.md` 该项目下的键 |
| 功能级 | 一个功能一条：叫什么、在哪、落在哪个目录、谁负责、动过几次 | Friday 收工时写；首次冷启动扫一遍 | SQLite `features` + `feature_history`，渲染成 `knowledge/<项目>.md` |

**项目级键**（`parseProjects` 已把白名单外的键原样收进 `extra`，加四个有语义的）：

- `用例`：「用 X 这个 MCP 的 Y 工具按需求号导出」/「没有，按 PRD 自己推」。缺省按 PRD 自己推。
- `发布`：这个项目的发布流程怎么走，自由文本（「走 harua-deploy，先 canary 再 master MR」），给建 MR 的 Claude 看。缺省「按 harua-deploy」。
- `方案送审`：`全部` / `大的` / `不用`。缺省 `全部`。
- `催办提前`：天数，缺省 3。

**功能级表**（`memory/features.ts`）：

| 列 | 说明 |
|---|---|
| `id` | `f-` + 8 位 hex |
| `project` | 注册表里的项目名 |
| `name` | 业务叫法（PRD 和老板嘴里的名字） |
| `aliases` | JSON 数组，别名 |
| `where` | 大概在哪：产品、菜单路径、界面一句话 |
| `paths` | JSON 数组，仓库里的关键目录 / 文件（相对主仓） |
| `routes` | JSON 数组，路由 |
| `owners` | JSON 对象 `{ backend?, pm?, design?, qa? }`，人名 |
| `summary` | 一两句：这个功能干什么、有什么坑 |
| `origin` | `bootstrap` / `task` |
| `created_at` / `updated_at` | |

`feature_history`：`feature_id`、`task_id`、`at`、`what`（这次改了什么，一句）、`files`（JSON 数组）。只增不改。

`knowledge/<项目>.md` 是生成物（同 `handbooks/`），每条带 `<!-- f-xxxxxxxx -->`，手改会被覆盖。会话工具 `memory_read knowledge:<项目>` 读整份；`memory_read` 的目录列表里列出有知识库的项目。

### 收工写入

`finishTask` 标 done 时，任务有 `project` 且（有 `source.branch` 或 `report`）就调 `learnFromTask(task)`：一次 Sonnet `oneShot`，输入 = 标题、理解卡、交付报告、名下缺陷的标题、相对主干的改动文件列表（`git diff --stat` 取自 worktree 或分支，分支已删就只用报告）、这个项目现有功能列表（名字 + 别名 + paths，当候选）；输出 JSON `{ features: [{ match?: "f-…", name, aliases, where, paths, routes, owners, summary, what }] }`。`match` 命中就更新那条（paths / routes / aliases 取并集，owners 新值覆盖，summary 覆盖），没命中就新建；每条写一行 `feature_history`。卡上已有 `featureId` 的那条必在输出里（没写就按卡的 `featureId` 补一行 history）。解析层：`match` 必须是候选里的 id，`paths` 必须在仓库里存在，不存在的丢掉；一个任务最多 5 条。

记账 `knowledge_updated`，`undo: restore_features`，快照只存这次动过和新建的 id（同手册 apply 的 `scoped` 思路）。忽略（ignored）不写。

### 冷启动

每个项目一次，入口：项目页「建知识库」按钮（`POST /projects/:name/knowledge/bootstrap`）和会话工具 `knowledge_bootstrap`。跑一个后台只读会话（复用 `startQueryJob` 那套：`kind: "query"`、cwd = 主仓、写工具 deny、`--model sonnet`），提示词要它读路由表 / 菜单配置 / 页面目录，按「用户在界面上能叫出名字的功能」列出来，每条给 name / where / paths / routes / summary，用新的桥接工具 `friday_knowledge(features)` 回报（一次最多 200 条，分批调）。Friday 再把这个项目近一年 done 的任务按标题对一遍，能对上的补进 `feature_history`。

冷启动结果直接入库、`origin: bootstrap`，不走审核；项目页能逐条删。跑过的项目在 `sync_state` 记 `knowledge:bootstrapped:<项目>`，再点是「重扫」，已有的按 name 匹配更新、不重复。

### 命中与注入

`matchFeatures(project, text, limit = 5)`：对 name 和 aliases 做子串命中（≥ 2 字），再按 `where` / `summary` 的词重叠排序；零模型调用。

- **缺陷归属**（下一节）和**理解卡**的后台会话：提示词内联命中的条目全文，并说「`memory_read knowledge:<项目>` 可以看整份」。
- **自主任务** `autonomousPrompt` 和交互终端 `terminalBridgePrompt(project)`：内联卡上 `featureId` 那条全文 + 命中的条目各一行「名字 — where — paths」，上限 1500 字，同 `handbookBlock` 的截法；`friday_context` 返回值里带这些。
- **会话**：`/ask` 绑着任务时任务块带这些；新增只读工具 `knowledge_search(project, query)`。

## 二、缺陷归属

### 认功能

缺陷卡进来（任何来源）且 `project` 已定、`featureId` 为空 → `assignFeature(task)`：先 `matchFeatures` 零模型命中，唯一命中且名字整词出现在标题 / 正文里就直接写；否则一次 Haiku 在候选（命中的前 5 条 + 适配器给的关联需求所在功能）里选，写 `featureId` 并记 `featureBy: "friday"` 和一句 `why`；候选为空或模型说对不上 → `attention: "intake"` 问用户一句「这条是哪个功能的？」（复用现有 intake ask 的界面），用户答了写 `featureBy: "user"`。知识库还没冷启动的项目一律问用户，顺手建一条功能。

需求卡同样认功能（新功能就建一条，`origin: task`、只有 name 和 summary，收工时补全）。

### 挂需求

缺陷有了 `featureId` → `attachToStory(task)`：

1. 适配器填了关联需求（Meegle 的 `linkedStoryId`、用户说的「这是 X 的 bug」）且那张需求卡开着 → `rootId` 指它。
2. 否则这个功能名下有开着的需求卡（`featureId` 相同、`category: story`、status 不是 done / ignored）→ 挂上去；不止一张取最近更新的，并在卡上标「Friday 挂的」。
3. 都没有 → 以功能为名开一张需求卡「<功能名> · 修复」（`category: story`、`featureId` 同、`source.maintenance: true`），缺陷挂上去。后续同功能缺陷都往这张攒，上线收工后再有再开。

`rootId` 的语义从「缺陷进哪个需求的会话」扩成「缺陷归哪张需求」，现有 `resolveRoot` / `liveRootId` 改读它，不再按 `linkedStoryId` 兜底找 `meegleId`。用户可改挂（卡上选、会话里说），写 `rootBy: "user"`。

### 一组修

缺陷不建自己的会话、分支、worktree、理解卡、发布单。它在需求卡里的表现是一行（标题、修没修）；需求卡的状态行写「名下 N 条缺陷待修」。

- **需求未开工**：缺陷攒着，开工时整组进 `autonomousPrompt`（「本轮要一并处理的缺陷」）。
- **需求在开发 / 测试 / 待发布中**：10-16 的 `handToStorySession` 推广到这三个阶段，不再只看 `testing`：需求会话活着就敲进去，退出了就 `--resume --fork-session` 起 headless 一轮；一次交一组（名下所有 pending 的缺陷），不是一条一条。交付归属沿用 `targetTask` 的 `taskId` 规则，缺陷卡上记「修于 <需求 jobId>」。
- **需求已上线**：功能名下没有在办需求 → 走「挂需求」第 3 条开新卡。
- **修没修**：交付报告里逐条写缺陷 id 的结果；缺陷卡标 `fixed`（status 仍 processing 直到需求上线，上线时跟着 done，适配器据此回写 Meegle）。

`settleHandedBugs`、`finishDefectsOf` 保持语义（需求会话关了 / 需求收工，名下缺陷跟着），只是触发范围从「测试中」扩到全程。

## 三、理解卡（Brief）

### 结构

`Task.brief?: Brief`，只有需求卡有：

```ts
interface Brief {
  todo: string;                 // 我要做什么：项目、页面 / 模块、新东西还是改现有的、边界
  deps: Dep[];                  // 别人要给我什么
  acceptance: {
    source: "cases" | "prd" | "own";   // 导出的用例 / 从 PRD 推 / 自己写
    cases: string[];            // 用例清单：golden path、边界、回归
    note?: string;              // 测试要测什么、PM 看什么、哪个环境
  };
  release: string;              // 怎么发：走哪条流程、有没有依赖后端先发、有没有开关
  plan: string;                 // 方案：改哪些文件 / 组件、新加什么、接口怎么接、风险、要用户拍板的点
  size: "small" | "large";
  sizeWhy: string;
  review: "none" | "pending" | "approved" | "rejected";
  reviewNote?: string;          // 打回原因，重建时带进提示词
  stale?: boolean;              // 建完之后正文 / 文档变了
  at: string;
  features: string[];           // 命中的知识库条目 id
}
interface Dep {
  what: string;                 // 「基金筛选接口」「筛选面板设计稿」
  from?: string;                // 人名或角色
  status: "pending" | "ready";
  evidence?: { url?: string; text?: string; at: string; source: "meegle" | "slack" | "user" };
  nudgedAt?: string;
}
```

`understanding` / `plan` 两个旧字段留着：`understanding` 仍是一句摘要，`plan` 在有 brief 时由 brief 渲染成文本（会话和账本看的是它）。

### 什么时候建

看 Friday 自己的待办队列，不看来源字段：板上 `understood` 的需求卡按 `due` → `priority` → `createdAt` 排，队首那条建，**一次一条**，建完下一条；`autostartOff` 的跳过；用户在会话里说「先看这条」就插队（`task_update` 的 `briefNow`）。维护卡（`source.maintenance`）也建，它的 `todo` 就是名下缺陷。正文或 `docs` 变了：没审过的重建，审过的标 `stale` 在卡上提示。

建的方式：**后台只读会话**（复用 `startQueryJob`，cwd = 主仓，`--model opus`），因为它要读 PRD（`web_read`，带 Chrome Cookie）、读设计稿链接、在仓库里 grep、按项目级 `用例` 键去调测试平台的 MCP。提示词给：标题、正文、`docs`、挂靠的 Slack 对话原文（过 `untrusted()`）、名下缺陷、`featureId` 那条和命中的知识库条目、项目级四个键、`projects.md` 该项目的说明。要它用新桥接工具 `friday_brief(brief)` 回报，解析层钳字段、`features` 只认存在的 id。没调 `friday_brief` 就退出 → 卡上写「理解没建成，看终端」，不进送审，队列继续下一条。

口头需求没 PRD：`todo` 按那句话写，`deps` 只列确定要的，拿不准的写进 `plan` 的「要用户拍板」里；用户在会话里补一句就重建。

### 规模与送审

`size` 由后台会话判，判据给死：新路由 / 新页面、接新接口、动公共组件（`components/` / `packages/` 这类目录）、预计改动文件 ≥ 5，任一命中就 `large`；它自己把握不足也 `large`。项目级 `方案送审`：`全部` → 一律 `pending`；`大的` → `large` 才 `pending`；`不用` → `none`。维护卡一律按 `small` 走。用户在卡上可手动改档（`PATCH /tasks/:id/brief { size }` 触发重算）。

`pending` 挂待审动作 `brief_approve`（「方案看过，开工」）：卡上理解卡顶部四栏 + 用例 + 方案全文，通过 → `approved`；打回带原因 → `rejected` + `reviewNote`，自动重建一次（带「上一轮被打回：…」），再打回就停下等用户在会话里说。会话里整句「方案可以 / 按这个做」走同一个动作（同 `handbook_apply` 的闸门）。

### 开工门禁（统一的一条）

`autostart.ts` 的 `eligible` 改成只对需求卡：有 brief、`review` 是 `none` 或 `approved`、`deps` 全 `ready`、`project` 已定、阶段「未开始」、卡上没挂问题、`autostartOff` 没写、根会话不是用户开着的交互式。不看来源、不看 intake、不等 15 分钟。并发 1 和总开关 `settings.autonomous` 不变。缺陷不再单独过门禁（`intake` 的 start / confidence 路径退役，`ask` 路径保留给「归哪个项目」）。口头 / Slack 落成的需求卡同样走这条门禁（用户定「可以」）。

`autonomousPrompt` 对需求内联整份 brief 和名下缺陷：用例清单就是它自测的清单，交付报告的 `verify` 必须逐条对应；`plan` 是它的起点，偏离要在报告里说明。

## 四、等依赖与催办

### 依赖怎么变 ready

- 建 brief 时后台会话已经把正文 / 附件 / 评论和挂靠对话里的链接、`method + url` 对上，对得上的直接 `ready` 带 evidence。
- 之后新消息进来：挂靠链路（`agent/slack/attach.ts`）把消息挂到任务后，任务有 `pending` 的 dep 且消息里带 URL / 文档链接 / Figma 链接 / `GET|POST … /path` 形态，就问一次 Haiku「这条是不是在给某个 dep」，是就标 `ready` 写 evidence（`source: slack`，带 permalink）。适配器同步时正文 / 评论变了同样过一遍。
- 用户在卡上点「到了」或会话里说「接口给了」→ `task_update` 标 `ready`（`source: user`）。
- 接口只有 url 没文档的，开工时自主任务自己去 inner gateway 拉定义，不在这一步做。

卡上「未开始」且有 pending dep 时，状态行写「等 X 给 Y · 还差 N 天」（按 `due`），排队卡的「什么时候开」写「等依赖齐」。

### 催办

每次同步后跑 `nudgeTick`：任务开着、有 pending dep、有 `due`、`due - now ≤ 催办提前`（项目级键，缺省 3 天）、这条 dep 上次催办超过 2 天或没催过 → 起草一条催办挂待审动作 `nudge`（复用 `slack_reply` 的执行器）：发给谁（dep.from → 功能的 owners → `people.md`，逐级兜底）、发到哪（和这个人有现成私聊就私聊；没有就发需求挂着的频道，花名册能换到 user id 就 @ 他、换不到就写名字；人和频道都没有就「不知道该找谁」，动作不挂、卡上提示——Enterprise Grid 下列不了全员，不硬找）、说什么（一次 Haiku 起草，带工单链接和截止日，素材过 `untrusted()`）。通过才发，记账 `nudge_sent`，dep 上写 `nudgedAt`；「完成，不发」只记 `nudgedAt`。

## 五、发布单

### 触发

阶段进「待发布」（`accepted`）时建。入口不变：`slack_accepted` 信号提问、用户手动拨。Friday 自己不因为验收消息直接拨——说这话的是别人。一张卡一张发布单；分几步、发到哪个分支由项目自己的发布流程定，Friday 不管。

### 内容

待审动作 `release_sheet`，payload：

- 项目级 `发布` 的说明。
- 分支、相对主干的提交列表和 diffstat、已有的 MR 链接。
- 交付报告摘要、用例清单和测试结果（brief.acceptance.cases 逐条对 report.verify 的勾选）、名下缺陷的修复结果。
- 验收证据：触发「待发布」的那条 Slack 消息 permalink 和原文；用户手动拨的写「你拨的」。
- 依赖：brief.deps 全部 ready 的 evidence；后端有没有先发（不知道就写「未确认」，由用户审）。

每项带来源链接，都能点进去核对。前端像 `verify` 勾选一样逐项勾，**全勾完主按钮才亮**；后果预览写「Friday 会建 MR 到 X，合并要你在 GitLab 上点」。

### 执行

通过后 Friday 只做到**建 MR**：在任务自己的会话里跑（会话 exited 就 `runInSession` 起一次 `claude -p --model opus`），提示词只讲「按项目的发布流程建 MR，做完 `friday_done` 带 MR 链接」，命令不写死（项目用 harua-deploy / glab 自己定）。守卫不动：不合并，push 走现有 `pushVerdict`。MR 链接记到卡上（`source.mr`），阶段仍在「待发布」，状态行写「MR 已建，等你合」。

合并由用户在 GitLab 上点。Friday 每次同步后对「待发布且有 MR」的卡 `git fetch` 主干，交付时的 tip 进了主干就推 `released`（即 done，名下缺陷跟着 done，适配器回写），squash 合并认不出的照旧 `closed_unverified`，由用户拨「已上线」。

发布单打回：带原因退回「测试中」，`rejected` 记原因。

### `git_merge` 退役

`friday_done` / `onJobExit` 不再挂 `git_merge`；审核面板的主按钮是发布单。账本里旧的 `git_merge` 记录不动。

## 账本

`knowledge_updated`（undo）、`knowledge_bootstrapped`、`feature_assigned`、`defect_attached`、`story_opened_for_feature`、`brief_built`、`brief_approved` / `brief_rejected`、`nudge_sent`、`release_sheet_approved` / `_rejected`、`mr_created`。

## 界面

- **任务卡**：理解卡一节（四栏、用例清单可勾、方案折叠、规模与送审状态、`stale` 提示、功能和命中条目可点）；名下缺陷一组（标题 · 修没修）；依赖每条一个状态点 + 「到了」按钮；催办 / 发布单走现有待审动作面板，发布单用逐项勾选；缺陷卡头部写「属于 <功能> · 挂在 <需求>」可改。
- **项目页**：加「知识库」一节：条数、「建知识库 / 重扫」按钮、列表（名字 · where · paths · 动过 N 次 · 在办需求），点开看历史，可删。
- **设置页**不加东西，项目级四个键在 `projects.md` 编辑器里改。

## 成本

- brief：每条需求一次后台 opus 会话，估 $0.3–1（读 PRD 占大头），一次一条。
- 收工写入：一次 Sonnet oneShot，约 $0.02。
- 冷启动：每项目一次 sonnet `-p`，视仓库大小 $0.5–2。
- 认功能、依赖判定、催办起草：Haiku，忽略不计。

用量面板加 label `brief` / `knowledge` / `attach_feature` / `nudge`。

## 测试

- `features.ts`：upsert 合并规则、`matchFeatures` 命中、`restore_features` 只还原动过的。
- `learnFromTask` 解析层：越界 `match`、不存在的 paths、超 5 条、`featureId` 必有一行 history。
- `assignFeature`：唯一整词命中直写、多候选走模型、空候选问用户、未冷启动一律问。
- `attachToStory`：三级顺序、多张在办取最近、开维护卡、用户改挂压过 Friday。
- `handToStorySession` 推广：三个阶段都接、一次一组、需求未开工时攒进开工提示词。
- brief 队列：一次一条、插队、`autostartOff` 跳过、`stale` 只提示不重建已审的。
- brief 解析层：字段钳制、`features` 校验、`size` 与 `方案送审` 三档的组合、维护卡按 small。
- `eligible`：brief 缺 / pending / rejected / dep pending / 交互式根会话各自拒绝，全齐放行；缺陷卡不进门禁。
- dep 判定：URL / `method + url` 形态识别；用户标 ready。
- `nudgeTick`：提前天数、2 天节流、找不到人不挂动作、私聊 / 频道回落。
- 发布单：全勾才能通过、只建 MR 不合、fetch 后 tip 进主干才推 released、名下缺陷跟着 done。
- 真机验收同 2026-10-16 那套：`FRIDAY_NO_SCHEDULER=1`、临时数据目录、假 `claude` 和假 `meegle`。

## 留给实现的

- `knowledge/<项目>.md` 的渲染格式；`features` 的索引。
- 后台会话的提示词措辞；`friday_brief` / `friday_knowledge` 的 zod。
- 项目页知识库列表、任务卡「名下缺陷」一组的样式。
- 发布单前端的逐项勾选怎么复用 `verify` 的组件。
- 现有读 `meegleType` / `feDue` / `nodeName` 的主流程判断逐处换成读卡字段的顺序（适配器里的照旧）。

## 我的决定（用户没明说，看稿时可改）

- 冷启动结果直接入库不审核；功能级条目只能删不能改（改走会话，后续再说）。
- 项目级惯例放 `projects.md` 的键而不是规则表：它是用户一次性定的配置，不是从历史学的规则。
- 口头 / Slack 来的卡是需求还是缺陷由 Friday 按有没有「现场」判，用户可改。
- 维护卡命名「<功能名> · 修复」，同功能同时只有一张；理解卡按 small 走、不送审。
- brief 用后台只读 `claude -p` 建而不是 `askStream` oneShot：要读 PRD 和仓库，oneShot 做不到。
- brief 队列按 `due` → `priority` → `createdAt`，一次一条。
- `方案送审` 缺省 `全部`。
- 催办只走 Slack，缺省提前 3 天、2 天节流；私聊不存在就发频道，都没有就不挂动作。
- MR 合没合靠每次同步后 fetch 主干比对；squash 的留给用户拨。

## 已知边界

- 知识库只覆盖注册表里的项目；没 `project` 的卡认不了功能、建不了 brief。
- PRD 要 Chrome 登录态（`web_read` 的 Cookie 路径），读到登录页 brief 会写「PRD 读不到」。
- 口头需求没有文档，brief 的 deps 多半空，靠用户补。
- 依赖判定靠挂靠：消息没挂到这条任务就看不到；老消息没 `prior`。
- 冷启动列出来的是「代码里有的功能」，业务叫法可能对不上 PRD 的词，靠收工时的 aliases 慢慢补；冷启动前缺陷归属全靠问用户。
- 一组修的缺陷交付归属靠 `taskId`，Claude 漏写就只能整组按需求算。
- 发布单只保证「审过才建 MR」，合并在 GitLab 上，Friday 看不到合并前的审查意见。
