# 对话里管自己 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 页面上能做的配置，在主对话里一句话就能做（设置、项目登记、手册规则、知识库纠正、遗留 worktree），按页面同样的分级记账、能撤；超出配置范围的行为改动，Friday 在 `friday` 项目上开任务去做，那个项目一律送审。

**Architecture:** 新增 `agent/selfTools.ts` 放这一组会话工具，并进 `fridayToolList(conversationId)`；每个工具改动前取快照、改完记一条账（`evidence.quote` = 用户这一轮的原话，`undo` 指向新的或已有的撤销种类），撤销在 `api/tasks.ts` 的 `POST /audit/:id/undo` 里执行。撤不回的（删 worktree）用两步：先说清后果，用户这一轮整句同意才执行。

**Tech Stack:** TypeScript、hono、vitest、`node:sqlite`、zod、Claude Agent SDK MCP 工具。

**Spec:** `docs/superpowers/specs/2026-10-22-one-conversation-dispatch-design.md` 第三块「对话里管自己」。第一、二块已在 main。

## Global Constraints

- 页面上能做的，对话里都能做，分级和页面一致：可撤销的直接做、记账、`undo` 能撤；撤不回的要用户在对话里整句点头。
- 每次改动都记下用户那句原话（`evidence.quote`）。
- `settings_update` 白名单：`autonomous`、`autonomousConcurrency`、`autonomousMinConfidence`、`model`、`skills`、`skillList`、`okrWeekly`、`learnHistory`、`meegleDefects`、`name`、`theme`。`hotkey` 不放（壳启动时才读）。
- `friday` 项目：方案一律送审；合并一律由用户做；交付报告写明「要重启 Friday / 重新打包才生效」。
- 测试：`apps/core` 下 `pnpm exec vitest run <file>`；每个任务提交前 `pnpm test` 全绿、`pnpm typecheck` 只有 main 上已有的 10 个 `Project.protected` 错误。测试不写真实 `~/.claude`。
- 提交信息中文，结尾空一行 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。

## 计划的决定（设计稿没写死的）

- `autonomousMinConfidence` 先留在白名单里：设计稿把它划出白名单是因为第四块要退役 intake 门禁，第四块还没做，门禁还在用它。第四块做的时候一起删。
- `meegleDefects` 加进白名单：设置页上有这个开关，设计稿的白名单漏了它。
- 撤销种类新增两个：`restore_settings { before: Partial<UserSettings> }`、`restore_rules { snapshot: RulesSnapshot }`。项目登记沿用 `restore_memory`（它本来就存 `projects` 全文）。知识库沿用 `restore_features`，快照扩成连历史行一起存，这样删条目也能撤；设置页的「删功能」顺带也能撤了（同一个函数）。
- 用户纠正过的知识库字段记在 `features.corrected`（JSON 字段名数组），收工学习（`learnFromTask`）写入时跳过这些字段。
- 删 worktree 的同意词：`删掉` / `删掉吧` / `删`；有未提交改动的必须说 `连改动一起删掉`。判定复用 `tools.ts` 的 `consents`。
- `friday` 项目的认定：注册表里名字（不分大小写）是 `friday` 的那个。
- 主题从对话里改了，core 发一个总线事件 `{ type: "settings" }`，前端收到就重新拉设置并套用主题；别的设置不需要前端即时反应。

## Review Focus

1. **用户那句原话没取到**：工具在没有会话（`fridayToolList()` 不带 id）或这段会话还没有用户消息时被调用，`evidence.quote` 不能抛错，记成空串（Task 1 测试）。
2. **撤销时那项已经被别人改过**：对话里改了 `model`，之后用户在设置页又改了一次，再点撤销——只还原这次动过的键、还原到这次之前的值（会覆盖设置页那次，这是撤销的本义），不碰其他键（Task 1 测试）。
3. **项目登记写坏 projects.md**：值里带换行、带冒号、项目名不存在、改目录指向不存在的路径——不写坏文件结构；目录不存在就拒绝（Task 2 测试）。
4. **纠正后收工学习又改回去**：用户把功能的 `where` 纠正成 B 仓，之后一条任务收工，模型给出的 `where` 还是 A——不能覆盖（Task 4 测试）。
5. **一句「删」删错 worktree**：同一轮里没说清是哪条、或路径不在遗留列表里——不删；有未提交改动、用户只说了「删掉」——不删并要求说 `连改动一起删掉`（Task 5 测试）。

