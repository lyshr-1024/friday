# 统一开工 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 所有代码任务（需求、缺陷、口头 / Slack 落成的）都走同一条自主开工路径：有理解卡、审过或按项目规则不用审、依赖齐、项目已定、阶段未开始、没挂问题、没说先别做，并发没满就开；缺陷的 intake 把握分门禁和设置页「把握门槛」退役。

**Architecture:** 理解卡（`agent/brief.ts` / `agent/briefJob.ts`）和需求门禁（`agent/autostart.ts` 的 `storyEligible`）已在 main。这一块把缺陷放进理解卡（`packages/shared` 的 `briefRefusal`），把 `autostart.ts` 里缺陷专用的 `eligible` 那条路删掉，`storyEligible` 改名 `codeEligible` 管所有代码任务；建卡队列补上「刚进来等 15 分钟」「测试中需求的缺陷不建卡」「卡上没项目用 intake 判的」三条；设置项 `autonomousMinConfidence` 与 `/autostart/preview` 一并删除。

**Tech Stack:** Node + TypeScript（core，hono + node:sqlite，vitest）、React（desktop）、`packages/shared` 前后端共用类型。

**Spec:** `docs/superpowers/specs/2026-10-22-one-conversation-dispatch-design.md` 第四块「统一开工」。

## Global Constraints

