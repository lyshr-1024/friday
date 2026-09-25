# OKR 周报：Friday 起草、你审、Friday 提交

日期：2026-09-25 · 分支：`feat/okr-weekly` · 起因：周报改到 OKR 平台上填，「问 Friday」答「做不了」

## 0. 背景

- OKR 平台的周报 = 每周给每个 KR 提一份 progress report（markdown 正文 + 0–100 进度）。2026Q3 名下 4 个 O、13 个 KR；上周（`2026W0914-0920`）13 份是 09-21 经 MCP 提交的，正文一段话，列本周交付并带 `m-xxxx` 工单号。
- Friday 答「做不了」是因为 `/ask` 开着 `strictMcpConfig`（09-22 为省钱加的，okr 一家 33 个工具），okr MCP 进不来。本功能**不改** `strictMcpConfig`。

## 1. 已定的需求

| 决策 | 选择 |
|---|---|
| 触发 | 每周自动起草 + 随时手动触发；草稿挂成审核任务，你点了才提交 |
| 素材 | 本周 git 提交（两个邮箱域）+ Friday 本周的任务；不读 Claude Code 历史 |
| 进度 | Friday 建议，沿用上周为基线，有证据才上调，**不自动下调**，每条附依据 |
| 没素材的 KR | 默认不交，审核卡单列，勾上可手写补交 |
| 访问 OKR | core 直接调 OKR 的 HTTP MCP（JSON-RPC），凭证运行时从 `~/.claude.json` 读 |

## 2. 组件与数据流

```
connectors/okr.ts        OKR 平台客户端（零模型）
agent/weekly/week.ts     周标识、目标周、weeklyDue
agent/weekly/collect.ts  收素材（零模型）
agent/weekly/draft.ts    起草（一次 Sonnet）+ 解析钳制
agent/weekly/index.ts    draftWeeklyOnce：串起来、建 / 更新任务、通知
```

### 2.1 OKR 客户端 `connectors/okr.ts`

- 每次调用读 `~/.claude.json` 的 `mcpServers.okr`（`url` + `headers`），不缓存、不另存。你在 Claude Code 里换 token，Friday 自动跟上。
- 走 MCP streamable HTTP：`initialize` → `tools/call`。只用到 `get_current_user`、`list_user_okr_hierarchy`、`list_progress_reports`、`create_progress_report`、`delete_progress_report`。
- 失败统一抛 `OkrError`，消息说人话（「~/.claude.json 里没有 mcpServers.okr」「OKR 平台拒绝了 token」「create_progress_report 失败：…」）。
- 对外只暴露：`me()`、`myKRs(quarter?)`（只要 `label === "KR"` 且 owner 是自己的，带父 O 名称）、`reportsOf(week, quarter)`、`submit({objectId, week, quarter, content, pct})` → report id、`remove(reportId)`。

### 2.2 周的口径 `agent/weekly/week.ts`

- 周一到周日，标识 `2026W0921-0927`（年取周一所在年；跨年周如 `2026W1228-0103` 仍按周一的年）。
- 季度读 `myKRs` 返回的 `quarter`（平台当前活跃季度），不自己算。
- `targetWeek(now)`：周五 16:00 至周日 → 本周；周一至周五 16:00 前 → 上周。
- `weeklyDue(now, state)`：目标周既没有 Friday 的卡、平台上也没有自己这周任何一份报告 → 该起草。

### 2.3 收素材 `agent/weekly/collect.ts`

- **git**：`~/workspace/*` 与 `~/workspace/*/*` 下的仓库，`git log --all --since=<周一 00:00> --until=<下周一 00:00> --author='haoran\.jing@longbridge\(\.sg\|-inc\.com\)'`，按 hash 去重（worktree 会重复）。每条：仓库名、日期、subject。
- **Friday 任务**：`updated_at` 落在本周、状态不是 `ignored` 的；取标题、项目、Meegle 号、阶段、状态、交付报告概要（截 200 字）。`kind` 为 `okr_weekly` / `handbook` 的排除。
- 每条素材编号（`g1`…、`t1`…），模型只回编号，不回原文。

### 2.4 起草 `agent/weekly/draft.ts`

- 一次 Sonnet 调用（`label: "okr_weekly"`，`oneShot`，不挂工具）。输入：KR 列表（id、父 O、名称、上周正文、上周进度）+ 素材，**全部过 `untrusted()`**。
- 提示词要点：正文风格对齐上周（一段话、列交付、带工单号）；只写素材里有的，不编；进度默认沿用上周，有明确证据才上调并说明；对不上的素材放 `unmatched`。
- 输出 JSON：`{ items: [{objectId, content, pct, why, used: string[]}], unmatched: string[] }`。
- 解析层钳制：
  - `objectId` 不在自己 KR 列表里 → 丢掉
  - `pct` < 上周 → 改回上周；> 100 → 100；没有上周值时 0–100 原样
  - `used` 里不存在的编号 → 剔除；剔完为空的条目 → 视为没素材（进「本周没找到」）
  - 解析失败重试一次，仍失败抛错
