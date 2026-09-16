# 呼出模式（Summon HUD）设计

日期：2026-09-16 · 分支：`feat/summon` · 状态：待用户审阅

## 0. 背景与定位

用户装了 Friday 但没有用它接管工作：每天还是先开 Slack / Meegle / 终端，Friday 只是「另一个要去看的地方」。对齐后的结论：

- **Friday 不替代 Slack / Meegle / 邮件**。用户照旧在那些 app 里看和回。
- Friday 是贴在这些 app 之上的一层，负责三件那些 app 做不了的事：**记全局**（这条消息对应哪件事、做到哪、今天还有什么）、**干重活**（改代码、起草回复、查上下文）、**随叫随到**（在哪个 app 里按热键就在哪出现）。
- Friday **一直看着**用户的活动（结构化信号，不看屏幕、不过模型），但**只在按热键时开口**。不主动弹话，不自动开工——先攒数据。
- 工作台退成「看 Friday 干的活」（交付报告、待验收、账本），不再是收件箱。这属于后续子项目。

三个子项目的顺序：① 呼出模式（本 spec）→ ②「今天」日程与收工 → ③ 工作台减法。

## 1. 用户可见行为

`⌘⇧Space` 呼出一张 HUD 小卡，出现在屏幕顶部居中，**不抢当前 app 的前台**。卡片三段：

1. **我看到了 …**：一行，可展开核对（前台 app、URL、选中文字原文、截图缩略）。这是给用户核对 Friday 读对没读对的地方。
2. **对上哪件事 + 下一步**：任务名、状态点、为什么对上；1–3 个动作按钮，第一个是主按钮。没对上 → 「建成任务」。
3. **输入框**：判断不对直接说、或追问，接同一条任务会话。

Esc / 点外面 / 再按热键 → 收起。工作台改由托盘、Dock、HUD 内「打开工作台 ⌘↵」进入。

### 1.1 目标场景

| 你在哪 | Friday 拿到 | 卡片 |
|---|---|---|
| Ghostty，`pnpm test` 红了一屏 | cwd → 项目；zsh hook 报的最近命令与退出码 | 对上该项目 processing 任务 →「开工（带报错）」「只告诉我改哪」 |
| Ghostty，什么都没出错 | cwd → 项目 | 输入框直接交代事，落到该项目 |
| Chrome 看 Meegle 工单 | URL 里的工单 id → `meegle workitem get` | 精确对上任务 →「开工」「记一句备注」。零模型调用 |
| Chrome 看飞书文档 / 文章 | URL + 标题（+ 选中段落） | 「和 xx 项目有关」→「记一条决策」；无关就一句话 |
| Slack 看一条消息 | 窗口标题里的频道 / 人 → 库里已同步的线程 | 对上线程任务 →「看一眼再发」「看进展」 |
| 其他 app | 选中文字；没有就前台窗口截图 | 「我只看到了这段文字 / 截图」+ 判断 |

## 2. 架构

```
壳（Rust）                 core（Node）                    前端（HUD WebView）
热键 ─► 抓快照 ─► 显示 HUD ─► take_pending_summon ─► POST /summon ─► 卡片
NSWorkspace 切换 ────────► POST /activity
浏览器 URL（AppleScript）─► POST /activity
zsh precmd hook ─────────► POST /activity
Slack / Meegle 连接器 ───► activity 表（core 内部）
```

- **壳**：快照抓取、HUD 窗口、活动事件上报、权限查询。不含业务判断。
- **core**：`activity` 表；`/summon` 的规则匹配 + 模型卡片；动作全部映射到现有接口。
- **前端**：`views/Hud.tsx`，入口 `index.html?view=hud`。

### 2.1 里程碑

- **M1**：快照 + HUD + `/summon` 匹配与卡片 + 动作 + 权限设置。独立可用、可合并。
- **M2**：`activity` 四个来源 + 状态回流 + 轨迹注入 `/summon`。

## 3. 壳：热键 → 快照 → HUD

**顺序不可反**：热键按下 → 先抓快照 → 再显示 HUD。HUD 出现后前台就是 Friday 了。

