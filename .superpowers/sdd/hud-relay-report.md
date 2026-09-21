# HUD 转达终端

## 概要

HUD 输入框原来走通用 `/ask`，只带四样上下文（app 名、窗口标题、选中文字、任务标题），卡片上那段判断、Slack 频道实时消息全都没带，所以用户问「这个怎么处理」时 Friday 不知道「这个」是什么。

现在改成：HUD 里打的字优先转给这条需求自己的终端（那里有完整项目上下文和 skill），终端没开就重开接回原会话，从来没开过就按任务的项目开一个。只有确实没有任务可依托时才落回通用对话。

## 改动

### core

- `apps/core/src/api/summon.ts` 新增 `POST /summon/relay`（SSE）。入参 `{ text, taskId?, scene? }`，四条分支按顺序判：
  1. 任务的 `source.jobId` 对应的 job 还 running 且 `say` 成功 → `said`
  2. job 在但终端没了 → `reopenTerminal(jobId)`（带 `--resume` 接回原 Claude 会话）再 `say` → `opened`
  3. 没有 jobId 但任务有项目且 `resolveProject` 命中 → `startInteractiveJob` → `started`
  4. 都不成立 → `askStream` 流式，`asked`

  前三条一次性发一个 `result` 事件就结束，第四条边流边发 `delta`，收尾同样发 `result`。scene 含 Slack 原文，进提示词前过 `untrusted("当前场景", …)`。

- `apps/core/src/agent/summon/index.ts`：`sceneContext()` 提到 `buildRules` 之前算，结果填进 `rules.scene` 一并推给前端。

### shared

- `SummonRules` 加 `scene?: string`。
- 新增 `SummonRelayResult`（`kind` / `message` / `taskId?` / `jobId?`）与 `SummonRelayEvent`。

### 前端

- `apps/desktop/src/lib/core.ts` 加 `summonRelay()`，自己解 SSE（`readSse` 的返回类型写死 `AskEvent`，不复用）。
- `apps/desktop/src/views/Hud.tsx` 的 `sendAsk` 改走 `summonRelay`，带 `rules.match.taskId` 和拼好的 scene（`rules.scene` + 窗口/网址/选中文字 + 卡片判断）。`kind !== "asked"` 时把 `message` 显示在 `hud__note`，1.5 秒后收起 HUD；`asked` 照旧流式显示在 `hud__answer`。placeholder 匹配到任务时显示「让终端做点什么」。

## 测试

新增 `apps/core/src/api/relay.test.ts`，四条分支各一个用例 + 缺参 400。`say` / `reopenTerminal` / `startInteractiveJob` / `askStream` 全部 mock 掉，不真开终端。「没开过终端」那条顺带验证 scene 里伪造的 `</untrusted>` 闭合标签被剥掉。

## 测试结果

```
pnpm typecheck                              全部 Done
apps/core: vitest run                       Test Files 65 passed, Tests 492 passed
```

基线 487，新增 5 条，无回归。

## 请你验证

- Slack 窗口里按热键，卡片匹配到某条需求时，输入框 placeholder 应该是「让终端做点什么」。
- 那条需求有终端在跑时打一句话回车，应看到「已转达给终端」并在 1.5 秒后收起，Ghostty 窗口里收到这句话。
- 手动关掉那个终端窗口再打一句，应看到「终端没开，已重开并接回原会话」，新窗口里是接回来的会话而不是空的。
- 卡片没匹配到任何任务时打字，行为和原来一样，流式答案显示在 HUD 里。

我没有手动验证 UI，以上都只跑过单测和类型检查。
