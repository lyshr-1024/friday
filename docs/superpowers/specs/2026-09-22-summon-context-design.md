# 呼出模式认得出「你在哪、在看什么」

日期：2026-09-22 · 分支：`feat/project-env` · 起因：真机连着踩了四个场景

## 0. 背景

HUD 呼出时 Friday 要回答「你眼前这个东西是什么、跟你哪件事有关」。真机用下来四处踩空：

| 场景 | 现在的表现 | 根因 |
|---|---|---|
| 开着 whale-console 的调试页 | 「没有更具体的工单信息可以关联」，另起一个终端 | 候选规则只认工单链接/选中文字/Slack 三种来源，浏览器 URL 没被用来找项目（已在 `fix/url-candidate` 修） |
| 问「线上这个有问题」 | 分不清线上还是测试 | `projects.md` 的地址字段是一个扁平数组，没有环境概念 |
| 页面报错了想让 Friday 看 | 只能自己复制粘贴 | 浏览器快照只取 url/title/正文，不取控制台错误与失败请求 |
| 在 Meegle 工单页呼出 | 任务板上没有这条时只能建个普通待办，工单号丢了 | `create_task` 不认 Meegle 上下文 |

另有一个被长期忽略的事实：**用户在 `projects.md` 里写的内容有一半 Friday 读不到**。解析器只认六个字段（目录/别名/频道/地址/状态/说明），`fe-wealth-admin` 下写的「环境：…」「发布 tag 与子应用对应：…」全被丢弃——实测 `note` 只拿到 138 字，那几行一个字都没进去。用户以为写了就生效，其实没有。

## 1. 原则

- **格式由用户定，代码不写死。** 用户明确说过「每个项目都不一样」，所以环境名不能枚举成 线上/测试/SIT 白名单。
- **加项目不用改代码。** 多项目只是 `projects.md` 里多一节。
- **拿不到就降级，不猜。** 浏览器没授权、路由认不出、工单拉不到，都安静退回上一层能力，不编。

## 2. `projects.md` 的解析扩展

### 2.1 未知字段不再丢弃

`parseProjects` 现在只收白名单里的六个键。改成：不认识的 `- 键：值` 一律收进 `extra: Record<string, string>`，并在需要项目说明的地方（`intake` / `route` / `slack/query` 的提示词、`handbookBlock`）把 `extra` 一起拼进去。

这样用户写什么都能被读到，不用等代码支持。

### 2.2 环境是一等字段

```markdown
- 环境：线上 console.longbridge.xyz/、测试 console.longbridge.xyz/x/、SIT console.whalesit.xyz/x/
```

解析成 `envs: Array<{ name: string; url: string }>`：

- 一项形如 `<名字><空格><地址>`，名字是用户自己起的（线上/测试/SIT/UAT/预发…都行，**不做关键字校验**）
- 分隔符跟现有字段一致：`、` `,` `，` 或空白
- 地址过 `normalizeUrlPrefix`（去协议、去尾斜杠、转小写），与 `urls` 同一套

**匹配按前缀最长优先**，这正是用户两个项目共用域名的解法：`console.longbridge.xyz/x` 比 `console.longbridge.xyz` 长，所以 `/x/` 的页面归 whale-console，裸域名归 fe-wealth-admin。

新增 `matchEnv(url, projects): { project: Project; env?: string } | undefined`（`memory/projects.ts`），`envs` 为空时退回现有的 `urls` 匹配，保证老配置照常工作。

## 3. 三项能力

### 3.1 认出环境并带进上下文（P0）

- `candidates` 里 URL 匹配项目那条（`fix/url-candidate` 刚加的）改用 `matchEnv`，`why` 写成「你开着 whale-console 的**测试环境**」
- `SummonRules.saw` 带上环境名
- HUD 转达给终端时（`POST /summon/relay` 的 `detail`）带上「这是 X 项目的 Y 环境，页面是 Z」

### 3.2 页面报错采集（P1）

用户已同意开 Chrome 的「允许 JavaScript from Apple Events」。

`snapshot.rs` 的 `browser_tab` 现在执行一段 JS 取 `document.body.innerText`。扩展这段 JS，同时取：

- 页面上可见的报错文字（常见错误容器：`[class*="error"]`、`[role="alert"]`、`.ant-message-error` 等，取前若干条）
- `performance.getEntriesByType("resource")` 里 HTTP 状态 >= 400 的请求（URL + 状态码）

**不装全局钩子、不注入长驻脚本**——那要改用户的页面。只读当下这一刻能取到的。

控制台历史拿不到（Apple Events 执行的 JS 看不到之前的 console 记录），这是已知边界，写进说明。

快照加 `browser.errors?: string[]`，进 prompt 前照旧过 `untrusted()`（`card.ts` 的 context 统一包裹）。

### 3.3 定位代码：简化版（P1）

**不自己推断路由文件**。把 URL 路径、项目目录一起交给终端里的 Claude，它有完整代码上下文和项目 skill，找得比这边猜得准。

具体：`POST /summon/relay` 转给终端时，`detail` 里带一句「页面路径 `/x/wbo/funds/params`，项目在 `~/workspace/whale-console`，先按路由约定找到对应文件再动手」。

### 3.4 Meegle 场景（P1）

在 Meegle 工单页呼出时：

- **任务板已有这条**：现在就能对上（`meegleIdFromUrl` + `source.meegleId`），不动
- **任务板没有**：现在只能建个丢掉工单号的普通待办。改成给一个 `meegle_add` 动作，调现成的 `addMeegleByRef(link)` 按链接拉详情建任务，工单号、标题、状态、优先级都带上

`SummonAction` 加 `{ kind: "meegle_add"; label: string; url: string }`，三处同步（shared 类型、`card.ts` 的 `KINDS`、`clampAction`）。`clampAction` 里校验 `url` 必须等于当前快照的浏览器 URL，防止模型编。

## 4. 不做

- 不推断路由文件（3.3 已说明理由）
- 不装浏览器扩展、不注入长驻脚本
- 不枚举环境名做校验
- 不碰 `fe-wealth-admin` 的发布 tag 规则——那是给终端里的 Claude 看的，位置在项目手册 `handbooks/`，不该塞进注册表被截断

## 5. 验收

- `projects.md` 里写 `- 环境：…` 后，`loadProjects()` 能读出 `envs`；写任意自定义字段能读出 `extra`
- 开着 `console.longbridge.xyz/x/...` 呼出，卡片说得出「whale-console 的测试环境」，候选里有该项目在跑的任务
- 页面有报错时，快照的 `browser.errors` 非空；没授权时为空且不影响 url/title
- Meegle 工单页呼出，任务板没有这条时给出「加进任务板」动作，点了之后任务带 `source.meegleId`
- 全量测试通过，`pnpm typecheck` 干净