### 3.1 快照 `Snapshot`

```ts
type Snapshot = {
  at: number;
  app: { bundleId: string; name: string; title: string };
  browser?: { url: string; title: string };   // Safari / Chrome / Arc / Edge，AppleScript 问当前 tab
  selection?: string;                          // AX AXFocusedUIElement.AXSelectedText，最多 8000 字
  screenshotId?: string;                       // 兜底截图，attachments 表 id
  permissions: { accessibility: boolean; automation: boolean; screen: boolean };
};
```

- 终端 app 快照只带 app 名；cwd / 命令由 zsh hook 已报上来的最近一条提供（M2）。M1 里没有 hook 时终端场景只有 app 名。
- Slack 只拿窗口标题（含频道或人名）；消息内容由 core 按频道回查已同步的线程。**只能对到已同步过的消息**。
- 选中文字拿不到就不硬来，**不模拟 ⌘C**（污染剪贴板）。
- 截图**仅当**没有 URL、没有选中文字、且不是终端 app 时才拍：`screencapture -x -l <windowId>` 前台窗口 PNG → 记忆库 `attachments/`。

### 3.2 HUD 窗口

- label `hud`，应用启动时**预建并隐藏**，热键只 `show`（避免 WebView 冷启动几百毫秒）。
- `tauri-nspanel`（GitHub git 依赖，`v2` 分支）转成非激活 `NSPanel`：不抢焦点、不改 activation policy。**兜底**：nspanel 两小时内跑不通就用 NSWindow + `orderFrontRegardless`，收起时 `activate` 回上一个 app；功能不受影响（快照已抓完），只是 HUD 打字时用户的 app 会短暂失去前台。
- 屏幕顶部居中，宽 560，高随内容 8 步缓动；`HudWindow` 毛玻璃材质。
- HUD 开着时再按热键 = 收起，不重抓。
- 壳 → 前端：`take_pending_summon` 命令取快照（同 `PendingChat` 套路，emit 会丢）。
- 新增 Tauri 命令：`take_pending_summon`、`hide_hud`、`permission_status`、`open_permission_pane(kind)`。
- `capabilities` 新增 `hud` 窗口，加 clipboard 插件（`copy` 动作用）。

### 3.3 热键分配

`⌘⇧Space` → HUD（`toggle_hud`）。托盘左键 / Dock / Reopen / 单实例再启动 → 工作台。

## 4. core：活动轨迹（M2）

### 4.1 表 `activity`

```sql
CREATE TABLE activity (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,        -- app_focus | browse | shell | slack_sent | meegle_moved | summon
  app TEXT, title TEXT, url TEXT,
  cwd TEXT, branch TEXT, cmd TEXT, exit INTEGER,
  ref TEXT                   -- 关联对象：threadId / meegleId / taskId
);
CREATE INDEX activity_ts ON activity(ts);
```

保留 14 天，启动与每天清一次。只存本机结构化文本，不过模型。

### 4.2 来源

| 来源 | 谁报 | 时机 | 备注 |
|---|---|---|---|
| `app_focus` | 壳，NSWorkspace `didActivateApplicationNotification` | 每次切 app，防抖 1s | app、窗口标题 |
| `browse` | 壳，切到浏览器时 + 浏览器仍在前台时每 15s 问一次 | URL 变了才记 | **URL 白名单**（见 4.4） |
| `shell` | `scripts/friday-shell-hook.zsh`，用户自己 source | 每条命令结束（precmd） | `curl --max-time 0.3 POST /activity`，core 没起静默失败；**只记命令第一段**（`pnpm test`、`git push`），不记参数 |
| `slack_sent` / `meegle_moved` | core 已有连接器与同步 | 现有轮询节奏 | 用户在 Slack 的发言、Meegle 状态变化 |
| `summon` | core `/summon` | 每次呼出 | 对上的任务、用户点了什么（留痕，本轮不学习） |

接口 `POST /activity`（壳与 hook 用）、`GET /activity?minutes=`（调试）。

### 4.3 状态回流（纯规则）

