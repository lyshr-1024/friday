# 呼出上下文四项 · 交付报告

分支 `feat/project-env`，四次提交，对应设计文档 `docs/superpowers/specs/2026-09-22-summon-context-design.md` 的 §2 / §3.1 / §3.2 / §3.4 + §3.3。

## 概要

| 提交 | 内容 |
|---|---|
| `105c577` | P0：`projects.md` 解析扩展（`extra` + `envs` + `matchEnv`） |
| `5facd8b` | P1-a + P1-d：认出环境带进上下文，转终端时带页面路径 |
| `5fd802b` | P1-b：页面报错与失败请求进快照 |
| `d7f2c0a` | P1-c：Meegle 工单页「加进任务板」 |

测试 **517 通过**（基线 493，新增 24），`pnpm typecheck` 干净，`cargo check` 退出 0、零 error。

## P0：`projects.md` 解析扩展

做了什么：

- 字段正则从六个白名单键改成通用 `- 键：值`，不认识的进 `extra: Record<string, string>`；同名键多行累加。键名里的 `*` 先剥掉（用户实际写的是 `- **强调键**：值`）。
- 新增 `envs: ProjectEnv[]` 与 `parseEnvs`，`matchEnv(url, projects)` 按 URL 前缀最长匹配，`envs` 为空时退回现有 `urls`，老配置行为不变。
- 新增 `projectDetail(p)`，把说明 + 环境 + `extra` 一起给出去，接到 `intake` 的项目注册表和 `bridge` 的终端上下文。

怎么验证的：`apps/core/src/memory/projects.test.ts` 13 个用例，包含真实数据——`console.longbridge.xyz/x/` 归 whale-console、裸域名归 fe-wealth-admin、`/xyz/` 不被 `/x` 前缀吃掉。

**偏离设计的一处**：设计假设用户写的是干净的 `<名字> <地址>` 对，真实 `projects.md` 里 fe-wealth-admin 的那行是整句话（「线上和测试都在 console.longbridge.xyz，SIT 是 console.whalesit.xyz」）。按「不猜比猜错强」，`parseEnvs` 只认地址前面紧挨着的那个词，虚词（是/在/于）再往前找一个，认不出的安静丢掉。这行真实数据解析出的名字是「线上和测试都」和「SIT」——后者对，前者是用户那句话本身就没给出单一环境名，代码不替他编。

`route` 的项目注册表**没有**接 `projectDetail`：它只用名字和别名做二选一，且是每轮都跑的 Haiku 调用，塞进整段说明只会涨 token。

## P1-a / P1-d：认出环境并带进上下文

- `candidates` 的 URL 匹配项改用 `matchEnv`，理由文案变成「你开着 whale-console 的测试环境」。
- `describe` 多收一个 `projects` 参数，`SummonRules.saw` 带上「whale-console 测试环境」。
- `POST /summon/relay` 新增 `pageHint(url, dir)`：说清哪个环境、哪个页面路径、项目在哪，末尾一句「先按路由约定找到对应文件再动手」。**不自己推断路由文件**（设计 §3.3）。
- 前端 `Hud.tsx` 的 relay body 多带一个 `url`，服务端才能算这个提示。
- 已经有终端在跑时也带上（原来只有新开终端才带），否则跑着的那个终端不知道你说的「这个页面」是哪个。

怎么验证的：`match.test.ts` 新增「认出环境」「pagePath」两组，`api/summon.test.ts` 三个 `pageHint` 用例。

## P1-b：页面报错采集

- `snapshot.rs` 新增 `PAGE_JS`：正文 + `[role=alert]` / `[class*=error]` 里的可见文字 + `performance.getEntriesByType("resource")` 里状态码 >= 400 的请求，用 `---ERRORS---` 分隔，Rust 侧解析进 `browser.errors: Vec<String>`（每条截 300 字，最多 10 条）。
- 不装全局钩子、不注入长驻脚本；JS 仍包在 `try` 里，报错或没授权时 url/title 不受影响。
- `Snapshot.browser.errors?: string[]`（shared），`card.ts` 的 context 加一段，走已有的 `untrusted()`。
- `trimUrl` 重建 `browser` 时天然丢掉 `errors`，补了两个用例守着——报错文字里常带完整接口地址和 token。
- `summon()` 的项目域名白名单从只读 `p.urls` 改成 `urls + envs`，否则只写了「环境」的项目会掉出白名单。