---

### Task 1: 工具骨架、原话、设置

**Files:**
- Create: `apps/core/src/agent/selfTools.ts`、`apps/core/src/agent/selfTools.test.ts`
- Modify: `apps/core/src/agent/tools.ts`（`fridayToolList` 并入 `selfToolList(conversationId)`；导出 `consents`）
- Modify: `apps/core/src/memory/audit.ts`（`Undo` 加 `restore_settings`）、`apps/core/src/api/tasks.ts`（撤销执行）、`apps/core/src/bus.ts`（`{ type: "settings" }`）、`apps/desktop/src/lib/events.ts` 与设置 / 主题的前端监听处（收到 `settings` 重拉设置并 `applyTheme`）

**Interfaces:**
- Produces:
  - `selfToolList(conversationId?: string)`：返回本计划的全部工具（后续任务往里加）
  - `saidLast(conversationId?: string): string`：这段会话最后一条 `role: "user"` 消息的文本，没有就 `""`（放 `selfTools.ts`）
  - `SETTINGS_KEYS`（上面的白名单常量）
  - 工具 `settings_get {}` → 白名单里每个键的当前值，一行一个 `键：值`
  - 工具 `settings_update { patch: Partial<Pick<SettingsUpdate, 白名单键>> }`：不在白名单的键 zod 直接拒；值的校验复用 `api/settings.ts` 的 zod 规则（抽出来共用，不另写一份）；先记下这次动到的键的旧值，`updateSettings(patch)`，记账 `settings_changed`（`why`=「你在对话里让 Friday 改设置」，`how`=`键：旧 → 新` 列表，`evidence: { quote: saidLast(conv), before, after }`，`risk: "reversible"`，`undo: { kind: "restore_settings", before }`）；改了 `theme` 就 publish `{ type: "settings" }`。返回「改好了：…（可在操作记录里撤销）」。
  - `restore_settings` 撤销：`updateSettings(before)`；有 `theme` 就 publish。

- [ ] **Step 1: 写失败测试**（`selfTools.test.ts`，工具调用沿用 `tools.test.ts` 的 `call` 写法，带会话 id 的版本先往会话里塞一条用户消息）

```ts
it("settings_update 改白名单里的键，记账带原话和撤销", async () => {
  const conv = createConversation().id;
  addMessage(conv, { role: "user", kind: "ask", content: "并发改成 5" });
  await callIn(conv, "settings_update", { patch: { autonomousConcurrency: 5 } });
  expect(userSettings().autonomousConcurrency).toBe(5);
  const e = listAudit({}).find((x) => x.action === "settings_changed")!;
  expect(e.evidence.quote).toBe("并发改成 5");
  expect(undoPlan(e.id)).toMatchObject({ kind: "restore_settings", before: { autonomousConcurrency: 3 } });
});
it("白名单外的键（hotkey）被拒", async () => {});
it("撤销只还原这次动过的键", async () => { /* 改 model → 设置页改 skills → 撤销 → model 回原值、skills 不变 */ });
it("没有会话 / 没有用户消息时原话记空串，不抛", async () => {});
it("改 theme 发 settings 事件", async () => {});
it("settings_get 列出白名单每个键", async () => {});
```

- [ ] **Step 2: 跑测试确认失败**（`pnpm exec vitest run src/agent/selfTools.test.ts`，FAIL：模块不存在）
- [ ] **Step 3: 实现**
- [ ] **Step 4: 跑测试确认通过** + `pnpm test` + `pnpm typecheck`
- [ ] **Step 5: 提交** `对话里管设置：settings_get / settings_update，白名单、记原话、可撤销；改主题前端即时生效`

---

### Task 2: 项目登记

**Files:**
- Modify: `apps/core/src/agent/selfTools.ts`、`apps/core/src/memory/projects.ts`（新增结构化改写函数）
- Test: `apps/core/src/memory/projects.test.ts`、`apps/core/src/agent/selfTools.test.ts`

