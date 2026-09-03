export const DEFAULT_CORE_PORT = 7788;
export const DEFAULT_HOTKEY = "Alt+Space";

export interface HealthResponse {
  ok: true;
  version: string;
  uptimeMs: number;
}

export interface AskRequest {
  prompt: string;
}

export interface AskResponse {
  answer: string;
}

export interface NoteRequest {
  text: string;
  due?: string;
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

export interface TodayResponse {
  generatedAt: string;
  brief: string;
  todos: Todo[];
  sourceErrors: Partial<Record<TodoSource, string>>;
}

export interface Settings {
  corePort: number;
  hotkey: string;
  autostart: boolean;
}
