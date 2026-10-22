# 可插话的代码任务 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Friday 起的代码任务改成在 tmux 里跑交互式 `claude`（带守卫、显式 `--model opus`），中途能插话；交付以 `friday_done` 为准，停了没交付催一次，名额按任务状态释放，打回自动续跑，所有开工入口都改成 Friday 驾驶。

**Architecture:** 只动 `apps/core` 的启动脚本、hook 回报、账本和开工入口，前端只改开工菜单和设置页一个控件。`-p` 只留给只读查询（`kind: "query"`）；`kind: "autonomous"` 的会话改跑交互式进程，进程交付后不退出。「这一轮欠一次交付」记在 `jobs` 表上，由 Stop hook 驱动催促。

**Tech Stack:** TypeScript、hono、vitest、`node:sqlite`、tmux、React。

**Spec:** `docs/superpowers/specs/2026-10-22-one-conversation-dispatch-design.md` 第一块「Friday 起的代码任务改成可插话」。

## Global Constraints

- 模型一律写别名：Friday 驾驶的会话和只读查询都传 `--model opus`（`HEADLESS_MODEL`），用户自己的交互式会话（项目页）不传。
- 守卫只拦保护分支，名单从 `protectedBranches(project)` 取，不改守卫规则本身。
- 测试：`pnpm --filter @friday/core test -- <文件>`；全量 `pnpm test`、`pnpm typecheck` 在每个任务提交前跑。
- 提交信息用中文，结尾带 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`；不要用 `-c user.name/-c user.email` 覆盖作者。
- 验证时禁止 `pkill` / `killall` / 按模式杀进程，只 `kill` 自己用 `$!` 记下的 PID；tmux 用 `FRIDAY_TMUX_SOCKET=friday-verify`，清理只 `tmux -L friday-verify kill-server`。
- `feat/brief-card` 还没合进 main，它的 Task 5 也改了 `agent/autostart.ts`（需求门禁）。本计划只改 `runningAutonomous` / `pickAutostart` / 并发常量这几处，不碰 `eligible` 和需求相关代码，合并时按「名额判据用本计划的、门禁用 brief-card 的」解冲突。
- 和设计稿不一样的地方（计划的决定）：①缺陷交接的「需求会话已退出」那条，设计稿放在第四块，这里在 Task 7 一起改，因为 Task 1 之后 `runInSession` 不再起 `-p`，原来的 headless fork 路径会变成在需求窗格里起第二个交互式 Claude；②设计稿说 `startInteractiveJob` 只剩项目页在用，实际项目页走 `openSession`，所以 Task 8 直接删掉它；③设计稿说「交付消息和任务卡上都展示」`decisions`，任务卡早已不渲染交付报告，只进交付消息；④设计稿「存过 `false` 的在主对话里提示一次」要等第二块的主对话，这里只改默认值。

## Review Focus

1. **升级那一刻还在跑的老 `-p` 任务**：它退出时没有 `friday_done`，靠报告文件交付。`onJobExit` 的 `collectReport` 文件兜底要保留，老任务照旧进 review（Task 3 测试）。
2. **你在 Friday 驾驶的终端里自己打字**：这一轮 Claude 答完不调 `friday_done` 不能被催；Friday 敲进去的长提示词在 hook 里被截断到 4000 字，判「是不是 Friday 敲的」要按前缀比（Task 3 测试）。
3. **`friday_done` 和 Stop 在同一轮里先后到**：`friday_done` 先清掉「欠交付」，紧跟着的 Stop 不能再催（Task 3 测试）。
4. **你在终端里 `/exit` 或 Claude 崩了**：Friday 驾驶的任务不能因为退出码 0 被标成 done，要标 blocked「Claude 退出了，这一轮没交付」（Task 3 测试）。
5. **名额**：交付 / 卡住的任务 Claude 进程还活着，但不占名额；打回续跑重新占（Task 5、Task 6 测试）。

---

### Task 1: Friday 驾驶的会话跑交互式 claude，显式传模型

**Files:**
- Modify: `apps/core/src/agent/runner.ts`（`claudeArgs`、`claudeFlags`、`SessionLaunch`、`workCommand`）
- Modify: `apps/core/src/agent/sessions.ts`（`openSession`、`resumeInSession`、`reviveSession`、`jobKind`）
- Modify: `apps/core/src/agent/prompt.ts`（`terminalBridgePrompt` 第二个参数改名）
- Test: `apps/core/src/agent/runner.test.ts`、`apps/core/src/agent/sessions.resume.test.ts`

**Interfaces:**
- Produces: `SessionLaunch.print?: boolean`（只有它为真才带 `-p`）；`claudeArgs(files: ClaudeFiles, launch: { kind: TermSessionKind; print?: boolean }, project?: string): string[]`；`claudeFlags` 同签名；`terminalBridgePrompt(project?: string, fridayDriven = false): string`。规则：`kind !== "interactive"` → `--model opus` + 守卫版桥接提示词（不带手册，手册在 `autonomousPrompt` 里）；`print` → `-p`。

- [ ] **Step 1: 写失败测试**（`runner.test.ts`）

```ts
it("Friday 驾驶的会话跑交互式：带 --model opus，不带 -p", () => {
  const cmd = workCommand({ id: "j1", repoDir: "/r", kind: "autonomous", task: "改", project: "p" }, "/bin/claude", 7788, { settings: "/s", mcp: "/m" }).join("\n");
  expect(cmd).toContain("--model opus");
  expect(cmd).not.toMatch(/ -p /);
});
it("只读查询仍是 -p --model opus；用户自己的交互式两样都不带", () => {
  const files = { settings: "/s", mcp: "/m" };
  expect(claudeArgs(files, { kind: "query", print: true }).slice(0, 3)).toEqual(["-p", "--model", "opus"]);
  const mine = claudeArgs(files, { kind: "interactive" });
  expect(mine).not.toContain("-p");
  expect(mine).not.toContain("--model");
});
```

`report.test.ts:33` 现有的 `["-p","--model","opus"]` 断言改成传 `{ kind: "query", print: true }`。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @friday/core test -- runner.test.ts report.test.ts`
Expected: FAIL（`claudeArgs` 第二参数还是 boolean）