**Interfaces:**
- Produces:
  - `setProjectField(markdown: string, project: string, key: ProjectFieldKey, value: string): string`（`memory/projects.ts`，纯函数）：`ProjectFieldKey = "目录" | "别名" | "说明" | "保护分支" | "方案送审" | "环境" | "频道"`。在 `## project` 段里找 `- key：` 行替换整行；没有就追加在该段最后一个 `- ` 行之后；项目段不存在就在文件末尾新建 `## project` 段（`目录` 必须同时给，否则报错）。值里的换行替换成空格；值为空串表示删掉这一行。
  - 工具 `project_update { project: string; fields: Partial<Record<ProjectFieldKey, string>>; create?: boolean }`：`project` 用 `resolveProject` 认（`create: true` 时允许不存在，新建时 `fields.目录` 必填）；`目录` 展开 `~` 后必须是存在的目录，否则拒绝；`方案送审` 只接受 `全部` / `大的` / `不用`；逐个字段 `setProjectField`，写回 `projects.md`，记账 `project_updated`（`evidence: { quote, project, fields }`，`undo: { kind: "restore_memory", snapshot: 改前的 decisions / people / projects 全文 }`）。返回改后的这一段文本。
  - 删掉 `memory_write` 对 `projects` 的整篇写入：工具描述改成「projects 用 project_update 改」，传 `file: "projects"` 时返回这句提示、不写（decisions / people 照旧）。

- [ ] **Step 1: 写失败测试**

```ts
// projects.test.ts
it("setProjectField 替换已有行、追加新行、删行、新建段", () => {
  const md = "# 项目\n\n## app\n- 目录：/r/app\n- 别名：老名\n\n## web\n- 目录：/r/web\n";
  expect(setProjectField(md, "app", "别名", "甲、乙")).toContain("## app\n- 目录：/r/app\n- 别名：甲、乙\n");
  expect(setProjectField(md, "app", "保护分支", "main, sit")).toMatch(/- 别名：老名\n- 保护分支：main, sit\n\n## web/);
  expect(setProjectField(md, "app", "别名", "")).not.toContain("别名");
  expect(setProjectField(md, "friday", "目录", "/r/friday")).toMatch(/## friday\n- 目录：\/r\/friday\n$/);
  expect(() => setProjectField(md, "friday", "别名", "x")).toThrow();
  expect(setProjectField(md, "app", "说明", "第一行\n第二行")).toContain("- 说明：第一行 第二行");
});
// selfTools.test.ts
it("project_update 改保护分支，记账可撤", async () => {});
it("目录不存在就拒绝、方案送审只认三档", async () => {});
it("memory_write projects 被引去 project_update，文件不变", async () => {});
```

- [ ] **Step 2–4**：RED → 实现 → GREEN（同上命令）
- [ ] **Step 5: 提交** `对话里改项目登记：project_update 按字段改 projects.md、可新建项目、可撤销；memory_write 不再整篇改项目`

---

### Task 3: 手册规则

**Files:**
- Modify: `apps/core/src/agent/selfTools.ts`、`apps/core/src/memory/audit.ts`（`restore_rules`）、`apps/core/src/api/tasks.ts`（执行）、`apps/core/src/api/memory.ts`（`PATCH /rules/:id` 和工具共用一个改写函数）
- Test: `apps/core/src/agent/selfTools.test.ts`

**Interfaces:**
- Consumes: `memory/rules.ts` 的 `activeRules`、`getRule`、`setRuleText`、`retireRule`、`snapshotRules(ids)`、`restoreRules`、`renderHandbook`、`writeHandbook`
- Produces:
  - `editRule(id: string, change: { text: string } | { retire: string }): Rule`（放 `memory/rules.ts`，含重渲染手册；`PATCH /rules/:id` 改调它）
  - 工具 `rules_list { project?: string }` → 每条 `id · 段落 · 文本`（`project` 不给就列 `_global` 加全部项目，按项目分组）
  - 工具 `rule_update { id, text }`（1–120 字，同接口校验）、`rule_retire { id, why }`（`why` 必填）：改前 `snapshotRules([id])`，改完记账 `rule_changed` / `rule_retired`（`evidence: { quote, before, after }`，`undo: { kind: "restore_rules", snapshot }`）
  - `restore_rules` 撤销：`restoreRules(snapshot)` 后对涉及的项目 `writeHandbook(project, renderHandbook(project))`

- [ ] **Step 1: 写失败测试**：改文字后手册文件里是新文字、撤销后回旧文字；退役不给 `why` 被拒；退役后撤销规则回到 active；`rules_list` 不给项目时分组列出。
- [ ] **Step 2–4**：RED → 实现 → GREEN
- [ ] **Step 5: 提交** `对话里改手册规则：rules_list / rule_update / rule_retire，和设置页共用一个改写函数，可撤销`

