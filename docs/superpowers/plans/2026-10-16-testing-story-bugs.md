# 测试阶段缺陷进需求会话 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 需求卡阶段是「测试中」时，它名下新拉到的 Meegle 缺陷由 Friday 自动交代进需求的会话，在需求分支上修完、按项目规则验完、发到测试环境，交付后把 Meegle 缺陷转「开发中」，缺陷卡进 review 等用户核验。

**Architecture:** 不新开自主任务，复用「缺陷进所属需求的会话」这条路：需求会话里的 Claude 活着就 `sayToSession` 敲进去，退出了就在同一 tmux 会话里 `runInSession` 起 `claude -p --model opus --resume <需求 session>`。缺陷卡和需求卡共用会话，靠 `friday_done` 的 `taskId` 参数把交付归到缺陷。门禁只看需求卡 `stage === "testing"`，不看 intake 把握分。

**Tech Stack:** Node + TypeScript（apps/core，vitest），React（apps/desktop），tmux，Claude Code CLI，`meegle` CLI。

**Spec:** `docs/superpowers/specs/2026-10-16-testing-story-bugs-design.md`

## Global Constraints

- 「需求在测试中」只认 Friday 需求卡 `stage === "testing"`，不从 Meegle 推断。
- Friday 不写任何验证步骤或发布步骤，提示词只说「按本项目的验证规则 / 发布流程」。
- headless 一律 `-p --model opus`（`HEADLESS_MODEL`），所有模型写别名。
- 守卫只对这条路放开 `git merge`；push 规则一行不改。
- 缺陷不挂 `git_merge` 待审；转测试由用户做，Friday 不碰。
- 不等 15 分钟稳定期、不看 intake、不占 `AUTOSTART_MAX_RUNNING`；同一需求串行。
- 提交信息中文，git author 用仓库配置，不加 `-c user.*`。所有改动在 worktree `../friday-feat-testing-story-bugs`（分支 `feat/testing-story-bugs`）里做。
- 验证命令：`pnpm --filter @friday/core test -- <文件>`、`pnpm typecheck`。

## Review Focus

1. 需求在测试中、但用户正在需求终端里和 Claude 对话时，Friday 把缺陷敲进去不应覆盖用户正在输入的内容——`sayToSession` 的排队 / 忙闲判断照旧，Task 5 的测试盯 `send-keys` 只在 `running` 状态发出。
2. `friday_done` 不带 `taskId`、会话名下有两条 handed 缺陷：必须归需求、不能随便挑一条（Task 6 测试）。
3. 缺陷被打回后立刻重交，期间需求会话已退出：重交走 headless 路，带「上一轮被打回」前缀（Task 5 测试）。
4. headless 那次 `claude -p` 退出但没调 `friday_done`：缺陷必须标 blocked，且**不能因为需求分支领先主干而挂 `git_merge`**（Task 7 测试）。
5. Meegle「In Development」流转不存在或 CLI 报错：交付仍进 review，不抛（Task 6 测试）。

---

### Task 1: 共享类型与 runs 记账

**Files:**
- Modify: `packages/shared/src/index.ts`（`TaskSource`、`Task.autostart`、`RunKind`）
- Modify: `apps/core/src/memory/runs.ts`
- Modify: `apps/core/src/agent/runLog.ts`
- Modify: `apps/desktop/src/views/Usage.tsx:7`
- Test: `apps/core/src/memory/runs.test.ts`（已有则追加）

**Interfaces:**
- Produces:
  - `TaskSource.handedAt?: string`（ISO，缺陷被交代进需求会话的时刻；有它 = 测试阶段缺陷）
  - `Task.autostart?: AutostartPlan`，`type AutostartPlan = { kind: "gate"; at: string; behind: number } | { kind: "story"; at: string; root: { id: string; title: string }; waiting?: string }`
  - `RunKind` 加 `"story_bug"`
  - `openRunForTask(taskId: string): RunRecord | undefined`（`task_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`）
  - `closeRunForTask(taskId: string, exit: RunExit, dir?: string, claudeSessionId?: string): void`（找 `openRunForTask`，有 `dir` 就带 `snapshot(dir, claudeSessionId)`，否则只写 exit）

- [ ] **Step 1: 写失败测试**（`runs.test.ts`）

```ts
it("openRunForTask 取没结束的最新一行；closeRunForTask 只收它", () => {
  createRun({ id: "r1", jobId: "j#a", taskId: "t1", project: "p", kind: "story_bug", trigger: "autostart" });
  finishRun("r1", { exit: "report" });
  createRun({ id: "r2", jobId: "j#b", taskId: "t1", project: "p", kind: "story_bug", trigger: "autostart" });
  expect(openRunForTask("t1")?.id).toBe("r2");
  closeRunForTask("t1", "blocked");
  expect(openRunForTask("t1")).toBeUndefined();
  expect(runsForTask("t1").find((r) => r.id === "r2")?.exit).toBe("blocked");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @friday/core test -- memory/runs.test.ts`
