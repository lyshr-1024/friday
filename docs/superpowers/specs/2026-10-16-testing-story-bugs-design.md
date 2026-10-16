# 需求进测试后，缺陷由 Friday 在需求会话里修完、验完、发到测试环境（2026-10-16）

## 起因

需求提测以后，测试拉出来的缺陷大多是小改：改个颜色、对齐设计稿、补个校验。这些缺陷现在走和别的缺陷一样的 autostart 门禁（`agent/autostart.ts`）：intake 判成 start 且把握 ≥ 80、等 15 分钟稳定期、并发 1。截图里同一需求下五条缺陷，三条「Friday 会自己开工」，两条「未开始」——被把握分挡住了。而这批缺陷和别的缺陷有本质区别：**它们挂在一条已经在联调环境上跑着的需求分支上**，改完不是建 MR 等合并，是直接 commit 到需求分支、推上去、再合到测试环境让测试复验。需求会话里的 Claude 本来就知道分支在哪、发到了哪个 canary、怎么验的。

用户要的（2026-10-16 原话）：需求转入测试以后，每次拉到 bug 能自己主动先解决并完成验证，验证规则按项目定；验完后把 Meegle 缺陷状态改成「开发中」；最后由用户核验、转给测试。MR 不存在合并，是在需求分支上直接 commit → push → merge 到测试环境。**不要看 `harua-deploy`，看项目自己的发布流程。** 需求会话里的 Claude 可能还在跑，也可能已经退出，两种都要能接。

**定位**：这不是新开一种自主任务，是把「缺陷进所属需求的会话」这条已有路径（`sessions.ts` 的 `joinRootSession`）从「用户点了才走」变成「需求在测试中就自动走」，并把它交付后的收尾补齐（现在从需求会话里报上来的 `friday_done` 全算到需求头上，缺陷卡永远停在 processing）。

## 范围

- 做：测试阶段缺陷的自动接手门禁；交付归属到缺陷卡；交付后把 Meegle 缺陷转「开发中」；守卫对这条路放开 `merge`；界面上的排队文案与进行中分组。
- 不做：Friday 自己写任何验证步骤或发布步骤（都交给项目的 skill / CLAUDE.md）；缺陷转测试（用户自己转）；需求不在测试中的缺陷（照旧走 autostart 门禁，一行不改）；Slack 来源的缺陷；自动更新 Meegle 需求的状态。

## 名词

- **需求卡**：`kind: meegle`、`source.meegleType === "story"` 的任务；它的 tmux 会话 = worktree = 分支（`term_sessions` 行 id 等于需求卡 id）。
- **测试阶段缺陷**：`kind: meegle`、`source.meegleType === "issue"`、`source.linkedStoryId` 能经 `resolveRoot` 找到一条**开着的**需求卡，且该需求卡 `stage === "testing"`。
- **需求会话**：`getTermSession(root.id)`，`status` 不是 `closed`、tmux 里有这个会话、且有 `worktree`。
- **接手**：把缺陷交代进需求会话。Claude 还在跑 → `sayToSession`；已退出 → `resumeInSession(root.id, text)`（`--resume` 需求的 Claude session，和 `joinRootSession` 现在一样）。

## 门禁（`agent/autostart.ts`）

现有 `eligible()` 不动。新增一条独立判据 `testingStoryBug(t): { root: Task } | string`（字符串是不接的原因，和 `eligible` 的口径一致）：

1. `t.status === "understood"`、`t.kind === "meegle"`、`t.source.meegleType === "issue"`、没有 `jobId`、没有 `attention`、`stage` 是空或 `todo`、`source.autostartOff` 没写。
2. `resolveRoot(t)` 得到的不是它自己，且 `root.stage === "testing"`。
3. 需求会话存在、不是 `closed`、有 `worktree`（`getTermSession(root.id)`；tmux 里在不在由接手时 `sayToSession` / `resumeInSession` 自己判，这里只看库）。
4. **不看** intake 结果、不看把握分、不等 15 分钟稳定期、不管需求会话的 `kind` 是 interactive 还是 autonomous。

`autostartTick` 里先跑这一路，再跑原来的 `pickAutostart`。总开关仍是 `settings.autonomous`（设置页「让 Friday 自己开工」）——用户没开就什么都不做。