- 素材为 0 条时不调模型。

### 2.5 建任务 `agent/weekly/index.ts`

- `draftWeeklyOnce({week?, manual})`：一周一张卡（`kind: "okr_weekly"`，`source.okrWeek`）。
  - 这周的卡已存在且未提交 → 覆盖草稿（不另建）
  - 这周已经提交过（卡 done）→ 手动触发才重来，自动跳过
- 任务 `status: review`，挂一个待审动作 `okr_submit`，payload：

```ts
interface OkrWeeklyDraft {
  week: string; quarter: string;
  rows: Array<{
    objectId: number; kr: string; objective: string;
    content: string; pct: number; prevPct: number | null; why: string;
    used: Array<{ id: string; text: string }>;   // 素材原文，给卡片核对用
    checked: boolean;
    state: "draft" | "empty" | "existing" | "submitted" | "failed";
    reportId?: number; error?: string;
  }>;
  unmatched: Array<{ id: string; text: string }>;
}
```

- `existing`：平台上这周该 KR 已有报告 → 显示平台内容、不勾、**绝不覆盖**。
- 建好发通知 `OKR 周报草稿好了 · 2026W0921-0927`（带 taskId，点开定位）。

## 3. 审核卡与提交

### 3.1 卡片（`Focus` 里 `kind === "okr_weekly"` 专用一块 `OkrWeekly.tsx`）

- 头：`OKR 周报 · <week>`，一句「起草了 N 条，M 条没找到素材」。
- 按 O 分组，每个 KR 一行：勾选、KR 名（截断，hover 全称）、正文 textarea、进度 number input + 灰字「上周 90 · 依据：…」、折叠「用到的素材」。
- 「本周没找到相关工作」：`empty` 行默认不勾，勾上展开空 textarea 手写。
- 「没对上任何 KR 的工作」：只列，不做拖拽归并（YAGNI）。
- 编辑即存：`PUT /tasks/:id/okr-draft` 写回 `okr_submit` 的 payload（沿用 `updatePending`），关了再开不丢。

### 3.2 提交

- 主按钮「提交 N 条到 OKR…」，上方后果预览：「以你的身份提交到 OKR 平台 `<week>`，共 N 条；可以在操作记录里撤销（会删掉这几条）」。
- `executePending` 的 `okr_submit` 分支：只提交 `checked && state ∈ {draft, empty, failed}` 且正文非空的行；逐条 `submit`，成功写 `submitted + reportId`，失败写 `failed + error`，互不影响。
- 全成功 → 再 `reportsOf(week)` 核对一遍 → 任务 done。有失败 → 动作放回待审，按钮变「重试剩下的 K 条」，已成功的不重交。
- 记账：每次提交一条 `okr_submit`（evidence：week、各条 objectId → reportId），`undo: { kind: "delete_okr_reports", ids }`，撤销走 `remove`。

## 4. 定时与入口

- 调度器每 30 分钟看一次 `weeklyDue`，开关 `settings.okrWeekly`（默认开）。「跑过」记在 `sync_state` 的 `okr:drafted:<week>`，重启不丢。
- 会话工具 `okr_weekly`（可带 week），系统提示补一句：「填周报」走这个工具，建卡后让用户去审，不要说做不了。
- `POST /tasks/okr-weekly`（body 可带 `week`）；设置页「OKR 周报」分组：开关 + 「现在起草一份」。

## 5. 出错

| 情况 | 表现 |
|---|---|
| 读不到 okr 配置 / token 失效 | 仍建卡，`blocked`，进展写原因 |
| 模型输出解析两次失败 | `blocked`，附原始输出前 300 字 |
| 素材 0 条 | 不调模型，卡上「这周没找到你的 commit 和任务」，全部行进「本周没找到」 |
| 部分提交失败 | 见 3.2 |

## 6. 测试

- 单测：`week.ts`（跨月 / 跨年 / 周五 16:00 前后 / 周一补上周）、`weeklyDue`、`draft.ts` 钳制、`collect.ts` 去重与过滤、`okr.ts`（mock fetch：配置缺失、401、tools/call 报错）、`okr_submit`（部分失败重试不重交、`existing` 不覆盖、撤销删除）。
- 真机：只到起草，看草稿质量；提交由用户点。审核卡用临时数据在浏览器走 golden path + 部分失败。

## 7. 不做

- 不读 Claude Code 历史；不做素材拖拽归并；不改 `strictMcpConfig`；不写 O 级别报告（平台不允许）；不自动下调进度；不覆盖平台上已有的报告。