Expected: FAIL，`openRunForTask is not a function`

- [ ] **Step 3: 实现**：shared 三处类型；`runs.ts` 加 `openRunForTask`；`runLog.ts` 加 `closeRunForTask`；`Usage.tsx` 的 `RUN_KIND` 加 `story_bug: "测试阶段缺陷"`。`Task.autostart` 旧字面量改成 `{ kind: "gate", ... }` 后，`api/tasks.ts:131` 和 `autostart.ts` 的 `autostartPlan` 返回值补 `kind: "gate"`，`Board.tsx` / `TaskHeader.tsx` 现有读法（`a.at`、`a.behind`）改成先判 `kind`。

- [ ] **Step 4: 跑测试与类型检查**

Run: `pnpm --filter @friday/core test -- memory/runs.test.ts && pnpm typecheck`
Expected: PASS；typecheck 无错

- [ ] **Step 5: 提交**

```bash
git add packages/shared/src/index.ts apps/core/src/memory/runs.ts apps/core/src/agent/runLog.ts apps/desktop/src/views/Usage.tsx apps/core/src/memory/runs.test.ts apps/core/src/api/tasks.ts apps/core/src/agent/autostart.ts apps/desktop/src/views/Board.tsx apps/desktop/src/views/TaskHeader.tsx
git commit -m "测试阶段缺陷：共享类型、runs 多一种 story_bug、按任务收尾的 closeRunForTask"
```

---

### Task 2: 守卫放开 merge

**Files:**
- Modify: `apps/core/src/agent/runner.ts`（`SessionLaunch`、`buildGuardScript`、`writeHookFiles`、`writeResumeScript`）
- Test: `apps/core/src/agent/runner.test.ts`

**Interfaces:**
- Produces:
  - `SessionLaunch.allowMerge?: boolean`
  - `buildGuardScript(nodePath?: string, pushUrl?: string, allowMerge = false): string`：`allowMerge` 时嵌进脚本的 `rules` 不含 `FORBIDDEN` 里 why 为「合并由 Friday 在你审核通过后执行」那条
  - `writeHookFiles(id: string, autonomous = false, readOnly = false, allowMerge = false): ClaudeFiles`
  - `writeResumeScript(req, cwd, hooks?, keepShell?)` 把 `req.allowMerge` 传给 `writeHookFiles`

- [ ] **Step 1: 写失败测试**

```ts
it("allowMerge 的守卫不含 merge 规则，rebase / reset --hard / push 照旧在", () => {
  const s = buildGuardScript("/bin/node", "http://127.0.0.1:1/x", true);
  expect(s).not.toContain("合并由 Friday");
  expect(s).toContain("变基会改写历史");
  expect(s).toContain("会丢掉未提交的改动");
  expect(s).toContain(PUSH_WHY);
  expect(buildGuardScript("/bin/node", "http://127.0.0.1:1/x")).toContain("合并由 Friday");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @friday/core test -- agent/runner.test.ts`
Expected: FAIL（第三个参数被忽略，`not.toContain` 不成立）

- [ ] **Step 3: 实现**：`buildGuardScript` 里 `const rules = allowMerge ? FORBIDDEN.filter(([, why]) => !why.startsWith("合并由")) : FORBIDDEN`，其余三处只是透传参数。

- [ ] **Step 4: 跑测试**

Run: `pnpm --filter @friday/core test -- agent/runner.test.ts agent/guard.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/core/src/agent/runner.ts apps/core/src/agent/runner.test.ts
git commit -m "守卫：SessionLaunch.allowMerge 放开 git merge，别的规则不动"
```

---

### Task 3: 提示词 `storyBugPrompt`

**Files:**
- Modify: `apps/core/src/agent/runner.ts`（与 `autonomousPrompt` 同处）
- Test: `apps/core/src/agent/runner.test.ts`

**Interfaces:**
- Produces: `storyBugPrompt(task: Task, root: Task, project: string, rejected?: string): string`