- `slack_sent` 落在某线程 → 该任务挂着的 `slack_reply` 待审动作作废，进展加一行「你在 Slack 里回了」，记 lesson `done_without_reply`。**消息状态以 Slack 为准。**
- `meegle_moved` 到完成态 → 走现有 `meegle_done`。
- `shell` cwd 命中项目且项目有 processing 任务 → 任务标「今天在此目录活动过」（`task.progress` 不动，存 `source.activeAt`），供匹配加权。

### 4.4 边界

- 不装键鼠监听、不读剪贴板、不定时截屏（截屏只在热键那一刻）。
- 浏览器 URL 只记域名在白名单里的（默认：Meegle、飞书、GitLab、公司域；`settings.summon.urlAllowlist` 可编辑），其余只记 `browse` 不记 url。
- `recentActivity(minutes)` 把轨迹压成十几行文本注入 prompt：「14:02 起在 Ghostty ~/work/whale-console 跑了 pnpm test 失败两次 → 14:20 切到 Slack #wealth-fe → …」。

## 5. core：`POST /summon`

### 5.1 输入补全

快照 + core 自补：cwd → 项目（`projects.md` 目录前缀）；Meegle URL → `meegle workitem get`；Slack 频道 + 人 → 库里线程与消息；这些对象已关联的任务（`contextFor`）；最近 2 小时轨迹（M2）。

### 5.2 规则匹配 `agent/summon/match.ts`（纯函数）

输出候选 `{ taskId, why, strength: "sure" | "maybe" }[]`：

- cwd 前缀命中项目 → 该项目 processing / understood 任务（`maybe`；M2 里今天活动过的加权）
- URL 含 Meegle 工单 id → `source.meegleId` 相同的任务（`sure`）
- Slack 频道 + 人 → 线程 → `findTaskBySource`（`sure`）
- 选中文字里出现工单 id（`sure`）或任务标题主干词（`maybe`）

### 5.3 模型 `agent/summon/card.ts`（Sonnet，label `summon`）

**只在有需要读懂的文本时调用**：选中文字、Slack 消息、页面标题。只有 cwd / URL 而无文字 → 不调模型，卡片全由规则生成。

输入：快照摘要、候选任务卡片、轨迹、项目手册片段；外部文本一律 `untrusted()`。

输出 JSON：

```ts
type SummonCard = {
  saw: string;                         // 一句「我看到了…」
  match: { taskId: string | null; why: string };
  verdict: string;                     // 判断
  actions: SummonAction[];             // ≤3，封闭枚举
  reply?: string;                      // Slack 场景的回复草稿
};
type SummonAction =
  | { kind: "open_task"; taskId: string }
  | { kind: "approve_pending"; taskId: string; actionId: string }
  | { kind: "start_work"; project: string; prompt: string }
  | { kind: "create_task"; title: string }
  | { kind: "mark_done"; taskId: string }
  | { kind: "note"; text: string }
  | { kind: "copy"; text: string };
```

解析层对越界动作、缺字段一律钳掉（同 `brief`）。

### 5.4 默认动作（规则，不靠模型）

任务有待审动作 → 「看一眼再发 / 通过并执行」；processing 有终端 → 「看进展」，输入框直通 `terminal_say`；understood → 「开工」；没对上 → 「建成任务」。

### 5.5 时序

HUD 出现即由快照渲染「我看到了」（不等 core）；规则命中与默认动作几十毫秒到；模型部分流式补 `verdict` / `reply`。目标：有用内容 300ms 内，模型结论 3s 内。响应形态：SSE，先 `rules` 事件再 `card` 增量。

### 5.6 输入框

走现有 `/ask`，会话绑到对上的任务（无则 `openTaskConversation`）；系统提示新增「【当前环境】」块 = 快照 + 轨迹，与「【当前任务】」并列。没对上任务 → 走 `/route`。

## 6. 动作执行与前端

### 6.1 动作 → 现有接口