**旧门禁不再碰测试阶段缺陷**：`eligible()` 加一条，根需求 `stage === "testing"` 的缺陷直接回「需求在测试中，走需求会话那条路」。否则一条 intake ≥ 80 的测试阶段缺陷被新路以「等前一条修完」挡下后，旧路会按原来的 `joinRootSession` / `runInSession` 再开一次，同一需求会话里出现两条缺陷，归属规则就乱了。

**需求怎么算「在测试中」**：只认需求卡的 `stage`。真实库里查过（2026-10-16）：在测试中和在开发中的需求，Meegle 侧 `statusKey` / 节点都是同一个值（`KDkma5Ds5` / `state_16` Admin Frontend Development），Meegle 状态分不出来。`stage` 现在的来源是：你在 StageBar 上拨、分支推上远端后你答「是提测了」（`stageWatch.ts` 弱信号）、会话里说。这意味着**你没拨阶段的需求，它的缺陷照旧走把握分那条路**——用户定的：就认 Friday 里的阶段，不另加推断。

**串行**：同一个需求一次只接一条。需求会话里还有一条 `processing` 的测试阶段缺陷（`source.rootId === root.id`、`source.autonomous`、`status === "processing"`）就不接下一条，排队文案写「等前一条修完」。不同需求之间互不影响，也不占 `AUTOSTART_MAX_RUNNING` 那个并发 1（它数的是 `runningAutonomous()`，按 `jobId` 的 job 在跑；这类缺陷没有自己的 job，自然不算进去）。按优先级、再按创建时间挑。

**不接的情形**都写进 `autostart` 字段的原因里，卡上看得到：需求没有会话 / 会话 closed / 没有 worktree（「需求不是在 Friday 里做的，Friday 不知道分支在哪」）、需求不在测试中、前一条还没修完、用户说了先别做。

## 接手（`agent/pipeline.ts` 新函数 `handToStorySession`）

从 `startAutonomousJob` 第 128 行那条 `joinRootSession` 分支拆出来、补齐，`joinRootSession` 本身的调用方不变（用户点「交给 Friday 改」时仍走它）。

1. 缺陷卡写：`status: "processing"`、`source.rootId`、`source.autonomous: true`、`source.handedAt`（ISO 时间）、`source.repoDir` / `branch` / `worktree` 从**需求会话的 `term_sessions` 行**抄（需求卡的 `source.branch` 不一定写过，会话行的 `branch` / `worktree` 是 `worktreeReady` 落的实际值）、`progress: 在需求「X」的会话里修`。**不写 `jobId`**（job 是需求的）。
2. 提示词（`prompt.ts` 新增 `storyBugPrompt(task, root)`，只讲规矩不讲步骤）：
   - 这是需求「X」提测后拉出来的缺陷，Friday 任务 id `<id 前 8 位>`；工单号、标题、描述、理解（过 `untrusted()`）。
   - 在当前分支上改，不另起分支、不建 MR。
   - 改完按**本项目**的验证规则验（项目 skill、CLAUDE.md、`handbooks/`），界面改动要真浏览器截图。
   - 验完 commit、push 当前分支，再按**本项目自己的发布流程**发到这条需求正在联调的测试环境（你之前发过，照原来的目标发）。
   - 全部做完调 `friday_done`，`taskId` 填上面那个 id；中途发现要用户定（改方案、冲突、环境号不确定）调 `friday_blocked` 同样带 `taskId`，不要猜。
   - 交付报告里写明：commit sha、推到了哪条分支、发到了哪个环境、验证过程和结果。
3. 按需求会话此刻的状态分三种：
   - **Claude 还在跑（`status: running` 且 `claudeGone` 为假）**：`sayToSession` 敲进去。需求会话是 interactive 的（你自己开的）才走这条；是 autonomous 的（守卫在、`merge` 被拦，而 Claude Code 启动时就把 hook 快照了，活着改不了）就**不接，等它退出**，排队原因写「需求会话里的 Claude 还在跑，等它退出」。
   - **Claude 已退出（`status: exited`，或 `claudeGone` 为真）**：**无人值守地接回**——`runInSession` 补一个 `resumeSessionId` 参数，起 `claude -p --model opus --resume <需求 job 的 claude_session_id> <提示词>`。不走 `resumeInSession`：它起的是交互式 Claude，不传 `-p` 也不传 `--model`（模型继承你 Claude Code 的默认，就是 2026-09-28 那个 $4.46 的坑），做完也不退出，而且注入的 `terminalBridgePrompt(project, false)` 会告诉它「这是用户自己的终端」。headless 这一跑：新 job 行（`jobId` 新 uuid、`taskId` 填缺陷、`sessionId` 填需求会话）、hook 按 autonomous 写并带 `allowMerge`、`--resume` 带着需求的对话上下文（分支、canary 编号、验证方法都在里面）。退出后 `onJobExit` 按这个 job 找到缺陷卡，和别的自主任务一样收尾。
   - **会话不在了**（`closed`、tmux 里没有、没有 worktree）：回 `"no-session"`，缺陷卡不动，账上记一条 `story_session_gone`，门禁第 3 条下一轮会挡住并写原因。