- [ ] **Step 3: 实现**

`workCommand` 用 `claudeFlags(files, { kind: req.kind, print: req.print }, req.project)`。`openSession` 往 `launch` 里加 `print: o.kind === "query"`。`resumeInSession` / `reviveSession` 的 `writeResumeScript` 第一个参数里 `kind` 改成 `jobKind(job, s.kind)`（原来写死 `"interactive"`，接回自主任务时不传模型、会继承用户的默认值），`print` 不传（接回一律交互式）。`terminalBridgePrompt` 的 `headless` 参数改名 `fridayDriven`，调用处传 `kind !== "interactive"`。

- [ ] **Step 4: 加接回测试**（`sessions.resume.test.ts`）：自主任务的 job 被 `resumeInSession` 接回时，写出的 resume 脚本含 `--model opus`、不含 ` -p `；交互式任务的不含 `--model`。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @friday/core test -- runner.test.ts report.test.ts sessions.resume.test.ts runner.session.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 6: 提交** `git commit -m "Friday 驾驶的会话改跑交互式 claude：显式 --model opus，-p 只留给只读查询；接回自主任务也带模型"`

---

### Task 2: 自主提示词、`decisions` 字段、交付时收截图

**Files:**
- Modify: `apps/core/src/agent/runner.ts`（`autonomousPrompt`、`buildHookSettings` 里 `refuseAsking` 的理由）
- Modify: `packages/shared/src/index.ts`（`DeliveryReport`）
- Modify: `apps/core/src/agent/bridge.ts`（`friday_done` 的 schema 与解析、自主分支收截图）
- Modify: `apps/core/src/agent/delivery.ts`（`deliveryText`）
- Test: `apps/core/src/agent/runner.test.ts`、`apps/core/src/agent/delivery.test.ts`、`apps/core/src/agent/bridge.test.ts`

**Interfaces:**
- Produces: `DeliveryReport.decisions?: string[]`；`friday_done` 输入多一个 `decisions: list("方案没写到、你替用户定了的事，每条一句")`；`collectShots(jobId: string, since?: string): Attachment[]`（只收 mtime 晚于 `since` 的）。

