import { invoke } from "@tauri-apps/api/core";
import type { Conversation, ConversationSummary, HealthResponse, HotResponse, InboxResponse, MemoryFile, MemoryFileResponse, SettingsUpdate, AskRequest, NoteRequest, RunRequest, RunResponse, SettingsResponse, TodosSyncResponse, Todo } from "@friday/shared";

let baseUrlPromise: Promise<string> | undefined;

export function coreBaseUrl(): Promise<string> {
  baseUrlPromise ??= invoke<string>("core_base_url");
  return baseUrlPromise;
}

export async function health(): Promise<HealthResponse> {
  const res = await fetch(`${await coreBaseUrl()}/health`);
  if (!res.ok) throw new Error(`health ${res.status}`);
  return res.json();
}

export type AskEvent =
  | { type: "delta"; text: string }
  | { type: "reset" }
  | { type: "session"; sessionId: string }
  | { type: "done" }
  | { type: "error"; message: string };

async function* readSse(res: Response): AsyncGenerator<AskEvent> {
  if (!res.ok || !res.body) {
    const err = ((await res.json().catch(() => null)) as { error?: string } | null)?.error;
    yield { type: "error", message: err ?? `core 返回 ${res.status}` };
    yield { type: "done" };
    return;
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("\n");
      if (data) yield JSON.parse(data) as AskEvent;
    }
  }
}

/** 发起一轮生成并订阅进度。signal 只取消订阅，不中断生成；中断用 cancelAsk。 */
export async function* ask(body: AskRequest, signal: AbortSignal): AsyncGenerator<AskEvent> {
  const res = await fetch(`${await coreBaseUrl()}/ask`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal,
  });
  yield* readSse(res);
}

/** 重新订阅某个会话进行中的生成（切回会话时用），会先回放已生成的部分。 */
export async function* askSubscribe(conversationId: string, signal: AbortSignal): AsyncGenerator<AskEvent> {
  const res = await fetch(`${await coreBaseUrl()}/ask/stream?conversationId=${encodeURIComponent(conversationId)}`, { signal });
  yield* readSse(res);
}

export async function cancelAsk(conversationId: string): Promise<void> {
  await fetch(`${await coreBaseUrl()}/ask/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationId }),
  }).catch(() => {});
}

export async function note(body: NoteRequest): Promise<Todo> {
  const res = await fetch(`${await coreBaseUrl()}/note`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`记录失败：core 返回 ${res.status}`);
  return res.json();
}

const NOTE_PREFIX = /^(?:\/note|记)\s+/;

export function parseNote(input: string): string | null {
  const m = NOTE_PREFIX.exec(input);
  return m ? input.slice(m[0].length).trim() || null : null;
}

export async function syncTodos(signal: AbortSignal): Promise<TodosSyncResponse> {
  const res = await fetch(`${await coreBaseUrl()}/todos?sync=1`, { signal });
  if (!res.ok) throw new Error(`同步待办失败：core 返回 ${res.status}`);
  return res.json();
}

export async function hot(signal: AbortSignal, refresh = false): Promise<HotResponse> {
  const res = await fetch(`${await coreBaseUrl()}/hot${refresh ? "?refresh=1" : ""}`, { signal });
  if (!res.ok) throw new Error(`热点获取失败：core 返回 ${res.status}`);
  return res.json();
}

export function commandOf(input: string): "hot" | "todos" | "inbox" | null {
  if (/^(\/hot|热点)$/.test(input)) return "hot";
  if (/^(\/todos|待办)$/.test(input)) return "todos";
  if (/^(\/inbox|\/slack|slack|收件|消息)$/i.test(input)) return "inbox";
  return null;
}

export async function run(body: RunRequest): Promise<RunResponse> {
  const res = await fetch(`${await coreBaseUrl()}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `core 返回 ${res.status}`);
  return res.json();
}