- 迭代：在 `apps/core` 下 `pnpm exec vitest run <file>`；每个任务提交前仓库根 `pnpm test` 全绿、`pnpm typecheck` 正好 10 个既有错误（`Project.protected` 相关），不新增。
- 测试不写真实 `~/.claude`、不碰真实记忆库；不起服务、不杀进程（只 kill 自己 `$!` 记下的 PID），tmux 只用 `-L friday-verify`。
- 默认不写注释，只在 WHY 不明显时写一行。
- 中文提交信息，结尾空一行 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`；不用 `-c user.name/-c user.email` 覆盖作者。
- 不改 `testingStoryBug` / `pickStoryBugs` / `handToStorySession` 的交接逻辑（设计稿「已退出那条改交互式 --resume」在第一块已做完：`handToStorySession` 用 `resumeInSession`，见 CLAUDE.md「需求在测试中」一节）。
- 缺陷的理解卡规模一律 `small`（设计稿：「规模判 small，按项目档位，『大的』档免审」）。

## Review Focus

1. **测试中需求名下的缺陷被建了理解卡**：它们走需求会话交代、不该花钱建卡——建卡队列必须跳过 `testingStoryBug(t)` 返回 `{ root }` 的缺陷（Task 2 测试）。
2. **缺陷刚进来描述还在改**：进来不满 `AUTOSTART_SETTLE_MS`（15 分钟）不建卡，否则建完马上因指纹变了被撤、白花一次（Task 2 测试）。
3. **卡上没项目的缺陷永远进不了队列**：`briefRefusal` 要求项目已定；原来自主开工靠 intake 判的项目补上（`projectBy: "friday"`），这条路不能丢——建卡前用 intake 判的、在注册表里的项目写到卡上（Task 2 测试）。
4. **老设置文件里留着 `autonomousMinConfidence`**：读设置不报错、不回写、`PUT /settings` 带它被拒或忽略都不崩（Task 4 测试）。
5. **旧门禁删掉后，已经在跑 / 已交付的缺陷被重开**：只挑 `collected` / `understood`、没 `jobId`、阶段未开始的，已开过工的绝不再开（Task 3 测试）。

---

### Task 1: 缺陷也建理解卡

**Files:**
- Modify: `packages/shared/src/index.ts`（`briefRefusal`：删掉「缺陷不建理解卡，直接修」那一行）
- Modify: `apps/core/src/agent/briefJob.ts`（`storeBrief`：缺陷 `size` 强制 `small`；`setBriefSize` 对缺陷照样允许你手动改档）
- Modify: `apps/core/src/agent/briefJob.ts` 的建卡提示词：缺陷那段改成「先复现 / 定位，写清现象、预期、改哪；验收用例就是复现步骤反过来」（放在现有提示词按类型分的位置，没有就加一段只在缺陷时出现的说明）
- Test: `packages/shared` 对应测试、`apps/core/src/agent/briefJob.test.ts`

**Interfaces:**
- Produces: `briefRefusal(t)` 对 `taskCategory(t.source) === "defect"` 不再拒绝；`storeBrief` 存下的缺陷理解卡 `size === "small"`，`review = reviewFor("small", policy)`。

- [ ] **Step 1: 写失败测试**
  - `briefRefusal` 对一条项目已定、`understood`、阶段未开始的 Meegle 缺陷返回 `undefined`。
  - `storeBrief` 对缺陷：模型交 `size: "large"` → 存下 `small`；项目档位「全部」→ `review === "pending"`，「大的」→ `none`。
  - 建卡提示词对缺陷含「复现」，对需求不含这段。
- [ ] **Step 2: 跑测试看到 RED**
- [ ] **Step 3: 实现**
- [ ] **Step 4: GREEN + 全量**
- [ ] **Step 5: 提交** `缺陷也建理解卡：规模一律小、按项目档位送审，建卡提示词先复现定位`

---

### Task 2: 建卡队列补三条

**Files:**
- Modify: `apps/core/src/agent/brief.ts`（`pickBriefQueue`）、`apps/core/src/agent/briefJob.ts`（`briefTick`）
- Test: `apps/core/src/agent/brief.test.ts`、`apps/core/src/agent/briefJob.test.ts`

**Interfaces:**
- Consumes: `testingStoryBug(t)`、`AUTOSTART_SETTLE_MS`（`agent/autostart.ts`）；`resolveProject`（`memory/projects.ts`）。
- Produces:
  - `pickBriefQueue(tasks, now = Date.now())`：在原过滤之外再排除 ①进来不满 `AUTOSTART_SETTLE_MS` 的（只对 Meegle 来的；口头 / 文档是你自己说的，不等）②`typeof testingStoryBug(t) !== "string"` 的缺陷。
  - `adoptIntakeProject(t: Task): Task`（放 `briefJob.ts`）：卡上没项目、`source.intake?.project` 在注册表里唯一匹配 → `updateTask(project, source.projectBy: "friday")` 并记账 `project_guessed`（why 写「卡上没定项目，用 intake 判的」，how 写「归到 X，不对就在主对话里说，没开工前改项目直接改」，`risk: reversible`）；否则原样返回。`briefTick` 在 `pickBriefQueue` 之前对 `collected` / `understood` 的任务跑一遍。

- [ ] **Step 1: 写失败测试**
  - 刚进来 5 分钟的 Meegle 缺陷不进队列，20 分钟的进；口头任务刚建就进。
  - 所属需求 `stage === "testing"` 且会话在的缺陷不进队列。
  - 没项目、intake 判了已注册项目的缺陷：`briefTick` 后卡上 `project` 是它、`projectBy === "friday"`、有一条 `project_guessed` 账；intake 判的项目不在注册表 → 不写。
- [ ] **Step 2–4**：RED → 实现 → GREEN + 全量
- [ ] **Step 5: 提交** `建卡队列：Meegle 任务等 15 分钟稳定、测试中需求的缺陷不建卡、没项目先用 intake 判的`

---

### Task 3: 一条门禁

**Files:**
- Modify: `apps/core/src/agent/autostart.ts`、`apps/core/src/api/tasks.ts`（`autostartPlan` 调用处如有类型变化）、`packages/shared/src/index.ts`（`AutostartPlan.kind` 去掉 `"gate"`）
- Modify: `apps/desktop/src/views/Board.tsx`（188 行、1233 行附近对 `kind === "gate"` 的展示：删掉，排队卡只剩理解卡那种文案）
- Test: `apps/core/src/agent/autostart.test.ts`

**Interfaces:**
- Produces:
  - `storyEligible` 改名 `codeEligible(t: Task): string | undefined`，适用所有代码任务（不再区分 `isStory`）；`isStory` 删掉。
  - 删除 `eligible`、`previewAutostart`、`AutostartEnv.minConfidence`；`pickAutostart` 只用 `codeEligible`；`autostartPlan` 只给 `kind: "brief"`。
  - `autostartTick`：`pickStoryBugs` 那一路不动；其余只剩理解卡那一路（删掉 intake 那一路及其 `project_guessed`——项目在 Task 2 建卡前就定了）。记账 `why` 写「理解卡你审过 / 按项目规则不用审、依赖齐了」，缺陷和需求同一种写法。
  - `AUTOSTART_SETTLE_MS` 保留（Task 2 用）。

- [ ] **Step 1: 写失败测试**
  - 一条缺陷有 `review: "none"` 的理解卡、依赖齐 → `pickAutostart` 挑中，`intake` 为空也挑中。
  - 一条缺陷 `intake.confidence = 95` 但没理解卡 → 不挑。
  - 已有 `jobId` 或 `status === "processing"` / `"review"` 的缺陷 → 不挑（Review Focus 5）。
  - `autostartPlan` 对满足门禁的缺陷返回 `kind: "brief"`。
  - 原有针对 `eligible` / `previewAutostart` 的测试删掉或改写成 `codeEligible` 的等价断言。
- [ ] **Step 2–4**：RED → 实现 → GREEN + 全量（`pnpm typecheck` 同时覆盖 desktop）
- [ ] **Step 5: 提交** `统一开工：缺陷和需求走同一条理解卡门禁，intake 把握分门禁退役`

---

### Task 4: 删「把握门槛」

**Files:**
- Modify: `apps/core/src/settings.ts`（字段、默认值、解析、写入）、`apps/core/src/api/settings.ts`（zod shape）、`apps/core/src/api/autostart.ts`（删 `/autostart/preview`，文件没别的路由就整个删并从 `api/index.ts` 摘掉）、`apps/core/src/agent/selfTools.ts`（`SETTINGS_KEYS` 去掉它）、`packages/shared/src/index.ts`（`AUTOSTART_CONFIDENCE`、`Settings` 类型里的字段——确认没有别处用再删）
- Modify: `apps/desktop/src/lib/core.ts`（`autostartPreview`）、`apps/desktop/src/views/Settings.tsx`（「把握门槛」那一行和 preview 的状态）
- Test: `apps/core/src/settings.test.ts`、`apps/core/src/api/autostart.test.ts`（删或改）、`apps/core/src/agent/selfTools.test.ts`

**Interfaces:**
- Produces: `UserSettings` 不再有 `autonomousMinConfidence`；`settings_update` 白名单不含它。

- [ ] **Step 1: 写失败测试**
  - 老 `settings.json` 里有 `"autonomousMinConfidence": 70` → `userSettings()` 正常读、结果里没有这个键（Review Focus 4）。
  - `PUT /settings {autonomousMinConfidence: 70}` → 不崩（看现有 zod 是 strict 还是 strip，照它：strict 就 400，strip 就 200 且不写进文件），断言写清。
  - `settings_update {autonomousMinConfidence: 70}` → 回文本拒绝，不改文件。
- [ ] **Step 2–4**：RED → 实现 → GREEN + 全量（含 desktop typecheck）
- [ ] **Step 5: 提交** `删掉设置页「把握门槛」和 /autostart/preview：缺陷不再按 intake 把握分开工`

---

### Task 5: 文档

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1**：新增「统一开工（2026-10-22）」一节（放在「理解卡（2026-10-22）」之后）：一条门禁的条件、缺陷建卡（规模小、按档位、提示词先复现）、建卡队列三条补充（15 分钟、测试中需求的缺陷不建、没项目用 intake 判的）、intake 现在只用来猜项目、把握门槛删了。改掉旧节里被推翻的句子：「Friday 自己开自主任务」一节门禁那条（Meegle 缺陷、intake ≥ 80、15 分钟…）、「面板」里把握门槛可拖、`/autostart/preview`、「理解卡」一节里「缺陷门禁仍走 intake 把握分，不动」「`briefRefusal`…非缺陷」「开工门禁…缺陷不走」、对话里管自己一节白名单里的 `autonomousMinConfidence`。
- [ ] **Step 2**：`pnpm test`、`pnpm typecheck` 跑一遍确认基线。
- [ ] **Step 3: 提交** `文档：统一开工`
