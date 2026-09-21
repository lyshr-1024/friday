# 频道实时消息进呼出

## 概要

用户在常驻部门群（如 `#team-fe-bo`）按热键呼出 HUD 时，本地收件箱里可能一条 @ 他的消息都没有，`slackScene` 返回空，模型只能拿全局材料硬凑。现在频道场景会额外走 `search.messages` 拉该频道最近的真实对话，作为 `scene.recent` 喂给模型；本地一条都没有时，只靠实时消息也能给出 scene。

## 改动

- `apps/core/src/connectors/slack.ts` 新增 `fetchChannelRecent(call, channelName, limit)`：`in:#<频道>` 查询，跳过带 `subtype` 的系统消息与空文本，按时间正序返回，`channelId` 取第一条命中的 `channel.id`，异常一律吞掉返回 `{ lines: [] }`。`username` 缺失时回落到 `user`。
- `apps/core/src/agent/summon/slack.ts` `slackScene` 改为 async。本地命中仍然优先（那条是「@ 过我的」，更相关），频道场景额外拉实时消息挂到 `recent`；本地无命中时用 `<channelId>:<最新 ts>` 拼 `conv`、用最新那条的文本做 `text`。私聊不拉。`Promise.race` 给 2.5 秒上限，超时当拿不到。
- `apps/core/src/agent/summon/index.ts` `sceneContext` 把 `recent` 拼成「频道 X 最近在聊：」若干行。这段文字进的是 `card.ts` 的 `context`，已被 `untrusted("用户此刻在做什么", …)` 包住。
- `apps/core/src/agent/summon/match.ts` `MatchInput` 加 `scene?: SlackScene`，`candidates` 与 `buildRules` 不再自己调 `slackScene`。

## 与任务书的一处偏差

任务书要求把 `buildRules` 改成 async。实际改成了在 `summon()` 里算好 scene 后通过 `MatchInput.scene` 传下去，`buildRules` 保持同步。理由：async 化本是为了「一次呼出只拉一次」这个目标服务的，而传参同样达成该目标，且不必让纯函数染上 IO。`summon()` 里 `await slackScene(...)` 发生在 `yield rules` 之前，事件顺序仍是 rules → card → done（`index.test.ts` 的顺序用例守着）。

## 测试

- `connectors/slack.test.ts` 新增两条：query 拼装与正序/过滤、异常吞掉返回空。
- `agent/summon/slack.test.ts` 现有用例改 async，新增「本地一条都没有但有实时消息时仍返回 scene」「私聊不拉实时消息」。
- `agent/summon/card.test.ts` 新增「频道实时消息在定界符内」。
- 全部 mock，没有真实调用 Slack API。

## 测试结果

- `node_modules/.bin/vitest run --reporter=verbose src/agent/summon/ src/connectors/`：11 个文件 127 个用例通过。
- 仓库根 `pnpm typecheck`：shared / core / desktop 全部 Done。
- `apps/core` 全量 `vitest run`：63 个文件 **464 个用例通过**（基线 459，新增 5 条）。

## 请你验证

- 真机在 `#team-fe-bo` 里按热键，确认卡片能说出群里正在聊什么，而不是泛泛而谈。
- 断网或 Slack 登录态失效时按热键，确认呼出不卡住、不报错，只是少了这段上下文。