export async function settings(): Promise<SettingsResponse> {
  const res = await fetch(`${await coreBaseUrl()}/settings`);
  if (!res.ok) throw new Error(`settings ${res.status}`);
  return res.json();
}

const RUN_PREFIX = /^(?:\/run|跑)\s+/;

export function parseRun(input: string): RunRequest | null {
  const m = RUN_PREFIX.exec(input);
  if (!m) return null;
  const rest = input.slice(m[0].length).trim();
  if (!rest) return null;
  const [project, ...task] = rest.split(/\s+/);
  return { project: project!, ...(task.length ? { task: task.join(" ") } : {}) };
}

export async function conversation(): Promise<Conversation> {
  const res = await fetch(`${await coreBaseUrl()}/conversation`);
  if (!res.ok) throw new Error(`conversation ${res.status}`);
  return res.json();
}

export async function newConversation(): Promise<Conversation> {
  const res = await fetch(`${await coreBaseUrl()}/conversation/new`, { method: "POST" });
  if (!res.ok) throw new Error(`conversation ${res.status}`);
  return res.json();
}

export async function openTodos(): Promise<Todo[]> {
  const res = await fetch(`${await coreBaseUrl()}/todos`);
  if (!res.ok) throw new Error(`todos ${res.status}`);
  return res.json();
}

export async function conversations(): Promise<ConversationSummary[]> {
  const res = await fetch(`${await coreBaseUrl()}/conversations`);
  if (!res.ok) throw new Error(`conversations ${res.status}`);
  return res.json();
}

export async function conversationById(id: string): Promise<Conversation> {
  const res = await fetch(`${await coreBaseUrl()}/conversation/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`conversation ${res.status}`);
  return res.json();
}


export async function readMemory(name: MemoryFile): Promise<MemoryFileResponse> {
  const res = await fetch(`${await coreBaseUrl()}/memory/${name}`);
  if (!res.ok) throw new Error(`读取失败：core 返回 ${res.status}`);
  return res.json();
}

export async function writeMemory(name: MemoryFile, content: string): Promise<MemoryFileResponse> {
  const res = await fetch(`${await coreBaseUrl()}/memory/${name}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(`保存失败：core 返回 ${res.status}`);
  return res.json();
}

export async function updateSettings(patch: SettingsUpdate): Promise<SettingsResponse> {
  const res = await fetch(`${await coreBaseUrl()}/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`保存设置失败：core 返回 ${res.status}`);
  return res.json();
}

export async function inbox(sync = false, signal?: AbortSignal): Promise<InboxResponse> {
  const res = await fetch(`${await coreBaseUrl()}/inbox${sync ? "/sync" : ""}`, { method: sync ? "POST" : "GET", ...(signal ? { signal } : {}) });
  if (!res.ok) throw new Error(`收件箱获取失败：core 返回 ${res.status}`);
  return res.json();
}

export async function inboxDone(id: string): Promise<void> {
  const res = await fetch(`${await coreBaseUrl()}/inbox/${encodeURIComponent(id)}/done`, { method: "POST" });
  if (!res.ok) throw new Error(`标记失败：core 返回 ${res.status}`);
}

export async function inboxHandle(id: string, project?: string): Promise<RunResponse> {
  const res = await fetch(`${await coreBaseUrl()}/inbox/${encodeURIComponent(id)}/handle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(project ? { project } : {}),
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `core 返回 ${res.status}`);
  return res.json();
}

export async function deleteConversation(id: string): Promise<void> {
  const res = await fetch(`${await coreBaseUrl()}/conversation/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`删除失败：core 返回 ${res.status}`);
}

export async function renameConversation(id: string, title: string): Promise<void> {
  const res = await fetch(`${await coreBaseUrl()}/conversation/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error(`重命名失败：core 返回 ${res.status}`);
}

export async function testNotification(): Promise<void> {
  await fetch(`${await coreBaseUrl()}/notifications/test`, { method: "POST" });
}