- [ ] **Step 1: 写失败测试**

```ts
// runner.test.ts
it("自主提示词：交付走 friday_done、写替你定了、影响别人的调 friday_blocked、交付后可能被追问", () => {
  const p = autonomousPrompt("j1", "改导出", "p");
  expect(p).toContain("friday_done");
  expect(p).toContain("decisions");
  expect(p).toMatch(/接口约定.*公共组件.*远端数据/);
  expect(p).toContain("friday_blocked");
  expect(p).not.toContain(reportPath("j1"));
});
// delivery.test.ts
it("交付消息带「替你定了」", () => {
  const r = { summary: "s", changes: [], testSteps: [], testResult: "过", screenshots: [], verify: [], decisions: ["字段用 string"] };
  expect(deliveryText(r)).toContain("替你定了：\n- 字段用 string");
});
```

`bridge.test.ts`：自主任务调 `friday_done` 带 `decisions`，任务 `report.decisions` 等于传入值；`shotsDir(jobId)` 里事先放一张 png，交付后 `report.screenshots` 长度为 1。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @friday/core test -- runner.test.ts delivery.test.ts bridge.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`autonomousPrompt` 第 4 条改成「做完调 friday_done 交付：summary / changes / testSteps / testResult / verify / decisions」，不再要求写报告文件。第 5 条换成固定文案：

> 5. 中途不要问用户。方案和知识库没覆盖的，按项目惯例自己定，接着做，每一条都写进 friday_done 的 decisions。会影响别人的——改接口约定、动公共组件、碰远端数据——不要自己定，调 friday_blocked 说清楚要用户定什么，然后停下。

末尾加一条：「交付后用户可能在这个终端里追问，Friday 也可能把打回原因敲进来；接着改，改完再调一次 friday_done。」

`refuseAsking` 的理由换成「中途不问用户。按方案和知识库自己定，写进 friday_done 的 decisions；影响别人的（接口约定、公共组件、远端数据）调 friday_blocked。」

`collectShots` 在 `pipeline.ts`（现有那个）加可选 `since` 参数。`friday_done` 自主分支在 `updateTask` 前调 `collectShots(jobId, task.report?.at)`，结果放进 `report.screenshots`（原来要等进程退出时 `onJobExit` 才收，现在进程不退出）。`deliveryText` 在测试结果之后、请你验证之前插入「替你定了：」段。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @friday/core test -- runner.test.ts delivery.test.ts bridge.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: 提交** `git commit -m "自主提示词改成 friday_done 交付、替你定了写进 decisions、影响别人的才停下；交付时就收截图"`

---

### Task 3: 停了没交付催一次，退出不再算完成

**Files:**
- Modify: `apps/core/src/memory/db.ts`（`jobs` 补两列）、`apps/core/src/memory/jobs.ts`、`packages/shared/src/index.ts`（`Job`）
- Modify: `apps/core/src/agent/runner.ts`（`buildHookScript` 转发 `prompt`）
- Modify: `apps/core/src/api/jobs.ts`（`/jobs/:id/message` 接线）
- Modify: `apps/core/src/agent/sessions.ts`（`sayToSession`、`openSession`、`runInSession` 标「欠交付」）
- Modify: `apps/core/src/agent/bridge.ts`（`friday_done` / `friday_blocked` 清「欠交付」）
- Modify: `apps/core/src/agent/pipeline.ts`（`onJobExit` 自主无报告分支）
- Create: `apps/core/src/agent/rounds.ts`
- Test: `apps/core/src/agent/rounds.test.ts`、`apps/core/src/agent/pipeline.test.ts`、`apps/core/src/agent/runner.test.ts`

**Interfaces:**
- Produces:
  - `jobs.awaiting_delivery INTEGER`、`jobs.nudged_at TEXT`；`Job.awaitingDelivery?: boolean`、`Job.nudgedAt?: string`
  - `memory/jobs.ts`：`markAwaiting(jobId: string): void`（置 1、清 `nudged_at`）、`clearAwaiting(jobId: string): void`、`markNudged(jobId: string): void`、`isFridayInput(jobId: string, prompt: string): boolean`（这个 job 在 `terminal_inputs` 里有一条，去首尾空白后前 500 字和 `prompt` 的前 500 字相同）
  - `agent/rounds.ts`：`export const NUDGE_TEXT = "继续。做完调 friday_done 交付，卡住调 friday_blocked。"`；`roundStopped(jobId: string): Promise<"none" | "nudged" | "blocked">`；`userPrompted(jobId: string, prompt?: string): void`
