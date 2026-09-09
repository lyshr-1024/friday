export const DEFAULT_CORE_PORT = 7788;
export type TerminalApp = "embedded" | "ghostty" | "terminal";

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
  dataDir: string;
  projects: string[];
}

export interface SettingsUpdate {
  terminal?: TerminalApp;
  model?: ModelId;
  skills?: boolean;
  name?: string;
  theme?: ThemeId;
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

export interface Triage {
  needsReply: boolean;
  urgency: Urgency;
  summary: string;
  draft?: string;
  /** 推导出的关联项目名（projects.md 里的名字），没有则缺省 */
  project?: string;
  /** 若是要动代码的事，一句可直接交给 Claude Code 的任务描述 */
  task?: string;
}

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
  ts: string;
  receivedAt: string;
  triage?: Triage;
  done: boolean;
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
  /** 在哪种终端里跑：内嵌 PTY 随 sidecar 重启就没了，外部终端 Friday 看不见 */
  terminal?: TerminalApp;
  status: JobStatus;
  exitCode?: number;
  lastMessage?: string;
  startedAt: string;
  finishedAt?: string;
}

export type ThreadStatus = "open" | "done" | "ignored";

export interface ThreadAction {
  type: "reply" | "run_claude" | "todo" | "meegle" | "none";
  label: string;
  detail?: string;
}

/** Friday 对一个线程做完功课后的情境卡 */
export interface ThreadBrief {
  situation: string;
  needs: string;
  needsReply: boolean;
  urgency: Urgency;
  reply?: string;
  actions: ThreadAction[];
  context: string[];
  todo?: { text: string; due?: string };
  person?: string;
}

export interface Thread {
  id: string;
  kind: InboxKind;
  userId: string;
  userName: string;
  channelId: string;
  channelName: string;
  project?: string;
  status: ThreadStatus;
  firstTs: string;
  lastTs: string;
  updatedAt: string;
  brief?: ThreadBrief;
  items: InboxItem[];
}

export interface ThreadsResponse {
  threads: Thread[];
  lastSyncAt: string | null;
  nextSyncAt: string | null;
  lastError: string | null;
  configured: boolean;
}

/* ---------- 任务中枢与账本 ---------- */

export type TaskKind = "slack" | "meegle" | "verbal" | "doc" | "code" | "other";
export type TaskStatus = "collected" | "understood" | "processing" | "review" | "done" | "blocked" | "ignored";
export type Risk = "read" | "reversible" | "irreversible";

export interface TaskSource {
  threadId?: string;
  meegleId?: string;
  url?: string;
  note?: string;
  jobId?: string;
  /** 「在会话里讨论」绑定的会话，下次继续聊而不是新开 */
  conversationId?: string;
  /** Friday 自主派出的 -p 任务：用户只审交付报告，friday_done 直接进 review */
  autonomous?: boolean;
}

/** 终端这一轮的结果，任务仍在「Friday 在做」里：review 这轮做完了等你看 / blocked 卡住需要你 */
/** question = 终端里的 Claude 弹了交互式提问，阻塞中，需要用户马上回 */
export type TaskAttention = "review" | "blocked" | "question";

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
  createdAt: string;
  updatedAt: string;
}

/** busy 在输出 / idle 等指示 / gone 内嵌终端已断（Friday 重启过）/ external 在 Ghostty 等外部终端里，看不到 */
export type TerminalState = "busy" | "idle" | "gone" | "external";

export type PendingActionType = "slack_reply" | "meegle_update" | "git_merge" | "custom";

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

export interface TaskBoard {
  tasks: Task[];
  counts: Record<TaskStatus, number>;
}

export const TERMINAL_LABEL: Record<TerminalApp, string> = { embedded: "内嵌终端", ghostty: "Ghostty", terminal: "Terminal" };
