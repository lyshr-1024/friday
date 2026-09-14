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
  /** Meegle 工单类型键（story / issue / …），用来把需求和缺陷分开 */
  meegleType?: string;
  url?: string;
  note?: string;
  jobId?: string;
  /** 「在会话里讨论」绑定的会话，下次继续聊而不是新开 */
  conversationId?: string;
}

/** 待办分组：Meegle 的需求与缺陷分开看，其余归「其他」。 */
export type TaskCategory = "story" | "defect" | "other";

export const TASK_CATEGORY_LABEL: Record<TaskCategory, string> = { story: "需求", defect: "缺陷", other: "其他" };

/** Meegle 工单类型键 → 分组。列表之外的自定义类型（Project 等）都算「其他」。 */
export function taskCategory(source: TaskSource): TaskCategory {
  const t = source.meegleType;
  if (t === "story") return "story";
  if (t === "issue" || t === "defect" || t === "bug") return "defect";
  return "other";
}

/** 交付报告：功能长什么样（截图）、怎么测的（文本）、请用户验证什么 */
export interface DeliveryReport {
  summary: string;
  changes: string[];
  testSteps: string[];
  testResult: string;
  screenshots: Attachment[];
  verify: string[];
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
  createdAt: string;
  updatedAt: string;
}

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