- 「欠交付」只对 Friday 驾驶的会话生效：job 的 owner 任务 `source.autonomous && !source.headless`。

- [ ] **Step 1: 写失败测试**（`rounds.test.ts`，用临时 `FRIDAY_DATA_DIR`，`setLauncher` / tmux 发送打桩，同 `sessions.test.ts` 的做法）

```ts
it("Friday 发起的一轮停了没交付：第一次催，第二次标卡住", async () => {
  // 自主任务 + job，markAwaiting(job)
  expect(await roundStopped(job)).toBe("nudged");
  expect(sent).toEqual([NUDGE_TEXT]);
  expect(await roundStopped(job)).toBe("blocked");
  expect(getTask(task).status).toBe("blocked");
  expect(getTask(task).progress).toBe("停下来了没交付，看终端");
});
it("friday_done 之后紧跟的 Stop 不催", async () => { /* markAwaiting → clearAwaiting → roundStopped === "none" */ });
it("你自己在终端里打字的那一轮不催", async () => {
  markAwaiting(job);
  userPrompted(job, "这里为什么用 number？");
  expect(await roundStopped(job)).toBe("none");
});
it("Friday 敲的长提示词被 hook 截到 4000 字，仍认得出", async () => {
  const long = "改".repeat(6000);
  recordTerminalInput(job, long);
  markAwaiting(job);
  userPrompted(job, long.slice(0, 4000));
  expect(getJob(job)!.awaitingDelivery).toBe(true);
});
it("用户自己驾驶的会话（interactive）从不催", async () => { /* owner autonomous=false → "none" */ });
```