4. 记账 `autostart`（`why: 需求「X」在测试中，缺陷直接在它的分支上修`，`how: 交代进需求的会话`），`createRun` 一行：`taskId` 填缺陷、`trigger: "autostart"`、`kind: "autonomous"`；`jobId` headless 那条用新 job 的 id，`sayToSession` 那条用 `<需求 jobId>#<缺陷 id 前 8 位>`（和交互轮次 `jobId#随机` 一个路数，**不能直接填需求的 jobId**——`runByJob(jobId)` 取的是该 job 最新一行，`fillRunCost`、需求自己的 `git_merge` 结局比对、`reproject` 的回退清单、`sessionState` 的交付展示都会拿到缺陷那行）。通知「Friday 接手了一条缺陷 · 项目」。

**不动需求会话的 `kind`**（「会话的 kind 是归谁驾驶，建好后不变」）。需求会话是 interactive 的就在你的会话里跑、没有守卫；是 autonomous 的（你当初点「交给 Friday 改」做的需求）只在退出后接、带守卫，见下节。

**打回**（`/reject`、会话里的 `task_reject`）：`rejectTask` 现在只改状态记账，不往任何会话说。对 `handedAt` 的缺陷补一步：标 `rejected`、`closeRunForTask(…, "rejected")` 之后**立刻再 hand 一次**，提示词前面加「上一轮被打回：<原因>」，仍带 `taskId`；串行门禁看的是 `processing`，重交后它还占着位，后面的缺陷继续等。「重新开工」（`/retry`）对这类缺陷也走 `handToStorySession` 而不是 `startAutonomousJob`。

## 交付归属（`agent/bridge.ts`）

现在 `callBridge` 一律 `taskFor(job)` → 需求卡。改成：

- `friday_done` / `friday_blocked` / `friday_progress` 的入参加可选 `taskId`（前 8 位即可，`bridge.ts` 第 52 行的工具 schema）。
- 解析顺序：①`args.taskId` 给了且能找到、且那条任务的 `source.rootId === job.sessionId`（是这个会话名下的）→ 用它；②没给：这个会话名下有**恰好一条** `processing` 且 `source.handedAt` 的缺陷 → 用它（需求在测试中时自己不会再有交付，模型忘了带 id 也兜得住）；③都不是 → 原来的 `taskFor(job)`。
- `friday_done` 对这类缺陷（`source.autonomous && source.handedAt`）：`status: "review"`、写 `report`、`closeRun`（按 `runs` 表里 `taskId` 为它的那行）、**不挂 `git_merge`**（分支是需求的，合并由测试环境那边决定）、`onSignal(..., "terminal_delivered", to: "dev")`、通知「修完了，等你核验 · 项目」、`postDelivery`。然后走下一节的 Meegle 流转。
- `friday_blocked`：`status: "blocked"`、`closeRun(..., "blocked")`、不碰 Meegle。
- `friday_progress`：照旧写 `progress`，但不改 `source.branch`（分支是需求的，缺陷卡上那份是抄的）。
- 需求卡本身：这些调用不再把需求卡标 `review` 或写 `report`。需求在测试中时，它的 `attention` / `progress` 不动。

**没交付就没了的缺陷谁来收**：会话名下 `processing` 且 `handedAt` 的缺陷不能一直挂着（它没有自己的 `jobId`，`sweepClosedTerminals` 的兜底扫不到）。三个口子都要收：①`onJobExit`（需求会话的 Claude 退出，或 headless 那次退出）没收到它的 `friday_done` → 缺陷标 `blocked`、`progress: 需求会话退出了，这条没交付`、`closeRunForTask(..., "no_report")`，通知一次；②需求 `finishTask`（你标完成 / 忽略、`friday_finish`）→ `closeTaskTerminal` 里把会话名下这类缺陷一并标 `blocked`「需求收工了，这条没交付」；③设置页 / 终端列表手动关会话（`closeJobTerminal`）同②。

