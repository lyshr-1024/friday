export const DEFAULT_CORE_PORT = 7788;
export type TerminalApp = "ghostty" | "terminal";

export const DEFAULT_HOTKEY = "CmdOrCtrl+Shift+Space";

export interface HealthResponse {
  ok: true;
  version: string;
  uptimeMs: number;
}

export interface AskRequest {
  prompt: string;
  conversationId?: string;
  /** 先上传到 /attachments 拿到的 id */
  attachments?: string[];
}

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  createdAt: string;
}

export interface AskResponse {
  answer: string;
}

export interface NoteRequest {
  text: string;
  due?: string;
  conversationId?: string;
}

export interface Todo {
  id: string;
  text: string;
  source: TodoSource;
  sourceUrl?: string;
  due?: string;
  createdAt: string;
  done: boolean;
}

export type TodoSource = "local" | "slack" | "meegle";

export interface TodosSyncResponse {
  syncedAt: string;
  todos: Todo[];
  sourceErrors: Partial<Record<TodoSource, string>>;
}

export type HotSource = "hn" | "hf" | "openai" | "simonw" | "qbitai";

export interface HotItem {
  title: string;
  summary: string;
  url: string;
  source: HotSource;
  publishedAt: string;
}

export interface HotResponse {
  generatedAt: string;
  items: HotItem[];
  sourceErrors: Partial<Record<HotSource, string>>;
}

export interface Settings {
  corePort: number;
  hotkey: string;
  autostart: boolean;
}

export interface RunRequest {
  project: string;
  task?: string;
  conversationId?: string;
}

export type RunResponse =
  | { status: "launched"; project: string; dir: string; terminal: TerminalApp; task?: string; jobId?: string }
  | { status: "ambiguous"; candidates: Array<{ name: string; dir: string }> };