`pipeline.test.ts`：①Friday 驾驶的任务在 processing、没有报告文件，`onJobExit(job, 0)` → `blocked`，progress「Claude 退出了，这一轮没交付，看终端」；②有报告文件（老 `-p` 任务）→ 照旧 `review`。`runner.test.ts`：hook 脚本里转发 `prompt`（`buildHookScript` 输出含 `prompt`）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @friday/core test -- rounds.test.ts pipeline.test.ts runner.test.ts`
Expected: FAIL（`rounds.ts` 不存在）

- [ ] **Step 3: 实现**

- `db.ts` 按现有 `jobCols.includes(...)` 的写法补两列；`jobs.ts` 的行映射带上新字段。
- `buildHookScript` 从 hook 输入里多取 `prompt`，`String(prompt).slice(0, 4000)` 作为 `prompt` 字段 POST；`/jobs/:id/message` 的 zod 加 `prompt: z.string().max(4000).optional()`，放宽「至少一个」的校验，让只带 `prompt` 的请求也能过。
- `/jobs/:id/message`：`UserPromptSubmit` 分支里调 `userPrompted(id, prompt)`；`Stop` 分支在 `markStop` 之后 `void roundStopped(id)`。
- `userPrompted`：job 欠交付且 `prompt` 存在、`!isFridayInput(job, prompt)` → `clearAwaiting`。没带 `prompt`（老版本 hook）就不动。
- `roundStopped`：不是 Friday 驾驶、或不欠交付 → `"none"`。没催过 → `sayToSession(sessionId, NUDGE_TEXT)`，**之后**再 `markNudged`（`sayToSession` 里的 `markAwaiting` 会清 `nudged_at`，顺序反了就会无限催），记账 `round_nudged`。催过 → `clearAwaiting`，任务标 `blocked`（progress 见测试），`closeRun(jobId, "no_report")`，通知「停下来了没交付」，记账 `round_stalled`。
- 「欠交付」打标：`openSession` / `runInSession` 在 `kind === "autonomous"` 时 `markAwaiting(jobId)`；`sayToSession` 在会话 `kind === "autonomous"` 且送出（`"sent"` / `"queued"`）时 `markAwaiting(s.jobId)`（`recordTerminalInput` 已在里面，Friday 敲的话因此认得出）。
- `friday_done` / `friday_blocked` 处理完后 `clearAwaiting(jobId)`（缺陷借需求 job 交付时同样清）。
- `onJobExit`：删掉「`interactive = !plan && !report && !scheduleId` 退出码 0 就 done」那条。走到这里、没有报告的 Friday 驾驶任务一律 `blocked`，progress「Claude 退出了，这一轮没交付，看终端」（退出码 -1 写「会话已不在」，沿用 `exitText`）。`collectReport` 读报告文件的兜底保留，给升级时还在跑的老 `-p` 任务用。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @friday/core test -- rounds.test.ts pipeline.test.ts runner.test.ts bridge.test.ts sessions.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: 提交** `git commit -m "Friday 驾驶的一轮停了没交付先催一次、再停就标卡住；你自己在终端里问的不催；Claude 退出不再算完成"`

---

### Task 4: 账本一轮交付一行

**Files:**
- Modify: `packages/shared/src/index.ts`（`RunTrigger` 加 `"rejected" | "followup"`；`RunOutcome` 加 `"superseded"`；`RunsProjectSummary` 加 `superseded: number`）
- Modify: `apps/core/src/agent/runLog.ts`、`apps/core/src/memory/runs.ts`（`runsSummary`）
- Modify: `apps/core/src/agent/bridge.ts`（`friday_done` 自主分支）
- Modify: `apps/desktop/src/views/Usage.tsx`（「Friday 干的活」那一行多显示「又交一轮 N」）
- Test: `apps/core/src/agent/runsHooks.test.ts`、`apps/core/src/memory/runs.test.ts`

**Interfaces:**
- Produces: `startRound(jobId: string, taskId: string, project: string, trigger: RunTrigger, at?: string): RunRecord`。id 是 `${jobId}#${n}`，`n` = 这个 job 已有的非 `interactive_round` 行数 + 1；`kind` 沿用这个 job 第一行的 kind；`costBase` = 此刻 `sessionCost(job.dir, job.claudeSessionId)` 的累计值；同一个 job 上还是 `pending` 的旧行改成 `superseded`（「后面又交了一轮」）。
- Consumes: `closeRun(jobId, exit)` 不变：它关的是 `runByJob` 拿到的最新一行。

- [ ] **Step 1: 写失败测试**

```ts
// runsHooks.test.ts
it("同一个 job 交付两次：两行，第二行 followup，第一行被标 superseded，成本只记增量", async () => {
  // 自主任务开工（第一行 id = jobId），transcript 成本 1.0 → friday_done
  // transcript 成本累计到 1.5 → 再 friday_done
  const rows = runsForTask(task);
  expect(rows.map((r) => r.id)).toEqual([job, `${job}#2`]);
  expect(rows[1]!.trigger).toBe("followup");
  expect(rows[0]!.outcome).toBe("superseded");
  expect(rows[1]!.costUsd).toBeCloseTo(0.5);
});
// runs.test.ts
it("superseded 单独计数，不算待定", () => { /* runsSummary(...).byProject[0].superseded === 1, pending === 0 */ });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @friday/core test -- runsHooks.test.ts runs.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`friday_done` 自主分支在 `closeRun(jobId, "report")` 前：`runByJob(jobId)` 已经 `endedAt` 了（上一轮交付过）就 `startRound(jobId, task.id, project, "followup", 上一行的 endedAt)`。结局写入点（`settleRun`、`git_merge`、`rejectTask`）都只看 `pending` 的行，`superseded` 自然不会被它们改。`runsSummary` 给 `superseded` 加一个分支。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @friday/core test -- runsHooks.test.ts runs.test.ts bridge.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: 提交** `git commit -m "结果账本一轮交付一行：同一会话再交付记 followup，前一轮标 superseded，成本按轮记增量"`

---

### Task 5: 并发名额按任务状态算，默认 3、默认开