| 动作 | 接口 | 分级 |
|---|---|---|
| `open_task` | `friday:focus-task` 事件 / `open_chat` 带 taskId | 只读 |
| `approve_pending` | HUD 内展开 `.fx__confirm` → `POST /tasks/:id/approve/:actionId` | 不可逆，确认 |
| `start_work` | `POST /run`，prompt 带选中文字 / 报错 / URL | 可逆（worktree） |
| `create_task` | `addNoteTask`，`source` 记 url / channel / cwd | 可逆 |
| `mark_done` | `POST /tasks/:id/done` | 可逆 |
| `note` | `memory_write` 同款 | 可逆 |
| `copy` | Tauri clipboard | 只读 |

成功：一行绿点确认后 1.5s 自动收起；失败留在原地报错。全部记账，可撤的挂 `undo`。

### 6.2 `views/Hud.tsx`

- 复用工作台 token 与 `Icon`；深色固定；`--live` 只给「正在判断」光环。
- 结构：`.hud__saw`（可展开：截图缩略 / 选中原文 / URL）→ `.hud__match`（任务名 + 状态点 + 为什么）→ `.hud__verdict`（流式）→ `.hud__actions`（≤3，主按钮回车）→ `Thread` compact。
- 键盘：`↑↓` 动作间移动、`⌘1-3` 直选、回车主动作（输入框有内容时回车 = 发送）、Esc 收起、`⌘↵` 打开工作台。
- 宽 560 固定，高随内容 8 步缓动。

### 6.3 权限与设置

- 设置页权限区补三行：辅助功能 / 自动化 / 屏幕录制，状态点 + 「去授权」（打开对应系统设置面板）。壳 `permission_status`：`AXIsProcessTrusted`、`CGPreflightScreenCaptureAccess`，自动化只能试调一次看结果。
- 未授权一律降级，HUD「我看到了」写明「没拿到选中文字（未授权）」。
- `settings.summon`：`screenshotFallback`（默认开）、`urlAllowlist`、`shellHook`（显示安装那一行命令 + 是否已收到过 shell 事件）。
- 设置页热键说明同步改为 HUD。

## 7. 测试与验收

### 7.1 自动化（core，vitest）

- `match.test.ts`：四类命中；多候选 sure / maybe；空返回。
- `card.test.ts`：越界动作钳掉、缺字段钳空、`untrusted()` 包裹；无文字路径零模型调用。
- `activity.test.ts`：14 天清理；`slack_sent` 作废草稿并记 lesson；shell 只存命令第一段；非白名单 URL 不记地址。
- `api/summon.test.ts`、`api/activity.test.ts`：接口形状。
- 壳 Rust 部分手动验。

### 7.2 真机验收（每条截图，写进交付报告）

1. Ghostty `pnpm test` 挂掉 → 热键 → 300ms 内「我看到了 Ghostty · whale-console」→ 对上 processing 任务 → 「开工」→ 任务 processing、内嵌终端含报错原文。
2. Chrome 看 Meegle 工单 → 精确对上 → 用量面板不涨 → 「开工」。
3. Slack 看已同步消息 → 对上线程任务 → 「看一眼再发」发出。
4. Finder 选中文字 → 拿到；不选 → 截图；「我看到了」展开能看原图。
5. 全部未授权 → HUD 仍出并写明缺什么。
6. （M2）Slack 里自己回一条 → 草稿作废、进展加行；zsh hook 的 cwd 出现在轨迹里。
7. HUD 开着时菜单栏 app 名不变（用户 app 仍是前台）。

## 8. 不做

主动开口；自动开工；键鼠监听、剪贴板读取；非白名单 URL；学习闭环（只留痕）；「今天」日程与收工；工作台减法。

## 9. 风险

- `tauri-nspanel` 与 Tauri 2 版本兼容：兜底见 3.2，限时两小时。
- Electron 类 app（Slack）的 Accessibility 选中文字经常拿不到：Slack 场景主要靠频道 + 连接器，选中文字算加分项。
- AppleScript 问 URL 首次弹自动化授权，用户拒绝要安静降级。
- 终端场景在 M1 没有 hook 时只有 app 名，卡片会干；M2 补齐。
