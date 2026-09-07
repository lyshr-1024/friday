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

export interface SettingsResponse {
  terminal: TerminalApp;
  model: ModelId;
  skills: boolean;
  dataDir: string;
  projects: string[];
}

export interface SettingsUpdate {
  terminal?: TerminalApp;
  model?: ModelId;
  skills?: boolean;
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
  status: JobStatus;
  exitCode?: number;
  lastMessage?: string;
  startedAt: string;
  finishedAt?: string;
}