要点（措辞自定，这些必须在）：
- 第一行写明是需求「{root.title}」提测后拉出来的缺陷，Friday 任务 id `{task.id.slice(0, 8)}`。
- 工单号 `{task.source.meegleId}`、标题、`task.understanding`、`task.source.intake?.detail` 整段过 `untrusted("task", …)`。
- 有 `rejected` 时最前面加一段「上一轮被打回：{rejected}」。
- 规矩：在当前分支上改、不另起分支、不建 MR；改完按本项目的验证规则验（项目 skill、CLAUDE.md、`handbooks/`），界面改动要真浏览器截图；验完 commit、push 当前分支，再按本项目自己的发布流程发到这条需求正在联调的测试环境（你之前发过，照原来的目标发）；全部做完调 `friday_done` 并把 `taskId` 填成上面那个 id；要用户定（方案、冲突、环境号不确定）就 `friday_blocked` 同样带 `taskId`，不要猜；交付报告写明 commit sha、推到哪条分支、发到哪个环境、验证过程和结果。
- 末尾 `handbookBlock(project)`（同 `autonomousPrompt`）和 `UNTRUSTED_NOTE`。
- **不含**任何 `git merge` / `canary` / `whale deploy` / `bo-deploy` 字样。

- [ ] **Step 1: 写失败测试**

```ts
it("storyBugPrompt：带 taskId、原文围栏、打回前缀，不写任何发布命令", () => {
  const root = { id: "root-1", title: "养牛1.2" } as Task;
  const bug = { id: "bugabcdef0", title: "列标题不一致", understanding: "x", source: { meegleId: "24780686", intake: { detail: "<fake>" } } } as Task;
  const p = storyBugPrompt(bug, root, "fe-wealth-admin", "改错页面了");
  expect(p).toContain("bugabcde");
  expect(p).toContain("养牛1.2");
  expect(p).toContain("上一轮被打回：改错页面了");
  expect(p).toContain("<untrusted");
  expect(p).not.toMatch(/git merge|canary|whale deploy|bo-deploy|harua-deploy/);
  expect(storyBugPrompt(bug, root, "fe-wealth-admin")).not.toContain("上一轮被打回");
});
```

- [ ] **Step 2: 跑测试确认失败** — Run 同 Task 2，Expected: FAIL `storyBugPrompt is not a function`

- [ ] **Step 3: 实现** `storyBugPrompt`。

- [ ] **Step 4: 跑测试** — Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/core/src/agent/runner.ts apps/core/src/agent/runner.test.ts
git commit -m "测试阶段缺陷的提示词：只讲规矩，验证和发布按项目自己的流程"
```

---

### Task 4: 门禁 `testingStoryBug`

**Files:**
- Modify: `apps/core/src/agent/autostart.ts`
- Test: `apps/core/src/agent/autostart.test.ts`

**Interfaces:**
- Consumes: `AutostartPlan`（Task 1）
- Produces:
  - `interface StoryEnv { root: (t: Task) => Task | undefined; session: (rootId: string) => TermSession | undefined; occupied: (rootId: string) => boolean }`，默认 `root = (t) => { const r = resolveRoot(t); return r.id === t.id ? undefined : r }`、`session = getTermSession`、`occupied = (id) => listTasks("processing").some((x) => x.source.rootId === id && x.source.handedAt)`
  - `testingStoryBug(t: Task, env?: StoryEnv): { root: Task } | string`，不接的原因字符串按顺序：「不在排队里」「不是缺陷」「已经有终端」「已经在{阶段}」「卡上还挂着要你回答的问题」「你说了先别做」「不挂在需求下」「需求「X」不在测试中」「需求没有会话，Friday 不知道分支在哪」「需求会话已关」「需求会话没有 worktree」「等前一条修完」
  - `eligible()` 开头多一条：`env.root?.(t)?.stage === "testing"` → 返回 `"需求在测试中，走需求会话那条路"`（`AutostartEnv` 加可选 `root`，缺省同上）
  - `runningAutonomous()` 的过滤加 `!t.source.handedAt`
  - `storyPlan(t: Task, env: StoryEnv & { enabled: boolean }): AutostartPlan | undefined`：`testingStoryBug` 通过 → `{ kind: "story", at: now, root }`；原因是「等前一条修完」→ 同上加 `waiting: "等前一条修完"`；其余 `undefined`
  - `autostartPlan` 先调 `storyPlan`，有就返回它，否则走原逻辑并补 `kind: "gate"`
  - `pickStoryBugs(tasks: Task[], env?: StoryEnv): Array<{ task: Task; root: Task }>`：通过 `testingStoryBug` 的按 `root.id` 分组，每组按优先级、再 `createdAt` 取一条
  - `autostartTick` 在原循环前：`for (const { task, root } of pickStoryBugs(listTasks("understood")))` 调 `handToStorySession(task, root)`（Task 5），返回 `"handed"` 才 `started++`，`"busy"` / `"no-session"` 打一行日志

- [ ] **Step 1: 写失败测试**（在 `autostart.test.ts` 新 `describe("testingStoryBug")`，用纯函数 env 打桩，不碰 tmux）

```ts
const story = (over: Partial<Task> = {}): Task => ({ id: "root-1", title: "养牛1.2", kind: "meegle", status: "processing", stage: "testing", priority: "normal", createdAt: settled, updatedAt: settled, source: { meegleType: "story", meegleId: "24642659" }, ...over }) as Task;
const sess = (over: Partial<TermSession> = {}): TermSession => ({ id: "root-1", project: "x", repoDir: "/r", tmuxName: "x", kind: "interactive", status: "running", worktree: "/r-wt", createdAt: settled, updatedAt: settled, ...over });
const senv = (root?: Task, s?: TermSession, occupied = false): StoryEnv => ({ root: () => root, session: () => s, occupied: () => occupied });
const fresh = defect({ createdAt: new Date(NOW).toISOString() }, { intake: { kind: "queue", why: "模糊", at: settled }, linkedStoryId: "24642659" });