---

### Task 4: 知识库纠正

**Files:**
- Modify: `apps/core/src/memory/schema.ts` / `db.ts`（`features.corrected TEXT NOT NULL DEFAULT '[]'`）、`apps/core/src/memory/features.ts`（快照带历史、改写函数、合并、挪历史）、`apps/core/src/agent/knowledge.ts`（学习时跳过纠正过的字段）、`apps/core/src/agent/selfTools.ts`、`apps/core/src/api/tasks.ts`（`DELETE /features/:id` 改成可撤销）、`packages/shared/src/index.ts`（`Feature.corrected?: string[]`）
- Test: `apps/core/src/memory/features.test.ts`、`apps/core/src/agent/knowledge.test.ts`、`apps/core/src/agent/selfTools.test.ts`

**Interfaces:**
- Produces:
  - `FeaturesSnapshot` 增加 `history?: HistoryRow[]`；`snapshotFeatures(ids, { withHistory?: boolean })` 带上这些功能的全部历史行；`restoreFeatures` 有 `history` 时按原 id `INSERT OR REPLACE` 回去
  - `correctFeature(id: string, patch: Partial<Pick<FeatureInput, "name" | "aliases" | "where" | "paths" | "owners" | "summary">>): Feature`：改字段、把改到的字段名并进 `corrected`
  - `mergeFeatures(keepId: string, dropId: string): Feature`：`dropId` 的历史行改挂到 `keepId`，`dropId` 的名字和别名并进 `keepId` 的别名，删 `dropId`
  - `moveHistory(historyId: number, toFeatureId: string): void`
  - 工具 `knowledge_update`：`{ op: "edit"; id; patch } | { op: "merge"; keep; drop } | { op: "move"; historyId; to } | { op: "delete"; id }`（zod discriminated union）。`id` 接受功能 id 或「项目:功能名」。每种都先 `snapshotFeatures(涉及的功能 id, { withHistory: true })`，改完 `writeKnowledge(project)`，记账 `knowledge_corrected`（`evidence: { quote, op, ... }`，`undo: { kind: "restore_features", snapshot }`）。
  - `learnFromTask`：对命中的已有功能，从模型给的输入里去掉 `corrected` 里列着的字段再 `mergeFeature`
  - `DELETE /features/:id` 改用带历史的快照、记账 `feature_deleted` 时带 `undo: restore_features`（原来不可撤销）

- [ ] **Step 1: 写失败测试**

```ts
it("纠正 where 后收工学习给出旧值，不覆盖", async () => { /* correctFeature(f, { where: "B 仓" }) → learnFromTask 打桩返回 where: "A 仓" → getFeature(f).where === "B 仓" */ });
it("删功能可撤销：功能和历史都回来", () => {});
it("合并：历史挂到留下的那条，名字进别名，可撤销", () => {});
it("挪一条历史到另一个功能，可撤销", () => {});
it("knowledge_update 认「项目:功能名」", async () => {});
it("设置页的 DELETE /features/:id 也能撤销", async () => {});
```

- [ ] **Step 2–4**：RED → 实现 → GREEN
- [ ] **Step 5: 提交** `对话里纠正知识库：改字段 / 合并 / 挪历史 / 删条目，都能撤；纠正过的字段收工学习不覆盖；设置页删功能也能撤`

---

### Task 5: 遗留 worktree

**Files:**
- Modify: `apps/core/src/agent/selfTools.ts`
- Test: `apps/core/src/agent/selfTools.test.ts`

**Interfaces:**
- Consumes: `leftoverWorktrees()` 与 `removeWorktree(repoDir, path, force)`（`apps/core/src/api/worktrees.ts`；`removeWorktree` 的导入处按现有代码找）、`consents`（Task 1 已导出）、`saidLast`
- Produces:
  - 工具 `worktrees_leftover {}` → 每行 `路径 · 分支 · 有没有未提交改动 · 所属任务 #N`（没有就说「没有遗留的 worktree」）
  - 工具 `worktree_remove { path: string }`：
    1. `path` 不在 `leftoverWorktrees()` 里 → 拒绝（「这个路径不在遗留列表里，不删」）
    2. 用户最后一句（`saidLast`）不是同意 → 返回后果说明，不删：「要删 <path>（分支 <branch>）。删了撤不回。确认的话请用户单独回一句「删掉」」；有未提交改动时同意词只认 `连改动一起删掉`，说明里写「里面有没提交的改动，会一起丢。确认请回「连改动一起删掉」」
    3. 同意 → `removeWorktree(entry.repoDir, entry.path, dirty)`，记账（同接口现有口径，`evidence` 加 `quote`），返回结果
  - 定时任务的会话里硬拒（同 `close_terminals`）