**Files:**
- Modify: `apps/core/src/settings.ts`、`packages/shared/src/index.ts`（设置类型）、`apps/core/src/api/settings.ts`
- Modify: `apps/core/src/agent/autostart.ts`（删 `AUTOSTART_MAX_RUNNING`，改 `runningAutonomous`、`AutostartEnv`、`pickAutostart`、`autostartTick`）
- Modify: `apps/desktop/src/views/Settings.tsx`（「自主开工」一节加「同时最多几条」）
- Test: `apps/core/src/agent/autostart.test.ts`、`apps/core/src/settings.test.ts`

**Interfaces:**
- Produces: `UserSettings.autonomousConcurrency: number`（默认 3，读写时钳到 1–10 的整数）；`DEFAULTS.autonomous = true`；`AutostartEnv.max: number`；`runningAutonomous(): number` 数「`status === "processing"`、`source.autonomous`、非 `headless`、非 `scheduleId`、非 `handedAt`」的任务，**不看 job 状态**。

- [ ] **Step 1: 写失败测试**

```ts
// autostart.test.ts
it("交付了 / 卡住的任务不占名额，哪怕 Claude 进程还活着", () => {
  // 三条自主任务：processing / review / blocked，job 都是 running
  expect(runningAutonomous()).toBe(1);
});
it("按 env.max 放", () => {
  expect(pickAutostart(fiveEligible, { ...env, running: 1, max: 3 })).toHaveLength(2);
});
// settings.test.ts
it("并发默认 3、钳到 1–10；自主开工默认开，存过 false 的不动", () => { /* ... */ });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @friday/core test -- autostart.test.ts settings.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`autostartTick` 里 `env.max = userSettings().autonomousConcurrency`；`autostartPlan` 的 `behind` 不变。设置页加一个 1 / 2 / 3 / 5 的分段控件，写 `autonomousConcurrency`，说明文字：「Friday 自己开工时最多同时做几条。交付了、卡住了的不算。」

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @friday/core test -- autostart.test.ts settings.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: 提交** `git commit -m "自主开工并发改成设置项（默认 3），名额按任务状态算、交付和卡住就释放；自主开工默认打开"`

---

### Task 6: 打回 = 在原终端续跑

**Files:**
- Modify: `apps/core/src/agent/pipeline.ts`（`rejectTask`）
- Test: `apps/core/src/agent/pipeline.test.ts`

**Interfaces:**
- Consumes: `startRound`（Task 4）、`continueRootSession(root, text)`（已有：会话 exited 就 `resumeInSession`，否则 `sayToSession`；后者会 `markAwaiting`）、`runningAutonomous`（Task 5）。
- 只管 Friday 驾驶、非 `handedAt` 的任务（`source.autonomous && !source.headless && !source.handedAt`）；缺陷打回走原来的 `handToStorySession`，不变。

- [ ] **Step 1: 写失败测试**

```ts
it("打回 Friday 驾驶的任务：原因敲进它的会话，新起一轮 rejected，任务回 processing 占名额", async () => {
  // 任务 review、会话 running；rejectTask(id, "按钮颜色不对")
  expect(sent[0]).toContain("上一轮被打回：按钮颜色不对");
  expect(runsForTask(id).at(-1)!.trigger).toBe("rejected");
  expect(getTask(id).status).toBe("processing");
  expect(runningAutonomous()).toBe(1);
});
it("会话已不在：标卡住，写「打回了，但会话已不在，点「开工」重开」", async () => { /* ... */ });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @friday/core test -- pipeline.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`rejectTask` 现有逻辑之后，对上面那类任务 `void` 一段：`startRound(t.source.jobId, t.id, project, "rejected")`，再 `continueRootSession(resolveRoot(t), "上一轮被打回：<原因>。按这个改，改完再调 friday_done。")`；返回 false 就标 blocked（文案见测试）。出错同缺陷那条，写进 progress 不抛。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @friday/core test -- pipeline.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: 提交** `git commit -m "打回 Friday 自己做的任务：原因直接敲进它的终端开下一轮，会话不在才标卡住"`

---

### Task 7: 测试中需求的缺陷交进活着的需求会话

**Files:**
- Modify: `apps/core/src/agent/pipeline.ts`（`handToStorySession`）
- Test: `apps/core/src/agent/autostart.test.ts` 里现有的 story-bug 用例（或它所在的测试文件，`rg handToStorySession apps/core/src --glob '*.test.ts'`）