it("需求在测试中、会话在：不看 intake、不等稳定期", () => expect(testingStoryBug(fresh, senv(story(), sess()))).toEqual({ root: story() }));
it("需求不在测试中 / 没会话 / 会话关了 / 没 worktree / 前一条没修完，各给原因", () => {
  expect(testingStoryBug(fresh, senv(story({ stage: "dev" }), sess()))).toBe("需求「养牛1.2」不在测试中");
  expect(testingStoryBug(fresh, senv(story(), undefined))).toBe("需求没有会话，Friday 不知道分支在哪");
  expect(testingStoryBug(fresh, senv(story(), sess({ status: "closed" })))).toBe("需求会话已关");
  expect(testingStoryBug(fresh, senv(story(), sess({ worktree: undefined })))).toBe("需求会话没有 worktree");
  expect(testingStoryBug(fresh, senv(story(), sess(), true))).toBe("等前一条修完");
});
it("不挂在需求下的缺陷不走这条路", () => expect(testingStoryBug(defect(), senv(undefined))).toBe("不挂在需求下"));
it("旧门禁对需求在测试中的缺陷让路", () => expect(eligible(defect(), { ...env, root: () => story() })).toBe("需求在测试中，走需求会话那条路"));
it("pickStoryBugs 每个需求只挑一条，高优先级先", () => {
  const a = defect({ id: "a", priority: "low" }, { linkedStoryId: "24642659" });
  const b = defect({ id: "b", priority: "high" }, { linkedStoryId: "24642659" });
  expect(pickStoryBugs([a, b], senv(story(), sess())).map((x) => x.task.id)).toEqual(["b"]);
});
it("storyPlan：通过给 kind story；等前一条给 waiting；旧路不受影响", () => {
  expect(storyPlan(fresh, { ...senv(story(), sess()), enabled: true })).toMatchObject({ kind: "story", root: { id: "root-1", title: "养牛1.2" } });
  expect(storyPlan(fresh, { ...senv(story(), sess(), true), enabled: true })).toMatchObject({ kind: "story", waiting: "等前一条修完" });
  expect(storyPlan(fresh, { ...senv(story({ stage: "dev" }), sess()), enabled: true })).toBeUndefined();
});
it("runningAutonomous 不数 handed 的缺陷", () => { /* 建一条 processing、autonomous、handedAt、jobId 指向 running job 的任务，期望 0 */ });
```

- [ ] **Step 2: 跑测试确认失败** — Run: `pnpm --filter @friday/core test -- agent/autostart.test.ts`，Expected: FAIL

- [ ] **Step 3: 实现**上面的接口。`autostartTick` 对 `handToStorySession` 的调用先写成 `import` Task 5 的函数（Task 5 未做前用一个 stub 导出，Task 5 替换）。

- [ ] **Step 4: 跑测试** — Expected: PASS（原有 `eligible` 用例全绿）

- [ ] **Step 5: 提交**

```bash
git add apps/core/src/agent/autostart.ts apps/core/src/agent/autostart.test.ts
git commit -m "门禁：需求在测试中的缺陷不看 intake、不等稳定期，同一需求串行；旧门禁让路"
```

---

### Task 5: `handToStorySession` 与接入点

**Files:**
- Modify: `apps/core/src/agent/pipeline.ts`（新函数、`rejectTask`）
- Modify: `apps/core/src/agent/taskStart.ts:36`（`handToFriday`）
- Modify: `apps/core/src/agent/autostart.ts`（替换 stub）
- Test: `apps/core/src/agent/sessions.resume.test.ts`（已有 tmux 打桩，追加 describe）

**Interfaces:**
- Consumes: `storyBugPrompt`（Task 3）、`SessionLaunch.allowMerge`（Task 2）、`openRunForTask` / `closeRunForTask`（Task 1）、`runInSession` / `sayToSession` / `claudeGone`（`sessions.ts` 现有）
- Produces: `handToStorySession(task: Task, root: Task, opts: { rejected?: string } = {}): Promise<"handed" | "busy" | "no-session">`

行为：
1. `s = getTermSession(root.id)`；`!s || s.status === "closed" || !s.worktree || !(await hasSession(s.tmuxName))` → `"no-session"`，记账 `story_session_gone`（risk read）。
2. `project = s.project`，`prompt = storyBugPrompt(task, root, project, opts.rejected)`。
3. `alive = s.status === "running" && !(await claudeGone(s))`。
   - `alive && s.kind !== "interactive"` → `"busy"`（不记账，打日志）。
   - `alive`：`sayToSession(root.id, prompt)`，结果 `"no-terminal"` → `"no-session"`；否则 `runId = `${s.jobId}#${task.id.slice(0, 8)}``，缺陷卡**不写 `jobId`**。
   - 不 alive：`id = randomUUID()`，`job = getJob(s.jobId)`，`runInSession(root.id, { id, repoDir: s.repoDir, kind: "autonomous", project, task: prompt, allowMerge: true, ...(job?.claudeSessionId ? { resumeSessionId: job.claudeSessionId } : {}) }, task.id)`，返回 false → `"no-session"`；`runId = id`，缺陷卡写 `source.jobId: id`（`onJobExit` / `taskFor` 靠它找回来）。
4. `updateTask(task.id, { status: "processing", attention: undefined, progress: `在需求「${root.title.slice(0, 24)}」的会话里修`, source: { rootId: root.id, autonomous: true, handedAt: now, repoDir: s.repoDir, worktree: s.worktree, ...(s.branch ? { branch: s.branch } : {}) } })`。
5. `createRun({ id: runId, jobId: runId 的 job 部分（headless 是 id；say 路是 s.jobId!）, taskId: task.id, project, kind: "story_bug", trigger: "autostart" })`。
6. 记账 `autostart`（why `需求「X」在测试中，缺陷直接在它的分支上修`，how `交代进需求的会话（敲进去 / 接回后台跑）`，evidence `{ rootId, meegleId, mode }`），`state.notices.push({ title: `Friday 接手了一条缺陷 · ${project}`, body: task.title.slice(0, 120), taskId: task.id })`，返回 `"handed"`。

接入：
- `rejectTask`：原逻辑后，`t.source.handedAt && t.source.rootId` → `void handToStorySession(updated, getTask(rootId)!, { rejected: reason })`。
- `handToFriday`（`taskStart.ts`）：`resolveProject` 之后、`startAutonomousJob` 之前：`const root = resolveRoot(t); if (root.id !== t.id && root.stage === "testing") { const r = await handToStorySession(t, root); return r === "handed" ? { task: getTask(t.id)! } : { error: r === "busy" ? "需求会话里的 Claude 还在跑，等它退出" : "需求会话已不在，先给需求开终端", status: 409 }; }`。
- `autostart.ts` 的 stub 换成真函数。

- [ ] **Step 1: 写失败测试**（`sessions.resume.test.ts`，复用文件顶部的 `setTmuxRunner` / `typed()` / `scriptOf` / `settingsOf` 帮助函数；需求用 `openSession(... kind)` + `worktreeReady` 建，缺陷用 `createTask({ kind: "meegle", status: "understood", stage: "todo", source: { meegleType: "issue", linkedStoryId: root.source.meegleId } })`）

```ts
describe("测试阶段缺陷交代进需求会话", () => {
  it("interactive 根活着：send-keys 敲进去，缺陷卡 processing + handedAt，不写 jobId，runs 一行 story_bug", async () => {
    // alive.add(tmuxName)；list-windows 返回 claude 窗口；claudeAlive 打桩为 true
    expect(await handToStorySession(bug, root)).toBe("handed");
    expect(typed().at(-1)).toContain("bugabcde");           // 提示词带 taskId
    expect(getTask(bug.id)).toMatchObject({ status: "processing", source: { rootId: root.id, autonomous: true, worktree: "/…wt" } });
    expect(getTask(bug.id)!.source.jobId).toBeUndefined();
    expect(openRunForTask(bug.id)).toMatchObject({ kind: "story_bug", jobId: `${rootJobId}#${bug.id.slice(0, 8)}` });
  });
  it("根已退出：同一会话里起 -p --model opus --resume，守卫在且不含 merge，缺陷卡有新 jobId", async () => {
    updateTermSession(root.id, { status: "exited" }); setJobSession(rootJobId, "sess-root");
    expect(await handToStorySession(bug, root)).toBe("handed");
    const script = scriptOf(typed().at(-1)!);
    expect(script).toMatch(/-p --model ['\\].*opus/);
    expect(script).toContain("--resume 'sess-root'");
    const guard = readFileSync(guardPathOf(script), "utf8");
    expect(guard).not.toContain("合并由 Friday");
    expect(guard).toContain("变基会改写历史");
    const jobId = getTask(bug.id)!.source.jobId!;
    expect(getJob(jobId)).toMatchObject({ sessionId: root.id, taskId: bug.id });
    expect(getTermSession(root.id)!.jobId).toBe(rootJobId);  // 会话的 jobId 不被缺陷顶掉
  });
  it("autonomous 根活着：busy，不敲字", async () => { /* kind autonomous + running + claudeAlive true → "busy"，typed() 没新增 */ });
  it("会话 closed：no-session，记 story_session_gone，缺陷卡不动", async () => { /* … */ });
  it("打回后带原因重交；根退出时走 headless 路", async () => {
    // 先 hand（alive 路），再 rejectTask(bug.id, "改错页面了")，此时把根标 exited
    // 期望 typed().at(-1) 的脚本提示词含「上一轮被打回：改错页面了」，runs 里旧行 outcome rejected、新行 open
  });
  it("autostartTick：需求在测试中就接，不看 intake；同一需求第二条等前一条", async () => {
    // settings.autonomous = true；两条 intake kind=queue 的缺陷挂同一需求（stage testing、interactive 根活着）
    // 期望 autostartTick() 返回 1，第二条 testingStoryBug 回「等前一条修完」
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — Run: `pnpm --filter @friday/core test -- agent/sessions.resume.test.ts`，Expected: FAIL

- [ ] **Step 3: 实现** `handToStorySession` 及三处接入。`claudeGone` 在测试里需要能打桩：`tmux.ts` 已有 `claudeAlive`，确认 `setTmuxRunner` 能让 `list-panes` / `claudeAlive` 返回期望值；不行就在 `sessions.ts` 加 `setClaudeAliveProbe(fn)`（仅测试用）。

- [ ] **Step 4: 跑测试** — Run 同上 + `agent/autostart.test.ts agent/pipeline.test.ts agent/taskStart.test.ts`，Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/core/src/agent/pipeline.ts apps/core/src/agent/taskStart.ts apps/core/src/agent/autostart.ts apps/core/src/agent/sessions.resume.test.ts
git commit -m "需求在测试中的缺陷自动交代进需求会话：Claude 活着就敲进去，退出了就 -p --resume 接回后台跑；打回带原因重交"
```

---

### Task 6: 交付归到缺陷 + Meegle 转开发中

**Files:**
- Modify: `apps/core/src/agent/bridge.ts`（`BRIDGE_TOOLS` schema、`callBridge`）
- Modify: `apps/core/src/agent/meegle.ts`（`applyTransition` 加 `why`、新 `transitionToInProgress`）
- Test: `apps/core/src/agent/bridge.test.ts`、`apps/core/src/agent/meegle.test.ts`

**Interfaces:**
- Consumes: `closeRunForTask`（Task 1）
- Produces:
  - `friday_done` / `friday_blocked` / `friday_progress` 的 `inputSchema.properties.taskId = str("Friday 任务 id 前 8 位；提示词里给了就填，没给不填")`
  - `targetTask(job: Job, args: Record<string, unknown>): Task`：①`args.taskId` 前缀能唯一匹配一条 `source.rootId === job.sessionId` 的任务 → 它；②没给 id：`listTasks("processing").filter((t) => t.source.rootId === job.sessionId && t.source.handedAt)` 恰好一条 → 它；③`taskFor(job)`
  - `applyTransition(t, to, connector?, why = `你在 Friday 里点了「${to.label}」`)`
  - `transitionToInProgress(t: Task, connector?: MeegleConnector): Promise<{ moved: true; label: string } | { moved: false; why: string }>`：`listTaskTransitions` 找 `stateKey === "IN PROGRESS"`，没有 → `{ moved: false, why: `当前 ${t.source.status ?? t.source.statusKey ?? "未知"}，没有「开始处理」可走` }`；有 → `applyTransition(t, to, connector, "Friday 在需求分支上修完并发到测试环境")`，抛错 → `{ moved: false, why: e.message }` 并记账 `meegle_transition` `status: "failed"`
  - `callBridge` 的 `friday_done` 对 `task.source.handedAt` 的任务：`status: "review"`、`report`、`progress: "修完了，等你核验"`、`closeRunForTask(task.id, "report", task.source.worktree, job.claudeSessionId)`、**不挂 `git_merge`**、`onSignal(... "terminal_delivered", to: "dev")`、`const m = await transitionToInProgress(t)`、`notify(t, job, "修完了，等你核验", `${report.summary}${m.moved ? "" : `\nMeegle 状态没动：${m.why}`}`, "finished", false)`、`postDelivery`，返回 `已交付，Meegle ${m.moved ? "已转开发中" : "没转：" + m.why}。交付完就结束。`
  - `friday_blocked` 对 handed 任务：`status: "blocked"`、`closeRunForTask(task.id, "blocked")`、不碰 Meegle
  - `friday_progress` 对 handed 任务：不写 `source.branch`

- [ ] **Step 1: 写失败测试**（`bridge.test.ts`，Meegle 用 `vi.mock("./meegle.js")` 或给 `transitionToInProgress` 注入假连接器；需求 job 用 `createJob({ id: "job-root", sessionId: "root-1", taskId: "root-1", … })`）

```ts
it("带 taskId 的 friday_done 归到缺陷：review、不挂 git_merge、Meegle 转 IN PROGRESS", …);   // 断言 getTask(bug).status review、pending 为空、假连接器收到 transitionState(…, "1122151")、getTask(root).report 仍 undefined
it("不带 taskId、会话名下恰好一条 handed 缺陷：也归缺陷", …);
it("不带 taskId、两条 handed 缺陷：归需求，缺陷不动", …);
it("没有 IN PROGRESS 流转：交付仍 review，通知带「Meegle 状态没动」", …);
it("流转 CLI 报错：交付仍 review，账本 meegle_transition failed", …);
it("friday_blocked 带 taskId：缺陷 blocked，Meegle 没被调", …);
```

`meegle.test.ts` 加一条：`applyTransition` 不传 `why` 时账本仍是「你在 Friday 里点了」。

- [ ] **Step 2: 跑测试确认失败** — Run: `pnpm --filter @friday/core test -- agent/bridge.test.ts agent/meegle.test.ts`

- [ ] **Step 3: 实现**。

- [ ] **Step 4: 跑测试** — Expected: PASS（原有 `tools/list` 断言的工具顺序不变）

- [ ] **Step 5: 提交**

```bash
git add apps/core/src/agent/bridge.ts apps/core/src/agent/meegle.ts apps/core/src/agent/bridge.test.ts apps/core/src/agent/meegle.test.ts
git commit -m "需求会话里的 friday_done 按 taskId 归到缺陷：进 review 不挂合并，Meegle 缺陷转开发中"
```

---

### Task 7: 没交付的缺陷收尾 + 结局记账

**Files:**
- Modify: `apps/core/src/agent/pipeline.ts`（`onJobExit`、`finishTask` / `settleRun`、新 `settleHandedBugs`）
- Modify: `apps/core/src/agent/terminal.ts`（`closeJobTerminal`）
- Test: `apps/core/src/agent/pipeline.test.ts`、`apps/core/src/agent/terminal.test.ts`

**Interfaces:**
- Produces:
  - `settleHandedBugs(rootId: string, why: string): number`：`listTasks("processing")` 里 `source.rootId === rootId && source.handedAt && !source.jobId` 的（say 路、没有自己的 job）→ `status: "blocked"`、`progress: why`、`closeRunForTask(id, "no_report")`、通知一次；返回条数
  - `onJobExit`：
    - job 的任务是 handed 缺陷（headless 路）且没有 `report`：`status: "blocked"`、`progress: "需求会话退出了，这条没交付"`、`closeRun(jobId, exitCode === -1 ? "window_closed" : "no_report")`，**不进 `git_merge` 那段**（`handedAt` 直接跳过 `addPending`）
    - job 的任务是需求（`!autonomous && !headless` 那个早退分支之前）：`settleHandedBugs(job.task.id, "需求会话退出了，这条没交付")`
  - `closeJobTerminal`：杀会话后 `settleHandedBugs(s.id, why)`（`finishTask` → `closeTaskTerminal` → 这里，手动关也经这里）
  - `settleRun`：`t.source.handedAt` → 直接 `setRunOutcome(r.id, status === "ignored" ? "abandoned" : "merged_as_is", "在需求分支上交付，由测试环境验收")`；`finishTask` 里 `r.kind === "autonomous"` 的条件改成 `r.kind === "autonomous" || r.kind === "story_bug"`

- [ ] **Step 1: 写失败测试**

```ts
it("headless 缺陷退出没交付：blocked、runs no_report、不挂 git_merge（需求分支领先主干也不挂）", …);
it("需求的交互式 Claude 退出：say 路的 handed 缺陷标 blocked", …);
it("需求收工 / 手动关会话：handed 缺陷标 blocked", …);
it("用户标完成：story_bug 的 run 记 merged_as_is；忽略记 abandoned", …);
```

- [ ] **Step 2: 跑测试确认失败** — Run: `pnpm --filter @friday/core test -- agent/pipeline.test.ts agent/terminal.test.ts`

- [ ] **Step 3: 实现**。

- [ ] **Step 4: 跑全部 core 测试** — Run: `pnpm --filter @friday/core test`，Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add apps/core/src/agent/pipeline.ts apps/core/src/agent/terminal.ts apps/core/src/agent/pipeline.test.ts apps/core/src/agent/terminal.test.ts
git commit -m "没交付就没了的测试阶段缺陷三处收尾；收工时结局记在需求分支上交付"
```

---

### Task 8: 界面

**Files:**
- Modify: `apps/desktop/src/views/Board.tsx`（`anchorLine`、`FridayTop`、`panel` 判定）
- Modify: `apps/desktop/src/views/TaskHeader.tsx`（`stateLabel`）

**Interfaces:**
- Consumes: `AutostartPlan`（Task 1）、`source.handedAt`

改动：
- `anchorLine`：`t.autostart?.kind === "story"` → `跟着需求「${root.title.slice(0, 16)}」修 · ${waiting ?? "等它会话空闲"}`；`t.source.handedAt && t.status === "processing"` → `在需求「…」的会话里修`（需求标题从 `all` 里按 `rootId` 找，找不到退回现有「在需求的会话里改」）；`kind === "gate"` 保持原文案。
- `stateLabel`：`kind === "story"` → `排队中 · 跟着需求修`。
- `FridayTop`：`kind === "story"` → 「什么时候开」写 `需求在测试中，Friday 直接在它的分支上修，不走把握分${waiting ? `。${waiting}` : ""}`，不渲染 intake 的「为什么 / 项目 / 打算」。
- `panel`：`autonomous || Boolean(t.autostart) || Boolean(t.source.handedAt)`。
- review 态的 handed 缺陷：待审区本来就只有 `pending` 驱动，没有 `git_merge` 自然不出现；确认「标记完成」「打回」在「···」里。

- [ ] **Step 1: 改代码**（无单测；类型检查把 `kind` 判断的遗漏揪出来）

- [ ] **Step 2: 类型检查** — Run: `pnpm typecheck`，Expected: 无错

- [ ] **Step 3: 浏览器里看一眼**：按 CLAUDE.md「验收方式」起 core（`FRIDAY_PORT=7791 FRIDAY_DATA_DIR=<临时目录> FRIDAY_NO_SCHEDULER=1`）+ vite，用一次性脚本塞一条 `stage: testing` 的需求、一条 `term_sessions` 行、两条缺陷，核对列表灰字「跟着需求「…」修 · 等它会话空闲」和第二条「等前一条修完」，agent-browser 截图。没法起环境就写明「没有手动验证 UI」。

- [ ] **Step 4: 提交**

```bash
git add apps/desktop/src/views/Board.tsx apps/desktop/src/views/TaskHeader.tsx
git commit -m "任务卡：测试阶段缺陷的排队文案和面板"
```

---

### Task 9: 真机验收与 CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`（「Friday 自己开自主任务」一节后加「需求在测试中：缺陷进需求会话」小节，按 spec 的要点写，不超过 12 行）
- Create（一次性，放 scratchpad，不入库）：假 claude 脚本 + 塞库脚本

- [ ] **Step 1: 真机验收**（按「定时任务」那次的方式）：`FRIDAY_NO_SCHEDULER=1 FRIDAY_TMUX_SOCKET=friday-verify FRIDAY_CLAUDE_BIN=<假脚本> FRIDAY_DATA_DIR=<临时目录>` 起 core；塞一条需求（`stage: testing`）、用 `POST /tasks/:id/start`（interactive）让准备段建 worktree；把需求会话标 `exited`；塞一条挂它名下的缺陷；一次性脚本只调 `autostartTick()`。假脚本收到 `-p … --resume` 后 `curl` 调 `/mcp/<jobId>` 的 `friday_done` 带 `taskId`，再退出。核对：缺陷卡 `review`、`pending` 空、需求卡 `report` 为空、账本有 `autostart` 和 `meegle_transition`（连接器换成把调用写进文件的假 `meegle` 可执行文件，`MeegleConnector` 构造参数 `bin`）、`runs` 一行 `story_bug` `exit: report`。前后各看一次 `lsof -nP 2>/dev/null | grep -c /dev/ptmx`。

- [ ] **Step 2: 写 CLAUDE.md 小节**，把验收结果里和设计不一样的地方一并写进去。

- [ ] **Step 3: 提交**

```bash
git add CLAUDE.md
git commit -m "CLAUDE.md：需求在测试中时缺陷进需求会话的规矩"
```