- [ ] **Step 1: 写失败测试**：路径不在列表 → 不删；同一轮用户说的是「看看有哪些」→ 不删、返回说明；用户回「删掉」→ 删；有未提交改动、用户回「删掉」→ 不删并要求「连改动一起删掉」；回「连改动一起删掉」→ 删；定时会话 → 拒。`removeWorktree` 用测试仓库真实跑（参照 `api/worktrees.test.ts` 已有的准备方式），不要打桩成永远成功。
- [ ] **Step 2–4**：RED → 实现 → GREEN
- [ ] **Step 5: 提交** `对话里清遗留 worktree：先说后果、用户整句同意才删，有未提交改动要说「连改动一起删掉」`

---

### Task 6: `friday` 项目与「要动代码的」

**Files:**
- Modify: `apps/core/src/agent/brief.ts`（`briefPolicy`）、`apps/core/src/agent/runner.ts`（`autonomousPrompt`）、`apps/core/src/agent/prompt.ts`（`friday()` 的说明）、`apps/core/src/memory/projects.ts`（`isFridayProject`）
- Test: `apps/core/src/agent/brief.test.ts`、`apps/core/src/agent/runner.test.ts`、`apps/core/src/agent/prompt.test.ts`

**Interfaces:**
- Produces:
  - `isFridayProject(p: Project | string | undefined): boolean`：名字不分大小写等于 `friday`
  - `briefPolicy(p)`：`isFridayProject(p)` 时恒为 `"全部"`，不看 `方案送审`
  - `autonomousPrompt(id, task, project)`：`friday` 项目在规则末尾加一条（原样）：「这是 Friday 自己的代码。合并由用户做，你只交付分支；交付报告的「请验证」里写明「要重启 Friday（开发时重跑 pnpm dev，打包版要重新打包）才生效」。不要改守卫（agent/guard.ts）和权限分级（agent/permission.ts）去放宽限制，需要放宽的写进 decisions 里说明为什么，交给用户定。」
  - `friday()` 系统提示加一段（原样）：「用户要改的是你自己的行为时：设置、项目登记、手册规则、知识库这些能调的，用对应工具直接改（会记账、能撤）。调不了的（要改代码的新逻辑），用 task_add 在 friday 项目上建一条任务：标题写他要的行为，理解里写他的原话和你判断「配置调不了」的理由；它会走理解卡和方案评审，方案一律要他审。friday 项目没登记的话，先问他 Friday 仓库在哪个目录，用 project_update 登记（create）。」

- [ ] **Step 1: 写失败测试**：`briefPolicy` 对 `friday` 项目即使写了 `方案送审：不用` 也返回 `全部`；`autonomousPrompt("j","x","friday")` 含「合并由用户做」和「要重启 Friday」、对别的项目不含；`friday(...)` 含「在 friday 项目上建一条任务」。
- [ ] **Step 2–4**：RED → 实现 → GREEN
- [ ] **Step 5: 提交** `friday 项目：方案一律送审、交付写明要重启、不许放宽守卫；会话里改不了的行为在 friday 项目上开任务`

---

### Task 7: 文档

**Files:**
- Modify: `CLAUDE.md`（新增「对话里管自己（2026-10-22）」一节，放在「主对话（2026-10-22）」之后；改掉和新行为矛盾的旧句子：「规则…在学习弹窗的「规则…」逐条改」那段补一句对话里也能改、「逐条删（`DELETE /features/:id`，记 `feature_deleted`，不可撤销」改成可撤销、「memory_write / memory_read 整篇读写」里 projects 那部分）

- [ ] **Step 1: 写文档**：写清工具清单、白名单（含两条计划的决定和原因）、撤销种类、纠正保护、删 worktree 的两步同意、`friday` 项目规则。
- [ ] **Step 2: `pnpm test`、`pnpm typecheck`**（文档不影响，跑一遍确认基线）
- [ ] **Step 3: 提交** `文档：对话里管自己`