export const MODEL_OPTIONS = [
  { id: "", label: "跟随 Claude Code 默认" },
  { id: "claude-fable-5-1", label: "Fable 5.1" },
  { id: "claude-opus-5", label: "Opus 5" },
  { id: "claude-sonnet-5", label: "Sonnet 5" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5" },
] as const;

export type ModelId = (typeof MODEL_OPTIONS)[number]["id"];

export const THEME_OPTIONS = [
  { id: "graphite", label: "石墨", hint: "中性冷灰，默认" },
  { id: "warm", label: "暖灰", hint: "偏暖的褐灰，文字米白" },
  { id: "navy", label: "深蓝", hint: "蓝黑底，青色更融合" },
  { id: "light", label: "浅色", hint: "亮底深字，白天用" },
] as const;
export type ThemeId = (typeof THEME_OPTIONS)[number]["id"];

export interface SettingsResponse {
  terminal: TerminalApp;
  model: ModelId;
  skills: boolean;
  name: string;
  theme: ThemeId;
  learnHistory: boolean;
  summon: SummonSettings;
  dataDir: string;
  projects: string[];
}

export interface SettingsUpdate {
  terminal?: TerminalApp;
  model?: ModelId;
  skills?: boolean;
  name?: string;
  theme?: ThemeId;
  learn?: boolean;
  learnHistory?: boolean;
  summon?: Partial<SummonSettings>;
}

/** 工作台首屏：Friday 自动拉好的“现在该做什么” */
export interface Desk {
  name: string;
  greeting: string;
  advice: string;
  threads: Array<{ id: string; userName: string; situation: string; needs: string; urgency: Urgency; reply?: string }>;
  todos: Todo[];
  jobs: Job[];
  generatedAt: string;
}

export type MessageKind = "ask" | "today" | "note" | "run" | "error";

export interface Message {
  id: string;
  role: "user" | "assistant";
  kind: MessageKind;
  content: string;
  payload?: unknown;
  createdAt: string;
}

export interface Conversation {
  id: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
  /** 是否有后台生成任务在跑，以及已生成的部分 */
  running?: boolean;
  partial?: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  running?: boolean;
}

export type MemoryFile = "projects" | "decisions" | "people";

export interface MemoryFileResponse {
  name: MemoryFile;
  path: string;
  content: string;
}

export type InboxKind = "dm" | "mention";
export type Urgency = "high" | "normal" | "low";

export interface InboxItem {
  id: string;
  kind: InboxKind;
  channelId: string;
  channelName: string;
  userId: string;
  userName: string;
  text: string;
  permalink: string;
  /** slack:// 深链，有 Slack 桌面端时优先用它 */
  appLink?: string;
  /** 这条消息所在 thread 的根 ts。有值说明它是某个 thread 里的回复，前文要去 conversations.replies 取。 */
  threadTs?: string;
  /** 这条之前聊的是什么，同步时拉下来存着。老消息补不回来。 */
  prior?: string[];
  ts: string;
  receivedAt: string;
  done: boolean;
}

/** 一段对话：thread 里的回复归到根消息，散消息自己算一段 */
export function conversationKey(item: Pick<InboxItem, "channelId" | "ts" | "threadTs">): string {
  return `${item.channelId}:${item.threadTs || item.ts}`;
}

export interface InboxResponse {
  items: InboxItem[];
  lastSyncAt: string | null;
  nextSyncAt: string | null;
  lastError: string | null;
  configured: boolean;
}

export interface Notice {
  title: string;
  body: string;
}

export type JobStatus = "running" | "done" | "failed";

/** 一次「跑 Claude Code」的终端任务 */
export interface Job {
  id: string;
  project: string;
  dir: string;
  task?: string;
  conversationId?: string;
  /** Stop hook 回报的 Claude Code 会话 id，重开终端时用 --resume 接上 */
  claudeSessionId?: string;
  /** 在哪种终端里跑 */
  terminal?: TerminalApp;
  /** Ghostty 的 terminal id，开窗口时拿到；say / focus / close 靠它认窗口（标题会被 Claude Code 改掉） */
  ghosttyId?: string;
  /** 这个 job 是替哪条任务干的。开工时写死，终端连回来按它认领，不另建任务 */
  taskId?: string;
  status: JobStatus;
  exitCode?: number;
  lastMessage?: string;
  startedAt: string;
  finishedAt?: string;
}


/* ---------- 任务中枢与账本 ---------- */

export type TaskKind = "slack" | "meegle" | "verbal" | "doc" | "code" | "learn" | "handbook" | "other";
export type TaskStatus = "collected" | "understood" | "processing" | "review" | "done" | "blocked" | "ignored";
export type Risk = "read" | "reversible" | "irreversible";

/** 任务上挂的文档链接。前三个 Meegle 同步会写，meegle 那个是手贴的一篇文档，
    跟 meegleId 那条同步链路无关——贴了不会让任务被 Meegle 接管。 */
export type TaskDocs = { req?: string; tech?: string; design?: string; meegle?: string };

export interface TaskSource {
  threadId?: string;
  /** 这条任务对应的 Slack 对话键（channelId:ts） */
  conversation?: string;
  /** 这个 job 在后台跑，没有终端窗口；想看要点「打开终端看」 */
  headless?: boolean;
  /** 对话所在频道，回帖时用 */
  channelId?: string;
  /** 问问题的人 */
  userName?: string;
  /** 回在哪条 thread 下面 */
  threadTs?: string;
  meegleId?: string;
  /**
   * 合并进来的其它工单号（二期并进一期时）。同步认领工单要连它一起查，
   * 否则被合掉那条下次同步会被当成新工单重新建出来。
   */
  mergedMeegleIds?: string[];
  /**
   * 合并进来的那些需求：名字、链接、以及它自己的文档。被合掉的任务已经删了，
   * 不在这儿存一份，卡片上就只剩一串号码、文档也跟着丢了。
   */
  merged?: Array<{ meegleId: string; title: string; url?: string; docs?: TaskDocs }>;
  /** Meegle 工单类型键（story / issue / …），用来把需求和缺陷分开 */
  meegleType?: string;
  /** 这条缺陷在 Meegle 里关联的需求（_field_linked_story）。缺陷标题常常不带需求名，只有这个字段能关联上 */
  linkedStoryId?: string;
  linkedStoryName?: string;
  /** Friday 主动拉进来当容器的需求：它本来就不在分派列表里，同步时的自动收尾要跳过它 */
  storyContainer?: boolean;
  /** Meegle 空间 key，流转状态要用 */
  meegleProject?: string;
  /** Meegle 那边的当前状态 key，如 OPEN / REOPENED / IN PROGRESS */
  statusKey?: string;
  /** tags 字段的原始 label */
  meegleTags?: string[];
  /** 后台前端开发节点排期结束日 YYYY-MM-DD */
  feDue?: string;
  /** 服务端开发节点排期结束日 */
  beDue?: string;
  /** 从呼出模式建的任务 */
  summon?: boolean;
  reporter?: string;
  description?: string;
  /** 需求文档 / 技术文档 / 设计稿 / Meegle 链接，没填的键不出现。
      Meegle 任务的前三个由同步写入；口头任务四个都可以手填。
      注意 docs.meegle 只是一篇文档的链接，跟 meegleId 那条同步链路无关——
      手贴它不会让这条任务被 Meegle 接管。 */
  docs?: TaskDocs;
  /** 当前节点的 node_key，节点流转要用 */
  nodeKey?: string;
  nodeName?: string;
  url?: string;
  note?: string;
  jobId?: string;
  /** 「在会话里讨论」绑定的会话，下次继续聊而不是新开 */
  conversationId?: string;
  /** 从 Claude Code 历史学到这个时间点为止（ISO），审核通过后成为下次扫描的水位 */
  historyCursor?: string;
  /** Friday 自主派出的 -p 任务：用户只审交付报告，friday_done 直接进 review */
  autonomous?: boolean;
  /** 项目主仓目录：合并分支、收 worktree 都要在这儿操作 */
  repoDir?: string;
  /** Friday 给这条任务开的 worktree，终端就跑在里面；收工时连同分支一起清 */
  worktree?: string;
  /** 这条任务在哪个分支上干活。终端里的 Claude 起好名后用 friday_progress 回报，是关联 Meegle / Slack 的钥匙 */
  branch?: string;
  /** Friday 自学产出的研究笔记，记忆库目录下的相对路径（research/…md） */
  researchFile?: string;
  /** 从哪条任务派生出来的待办（情境卡里的 todo）。不用 threadId，免得和线程本身那条任务撞上 */
  fromTaskId?: string;
  /**
   * 在哪条任务的分支上接着开。一期还没上线、二期要在它基础上继续做时，
   * 开工不从主干拉新分支，而是检出那条任务的分支再往下走。
   */
  baseTaskId?: string;
}

/** 关联图里的一个端点：四端各自的实体 */
export type LinkKind = "task" | "meegle" | "thread" | "branch" | "url" | "project" | "slack";

/** 这条边是怎么来的。user 是你纠正过的，永远压过自动推断 */
export type LinkSource = "user" | "rule" | "guess";

export interface LinkNode {
  kind: LinkKind;
  /** meegle 是工单号，branch 是「项目名:分支名」，url 是归一化后的前缀，其余是各自的 id */
  ref: string;
}

/** 四端之间的一条关联。Friday 的核心数据。 */
export interface Link extends Record<string, unknown> {
  id: string;
  from: LinkNode;
  to: LinkNode;
  source: LinkSource;
  /** 凭什么这么连的，一句话，出错时能看出是哪条规则的锅 */
  why: string;
  createdAt: string;
  updatedAt: string;
}

/** 全局搜索（⌘F）的一条结果：任务或对话里的一条消息 */
export interface SearchHit {
  kind: "task" | "message";
  /** task 是任务 id；message 是会话 id，跳过去就是打开这段对话 */
  id: string;
  title: string;
  /** 命中处的上下文；标题本身命中时不给 */
  snippet?: string;
  /** task 才有：需求 / 缺陷 / 其他 */
  category?: TaskCategory;
  status?: string;
  project?: string;
  /** message 才有 */
  messageId?: string;
  role?: string;
  updatedAt: string;
}

export interface SearchResult {
  tasks: SearchHit[];
  messages: SearchHit[];
}

/** 待办分组：Meegle 的需求与缺陷分开看，其余归「其他」。 */
/** 进「后台档」的标签，英文是 Meegle 里的原值，中文是它在界面上的说法 */
export const BACKEND_TAGS = ["Backend Iteration", "Include Backend", "后台迭代", "后台纳入"];

export const TAG_LABELS: Record<string, string> = {
  "Backend Iteration": "后台迭代",
  "Include Backend": "后台纳入",
};

/**
 * 「自己动手改代码」的闸门类别。开工提案按它归档，
 * 和回复分开算：回复错了撤一下，开错工是在仓库里改代码。
 */
export const AUTOSTART_CATEGORY = "autostart";


export type TaskCategory = "slack" | "defect" | "story" | "other";

export const TASK_CATEGORY_LABEL: Record<TaskCategory, string> = { slack: "Slack", defect: "缺陷", story: "需求", other: "其他" };

/** Meegle 工单类型键 → 分组。列表之外的自定义类型（Project 等）都算「其他」。 */
export function taskCategory(source: TaskSource): TaskCategory {
  // Slack 来的没有 meegleType：线程本身靠 threadId 认，情境卡派生的待办靠 fromTaskId
  if (source.threadId || source.fromTaskId) return "slack";
  const t = source.meegleType;
  if (t === "story") return "story";
  if (t === "issue" || t === "defect" || t === "bug") return "defect";
  return "other";
}

/** 终端这一轮的结果，任务仍在「Friday 在做」里：review 这轮做完了等你看 / blocked 卡住需要你 */
/** question = 终端里的 Claude 弹了交互式提问，阻塞中，需要用户马上回 */
/** intake = Friday 自己有事要问用户（比如工单归哪个项目），这类任务通常还没有终端 */
export type TaskAttention = "review" | "blocked" | "question" | "intake";

/** 交付报告：功能长什么样（截图）、怎么测的（文本）、请用户验证什么 */
export interface DeliveryReport {
  summary: string;
  changes: string[];
  testSteps: string[];
  testResult: string;
  screenshots: Attachment[];
  verify: string[];
  /** 这份报告是什么时候交的（终端可能交好几轮） */
  at?: string;
  /** 用户逐项确认的勾选状态，和 verify 对齐；全部勾完 = 这轮验收通过 */
  checked?: boolean[];
  /** 查询类任务给出的、可直接发给对方的一句回复 */
  reply?: string;
}

export interface Task {
  id: string;
  title: string;
  kind: TaskKind;
  source: TaskSource;
  project?: string;
  status: TaskStatus;
  priority: Urgency;
  understanding?: string;
  plan?: string;
  progress?: string;
  report?: DeliveryReport;
  /** 等用户点头的不可逆动作 */
  pending?: PendingAction[];
  due?: string;
  /** 只在 GET /tasks 里有：这条任务终端的真实状态 */
  terminal?: TerminalState;
  /** 终端最近一轮的结果；任务是否完成由用户说 */
  attention?: TaskAttention;
  /** 用户星标关注：列表最顶上单独一组 */
  pinned?: boolean;
  /** 只在 GET /tasks 里有：这条任务牵着的 Slack 对话 */
  conversations?: SlackConversation[];
  createdAt: string;
  updatedAt: string;
}

export interface SlackConversation {
  conv: string;
  channelName: string;
  userName: string;
  items: Array<{ ts: string; text: string; permalink: string; appLink?: string }>;
  prior: string[];
  source: LinkSource;
  why: string;
}

/**
 * busy 这轮还在干（Stop hook 还没到）/ idle 说完了在等你 / gone 窗口已经关掉。
 * 外部窗口读不到输出流，忙闲靠 Stop hook 判断，所以 busy 只是「还没回报完这一轮」。
 */
export type TerminalState = "busy" | "idle" | "gone";

export type PendingActionType = "slack_reply" | "meegle_update" | "git_merge" | "start_job" | "handbook_apply" | "custom";

export interface PendingAction {
  id: string;
  type: PendingActionType;
  label: string;
  detail: string;
  payload: Record<string, unknown>;
}

export type AuditStatus = "done" | "pending" | "approved" | "rejected" | "undone" | "failed";

/** Friday 的每个动作都记一条 */
export interface AuditEvent {
  id: string;
  taskId?: string;
  ts: string;
  action: string;
  why: string;
  how: string;
  evidence: Record<string, unknown>;
  risk: Risk;
  reversible: boolean;
  status: AuditStatus;
}

/** Meegle 里能在 Friday 一键做的状态流转 */
export interface StateTransition {
  id: string;
  stateKey: string;
  label: string;
}

export interface TaskBoard {
  tasks: Task[];
  counts: Record<TaskStatus, number>;
  meegleSyncedAt: string | null;
  /** 钥匙串里有没有 Slack 登录态；false 时收件是静默不工作的 */
  slackConfigured: boolean;
}

export const TERMINAL_LABEL: Record<TerminalApp, string> = { ghostty: "Ghostty", terminal: "Terminal" };

/** 用量统计的时间档 */
export type UsageRange = "today" | "7d" | "30d";

export const USAGE_RANGE_LABEL: Record<UsageRange, string> = { today: "今天", "7d": "近 7 天", "30d": "近 30 天" };

/** 调用点的中文名。key 是 askStream 的 label，模型那一档直接显示模型 id。 */
export const USAGE_LABELS: Record<string, string> = {
  ask: "和 Friday 对话",
  attach: "挂到哪条任务",
  query: "查代码答问题",
  route: "接哪段会话",
  intake: "问工单归属",
  handbook: "从历史学手册",
  hot: "AI 热点",
  desk: "首屏建议",
};

export interface UsageEntry {
  /** 调用点 label 或模型 id */
  key: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}

export interface UsageSummary {
  range: UsageRange;
  since: string;
  total: UsageEntry;
  byLabel: UsageEntry[];
  byModel: UsageEntry[];
}

/* ---------- 呼出模式（Summon HUD） ---------- */

/** 壳在显示 HUD 之前抓的一份环境快照 */
export interface Snapshot {
  at: number;
  app: { bundleId: string; name: string; title: string };
  /** 浏览器当前 tab，AppleScript 拿的 */
  browser?: { url: string; title: string; text?: string };
  /** 选中文字，最多 8000 字 */
  selection?: string;
  /** 兜底截图的本地绝对路径，前端用 convertFileSrc 显示 */
  screenshotPath?: string;
  permissions: PermissionStatus;
}

export interface PermissionStatus {
  accessibility: boolean;
  automation: boolean;
  screen: boolean;
}

export type SummonAction =
  | { kind: "open_task"; label: string; taskId: string }
  | { kind: "approve_pending"; label: string; taskId: string; actionId: string; pendingType: PendingActionType }
  | { kind: "start_work"; label: string; project: string; prompt: string }
  | { kind: "create_task"; label: string; title: string }
  | { kind: "mark_done"; label: string; taskId: string }
  | { kind: "note"; label: string; text: string }
  | { kind: "copy"; label: string; text: string }
  | { kind: "slack_query"; label: string; conv: string }
  | { kind: "slack_task"; label: string; conv: string }
  | { kind: "slack_attach"; label: string; conv: string };

/** 规则层的产出：不调模型也能渲染的那部分 */
export interface SummonRules {
  saw: string;
  match?: { taskId: string; title: string; status: TaskStatus; why: string; strength: "sure" | "maybe" };
  actions: SummonAction[];
  /** 这次会不会调模型，前端据此决定要不要显示「正在判断」 */
  willThink: boolean;
}

/** 模型层的产出 */
export interface SummonCard {
  verdict: string;
  reply?: string;
  actions: SummonAction[];
  matchTaskId?: string;
}

export type SummonEvent =
  | { type: "rules"; rules: SummonRules }
  | { type: "card"; card: SummonCard }
  | { type: "error"; message: string }
  | { type: "done" };

export interface SummonSettings {
  /** 没有 URL / 选中文字时兜底截前台窗口 */
  screenshotFallback: boolean;
  /** 只有这些域名前缀的 URL 会被记录与使用 */
  urlAllowlist: string[];
}

export const DEFAULT_SUMMON_SETTINGS: SummonSettings = {
  screenshotFallback: true,
  urlAllowlist: ["meegle.com", "project.feishu.cn", "longbridge.sg", "longbridge-inc.com"],
};