## Meegle 流转（`agent/meegle.ts`）

`friday_done` 归到测试阶段缺陷后：

1. `listTaskTransitions(t)` 拿到可用流转，找 `stateKey === "IN PROGRESS"`（`connectors/meegle.ts` 的 `TRANSITIONS` 表里就是它，界面上叫「开始处理」；Meegle 侧显示「开发中」）。
2. 有就 `applyTransition(t, to)`，账本 `why` 改写成「Friday 在需求分支上修完并发到测试环境」而不是「你在 Friday 里点了」（`applyTransition` 加一个 `why` 参数，缺省保持原文案）。带 `undo: meegle_state`，可撤。
3. 没有这条流转（已经是开发中、或流程不允许）→ 不报错，交付消息里加一句「Meegle 状态没动：当前 X，没有「开始处理」可走」。
4. 流转失败（CLI 报错）→ 缺陷卡仍进 review，进展里写「Meegle 没转成：错误」，记账 `status: "failed"`，通知带上。不因为 Meegle 失败把交付打回。

转测试由用户自己在 Meegle 或 Friday 里点，Friday 不做。用户在 Meegle 里转了测试 → 下一轮同步 `meegle_in_testing` 信号推到「测试中」，缺陷卡照原逻辑收。

## 守卫（`agent/guard.ts`、`agent/runner.ts`）

需求会话是 interactive 时本来没有守卫，什么都不用改。需求会话是 autonomous 时，`resumeInSession` 按 `jobKind(job)` 写 hook，守卫黑名单里 `git merge` 会被拦——而发到测试环境就是 merge。

- `writeHookFiles(id, autonomous, readOnly, opts?: { allowMerge?: boolean })`，`allowMerge` 时守卫脚本不带 `merge` 那条（`FORBIDDEN` 过滤掉）。只有 `handToStorySession` 起的 headless 那次（`runInSession` 带 `resumeSessionId`）传；`sayToSession` 那条路不涉及（interactive 根没守卫；autonomous 根活着不接）。
- push 规则不动：`pushVerdict` 本来放行非受保护分支。两个项目核过（2026-10-16）：fe-wealth-admin 的 `bo-deploy` canary 流程是 `merge --no-ff` 需求分支进 `canary[n]-<app>` 再 `push origin canary[n]-<app>`，`canary*` 不在 `PROTECTED` 里，放开 `merge` 就通；whale-console 是 `whale deploy canary wbo --n=3`，CLI 自己把 HEAD 强推到 `canary3-wbo-hk`，命令里没有 `git push`，守卫根本看不见，自然通过。主干、sit / uat / release 照拦——项目的「集成测试」是建 MR 的路线，这条链路不走。
- 下一轮用户自己「接着聊」接回时 `resumeInSession` 不带 `allowMerge`，守卫恢复原样。

## 界面（`apps/desktop/src/views/Board.tsx`、`TaskHeader.tsx`）

- `GET /tasks` 的 `autostart` 字段多一种：`{ kind: "story", at, root: { id, title } }`（原来的 `{ at, behind }` 不变，加 `kind: "gate"` 区分）。`anchorLine` 对 `kind: "story"` 写「跟着需求「X」修 · 等它会话空闲」或「跟着需求「X」修 · 等前一条修完」；`FridayTop` 的「什么时候开」一行写「需求在测试中，Friday 直接在它的分支上修，不走把握分」，「为什么」那行不显示 intake。
- 进行中：`isFridayRun(source)` 看 `autonomous`，这类缺陷自然进「Friday 在做」；`anchorLine` 对 `source.rootId && source.handedAt` 写「在需求「X」的会话里修」（现有那句「在需求的会话里改」补上需求标题）。
- 详情面板：这类缺陷 `panel = true`（和自主任务一样以会话为主体），「看终端」跳需求的会话（`taskSession(t)` 对有 `rootId` 的缺陷本来就返回根会话）。
- review：交付看会话里 Friday 的那条消息；头部待审区没有 `git_merge`，只有「标记完成」/「打回」。打回见「接手」末段：Friday 带着原因重新交代进需求会话。

## 账本与 `runs`