**Interfaces:**
- 判「Claude 在干活」用 `sessionState.ts` 的同一判据：`lastInputAt > lastStopAt`。
- 返回值不变：`"handed" | "busy" | "asking" | "no-session"`。

- [ ] **Step 1: 写失败测试**

```ts
it("需求会话是 Friday 驾驶的、Claude 活着且空闲：敲进去，run 记 <需求 jobId>#<缺陷 id8>", async () => { /* kind autonomous, lastStopAt > lastInputAt → "handed" */ });
it("Claude 正在一轮里（lastInputAt > lastStopAt）：busy，不敲", async () => { /* → "busy" */ });
it("Claude 已退出：在需求自己的 Claude 会话上 --resume 接回并敲进去，不 fork、不起 -p", async () => {
  // 断言 resume 脚本含 --resume <需求的 claude session>、不含 --fork-session、不含 -p；run.jobId 同敲字那条
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @friday/core test -- <上面找到的测试文件>`
Expected: FAIL

- [ ] **Step 3: 实现**

删掉 `alive && s.kind !== "interactive"` → `"busy"` 那条，换成「Claude 活着且在一轮里 → busy」，不分会话 kind。已退出那条换成 `resumeInSession(root.id, prompt)`，run 的 `jobId` 和敲字那条一样用 `${s.jobId}#${task.id.slice(0, 8)}`，去掉 `costBase` 与 `forkSession`，缺陷卡不再写自己的 `source.jobId`（交付归属靠 `taskId`，同敲字那条）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @friday/core test && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: 提交** `git commit -m "缺陷交接改成认需求会话里 Claude 忙不忙：空闲就敲、在干活就等，已退出就在需求自己的会话上接回，不再 fork -p"`

---

### Task 8: 所有开工入口改成 Friday 驾驶，合成一个「开工」

**Files:**
- Modify: `apps/core/src/agent/taskStart.ts`（合并成一个 `startTask`）
- Modify: `apps/core/src/agent/pipeline.ts`（删 `startInteractiveJob`）
- Modify: `apps/core/src/api/tasks.ts`（删 `/tasks/:id/retry`）、`apps/core/src/api/run.ts`、`apps/core/src/api/summon.ts`、`apps/core/src/agent/schedule.ts`、`apps/core/src/agent/tools.ts`（`run_claude`、`task_start`）
- Modify: `apps/desktop/src/lib/core.ts`（删 `taskRetry`）、`apps/desktop/src/views/Board.tsx`（菜单与空态文案）
- Test: `apps/core/src/agent/taskStart.test.ts`、`apps/core/src/agent/schedule.test.ts`、`apps/core/src/agent/tools.test.ts`

**Interfaces:**
- Produces: `startTask(t: Task, trigger: RunTrigger = "retry"): Promise<StartResult>`，顺序：①`handedAt` 且 processing → 409（原样）；②所属需求在测试中 → `handToStorySession`（原 `handToFriday` 那段，原样）；③否则带 `handedAt` 的先 `clearHanded`（原 `startTask` 那段），再 `startAutonomousJob`，detail 用原 `handToFriday` 的取法。不看并发名额（你点的就开）。`handToFriday` 删掉。
- `task_start` 工具去掉 `mode` 参数。`run_claude` / `POST /run` / 「跑 <项目>」**必须带任务**：没带就回「没说要做什么。想自己在项目里干活去项目页开 Claude；要 Friday 做就说做什么。」（`/run` 回 400）。

- [ ] **Step 1: 写失败测试**