**真机踩到并修掉的坑**：JS 里写 `'\n'` 会被 AppleScript 先解释成真换行，把 JS 字符串字面量截断，整段返回 `missing value`——现象是正文突然全空，极像权限没给。改成 `String.fromCharCode(10)`。这个坑已写进代码注释。

怎么验证的：
- 对真实 Chrome 跑了 Rust 生成的完整 AppleScript：url / title / 正文都正常返回，`---ERRORS---` 段存在。
- 往页面注入一个 `role=alert` 元素，再抓一次，报错文字被采集到（「接口请求失败，请稍后重试」），随后清理掉注入的元素。
- `responseStatus` 在真实页面上 250 条 resource 全部有值，说明 `>= 400` 这个判据成立；但这台机器上造不出真实的 4xx（dev server 对未知路径回 200，外网被挡），所以状态码分支是用桩数据在真实浏览器里验的，输出 `404 …` / `500 …` 两条、200 那条被正确过滤。**这一条没有真机端到端证据，只有分支逻辑证据。**
- `card.test.ts` 两个用例确认报错进了 prompt 且在定界符内。

## P1-c：Meegle 工单页

- `SummonAction` 加 `{ kind: "meegle_add"; label; url }`，三处同步：shared 类型、`card.ts` 的 `KINDS`、`clampAction` 的 switch。
- `clampAction` 校验 `url` 必须等于当前快照的浏览器 URL（`AllowedIds.browserUrl`），模型编一个工单号就会去拉别人的工单建任务。
- `defaultActions` 里规则层也给这个动作：开着工单页而 `candidates` 一条都没对上时，用「加进任务板」替掉原来那个会丢工单号的「建成任务」。
- `POST /summon/act` 加 case，调现成的 `addMeegleByRef(link)`；已存在时返回「任务板上已经有这条了」。
- 前端不用改：`runAction` 的 default 分支本来就 POST 到 `/summon/act`；`meegle_add` 是可逆动作，照 `create_task` 的先例保持键盘可达。

怎么验证的：`card.test.ts` 三个用例（放行 / 编的 url 钳掉 / 没开浏览器不成立），`match.test.ts` 三个用例（工单页给 / 非工单页不给 / 对上任务就不给）。

## 顾虑

1. **`cargo check` 需要绕开环境问题才跑得起来**。这台机器的 Command Line Tools 装坏了——`/Library/Developer/CommandLineTools/usr/bin/xcrun` 根本不存在，`cc` 因此链接失败，`libc` / `serde` / `proc-macro2` 这些我没碰的 crate 的 build script 全挂。在**改动前的干净树上同样 9 个 error**，所以不是这次改的。绕法是 `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer cargo check`，退出 0。另外 Tauri 的 build script 要求 `resources/core` 存在（新 worktree 里没有），临时 `mkdir` 过、验完已删。**建议跑一次 `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer` 或重装 CLT**，否则 `pnpm tauri build` 也会挂。

2. **老消息拿不到 `errors`**，只有这次改动之后新抓的快照才有。

3. **`parseEnvs` 对整句话的解析是尽力而为**。真实那行解析出的「线上和测试都」不是个像样的环境名，会原样出现在「你开着 X 的线上和测试都环境」里。真要准，得用户把那行改成 `- 环境：线上 console.longbridge.xyz/、SIT console.whalesit.xyz/`。代码这边不做关键字校验是设计明确要求的，所以没加兜底。

4. **状态码那条分支缺真机端到端证据**，见上文 P1-b。真机上开一个确实在报 4xx 的页面呼出一次就能补上。