- 新 action：`story_session_gone`（接手时会话不在）。复用：`autostart`（接手）、`terminal_done` / `terminal_blocked`（交付）、`meegle_transition`（转开发中）、`handed_to_story_terminal` 不再用在这条路上（它是用户点的那条）。
- `runs`：一条缺陷一行，`jobId` 见「接手」第 4 条（headless 用新 job id，敲进去的用 `<需求 jobId>#<缺陷 id8>`），`runByJob` 一处不改；`agent/runLog.ts` 加 `closeRunForTask(taskId, exit)` 按 `taskId` 找最近一行收尾，缺陷这条路一律用它。结局：用户标完成 → `finishTask` 照原逻辑去本地主干找 tip，找不到记 `closed_unverified`——对这类缺陷 tip 在需求分支上、不会进主干，所以 `finishTask` 对 `source.handedAt` 的任务直接记 `merged_as_is`（「在需求分支上交付，由测试环境验收」）；打回记 `rejected`。
- 用量面板「Friday 干的活」按类型多一档「测试阶段缺陷」（`runs.kind` 仍是 `autonomous`，用 `taskId` 对应任务的 `source.handedAt` 区分；`GET /runs/summary` 的聚合加一列）。

## 测试

- `autostart.test.ts`：`testingStoryBug` 的每条不接原因；需求在 testing 且会话在就接、不看 intake；串行；不占并发 1。
- `pipeline.test.ts`：`handToStorySession` 三种情形（interactive 根活着 → `sayToSession`；根退出 → `runInSession` 带 `resumeSessionId`、`-p --model opus`、`allowMerge`；autonomous 根活着 → 不接）、会话不在时的回退、缺陷卡的字段、打回后重交、需求收工时名下缺陷标 blocked。
- `bridge.test.ts`：带 `taskId` 的 `friday_done` 归到缺陷；不带 id 但会话名下恰好一条的也归到缺陷；两条时归需求；不挂 `git_merge`；Meegle 流转调了 `IN PROGRESS`、没有这条流转时交付不报错、流转失败时交付仍成功。
- `guard.test.ts` / `runner.test.ts`：`allowMerge` 时守卫不拦 merge、仍拦 rebase / reset --hard / push 主干。
- `prompt.test.ts`：`storyBugPrompt` 带 `taskId`、不含任何发布命令、原文过围栏。
- 真机验收（按「定时任务」那次的方式）：`FRIDAY_NO_SCHEDULER=1` + `FRIDAY_TMUX_SOCKET=friday-verify` + `FRIDAY_CLAUDE_BIN=<假脚本>`；假脚本收到提示词后调 `friday_done` 带 `taskId`，核对缺陷卡进 review、需求卡没动、账本有 `meegle_transition`（Meegle 连接器换成记录调用的假对象）。

## 留给实现的

- `handedAt` 这个字段名；`autostart.kind` 的具体值。
- `storyBugPrompt` 的措辞，只要满足上面列的要点。
- `runs` 聚合那列的标签文案。
- 前端排队卡的样式，复用现有 `.ftop__queued`。

## 已知边界

- **「需求在测试中」就是 Friday 需求卡的 `stage === "testing"`，不从 Meegle 或「名下出现了缺陷」推断**（2026-10-16 用户定）。你没拨阶段的需求，它的缺陷照旧走把握分那条路。

- 需求不是在 Friday 里做的（没有会话 / worktree）就不接。要接得先在 Friday 里给需求开一次终端，让准备段复用已有分支建 worktree。
- 归属规则②（没带 `taskId` 时归会话名下唯一那条 handed 缺陷）在 interactive 根上有误判面：你在那个终端里让 Claude 顺手干了别的事、它调 `friday_done` 没带 id，也会被算到缺陷头上，需求卡这一轮的 `report` / `terminal_round_done` 就不记。接受：需求在测试中，它自己不再有「这一轮」。
- `source.autonomous: true` 且没有 `jobId` 的缺陷卡是新组合：`reproject.isFridayWork` 会判成「不是 Friday 干的」，改项目走「还没开工直接改」那条，没有回退清单。有意为之：活在需求分支上，项目跟着需求走，不单独回退。
- 需求会话里的 Claude 是交互式的，没有守卫：它要是改错了分支、推错了地方，和你自己在终端里敲错一样。这是接受的——用户定的「在需求会话里修」就意味着这一点。
- 需求会话正在和用户对话（`asking` / 用户刚敲了字还没 Stop）时也会被敲进去，文本会排在用户那句后面。`sayToSession` 现在就是这么做的，不另加判断；用户不希望被打断就说「先别做」（`autostartOff`）。
- 缺陷描述刚建时可能还在改。这条链路不等 15 分钟（用户要的是「拉到就修」），改了描述的缺陷由用户打回重来。