```ts
// taskStart.test.ts
it("开工一律是 Friday 驾驶：会话 kind autonomous，任务 source.autonomous", async () => { /* startTask(t) → getTermSession(t.id).kind === "autonomous" */ });
// schedule.test.ts
it("有人值守的定时任务到点也由 Friday 开工，并发通知「到点了，已在 X 开工」", async () => { /* ... */ });
// tools.test.ts
it("run_claude 没给任务：不开终端，指去项目页", async () => { /* ... */ });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @friday/core test -- taskStart.test.ts schedule.test.ts tools.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`run_claude`、`POST /run`、`summon.ts` 的 relay、`schedule.ts` 的 attended 分支都改调 `startAutonomousJob(task, project, dir, detail, trigger)`：前三个 trigger `"user"`，定时 `"schedule"`。定时的通知文案改「到点了，已在 X 开工」，结果「已开工，干完交审」两种值守一样。删掉 `startInteractiveJob` 和 `/tasks/:id/retry`。前端：`Board.tsx` 两处菜单（约 573–574、919–920 行）合成一项「开工」，条件 `canStart(t) || canRehand(t)`，调 `taskStart`；空态文案（约 1169–1172 行）改成「在会话里说「开工」，Friday 在 worktree 里做完交给你验收，中途你随时能在终端里插话」；`Board.tsx:220` 的「开始做」改「开工」；输入框 placeholder 改「开工 / 这条不用管了」。

- [ ] **Step 4: 跑测试与前端类型检查**

Run: `pnpm test && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: 提交** `git commit -m "开工入口全部改成 Friday 驾驶：开始做与交给 Friday 改合成「开工」，run_claude / 跑项目 / HUD 转交 / 有人值守的定时任务一并改；删 startInteractiveJob 与 /retry"`

---

### Task 9: 真机验收与文档

**Files:**
- Modify: `CLAUDE.md`（「终端：tmux 持有进程、详情就是终端」「Friday 自己开自主任务」两节里对应的现状描述，新增一小节「可插话的代码任务（2026-10-22）」）
- 一次性脚本放 scratchpad，不进仓库

- [ ] **Step 1: 起隔离的 core**

假 claude（文件名必须叫 `claude`，`claudeAlive` 按进程名认）：把收到的参数追加写进 `$FRIDAY_FAKE_ARGS`，然后 `while read -r line; do print "got: $line"; done`。准备段那次（带 `-p --model sonnet`）要照 CLAUDE.md「定时任务」一节的做法建一个真 worktree 并写路径文件。

```bash
FRIDAY_PORT=7791 FRIDAY_DATA_DIR=<临时目录> FRIDAY_NO_SCHEDULER=1 FRIDAY_TMUX_SOCKET=friday-verify FRIDAY_CLAUDE_BIN=<假 claude> FRIDAY_FAKE_ARGS=<文件> pnpm dev:core & echo $!
```

前后各看一次 `lsof -nP 2>/dev/null | grep -c /dev/ptmx`。core 要挂在活着的父进程下（`index.ts` 发现 `ppid === 1` 会退出）。

- [ ] **Step 2: 逐条验**，每条记下命令和看到的结果
  1. 建一条有项目的任务，`POST /tasks/:id/start` → 参数文件里干活那次含 `--model opus`、不含 `-p`；`tmux -L friday-verify capture-pane` 看到提示词。
  2. `POST /jobs/<job>/message {event:"Stop"}` → 窗格里出现 `NUDGE_TEXT`；再发一次 → 任务 `blocked`、progress「停下来了没交付，看终端」。
  3. 新开一条，经 `POST /mcp/<job>` 调 `friday_done`（带 `decisions`）→ 任务 `review`，`GET /runs/summary` 有一行；`runningAutonomous` 对应的名额已释放（`GET /autostart/preview` 或直接查库）。
  4. `POST /tasks/:id/reject {reason}` → 窗格里出现「上一轮被打回：…」，任务回 `processing`，runs 多一行 `#2`、trigger `rejected`。
  5. `POST /jobs/<job>/message {event:"UserPromptSubmit", prompt:"你自己问的一句"}` 再发 Stop → 不催。
- [ ] **Step 3: 收尾**：`kill <记下的 PID>`，`tmux -L friday-verify kill-server`，删临时目录；ptmx 计数回到起点。
- [ ] **Step 4: 改 CLAUDE.md**：写清 `-p` 只留给只读查询、Friday 驾驶的会话不退出、「欠交付」与催一次、名额判据、打回续跑、runs 一轮一行与 `superseded`、开工入口只剩「开工」、用户自己驾驶的终端只剩项目页。删掉跟这些冲突的旧描述（「自主任务的 friday_done 也不关…`claude -p` 交付完自己退出」「并发 1」「开始做 = 交互式终端」等）。
- [ ] **Step 5: 提交** `git commit -m "文档：可插话的代码任务"`
