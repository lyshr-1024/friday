import { invoke } from "@tauri-apps/api/core";
import type { Attachment, AuditEvent, Conversation, ConversationSummary, HealthResponse, HotResponse, InboxResponse, Job, MemoryFile, MemoryFileResponse, SettingsUpdate, Task, TaskBoard, Thread, ThreadsResponse, AskRequest, NoteRequest, RunRequest, RunResponse, SettingsResponse, TodosSyncResponse, Todo } from "@friday/shared";

let baseUrlPromise: Promise<string> | undefined;

export function coreBaseUrl(): Promise<string> {
  // 浏览器里直接开 vite 页面（截图验收）时没有 Tauri，退到本机端口
  baseUrlPromise ??= "__TAURI_INTERNALS__" in window ? invoke<string>("core_base_url") : Promise.resolve(`http://127.0.0.1:${import.meta.env.VITE_FRIDAY_PORT ?? "7788"}`);
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

export async function jobs(): Promise<Job[]> {
  const res = await fetch(`${await coreBaseUrl()}/jobs`);
  if (!res.ok) throw new Error(`jobs ${res.status}`);
  return res.json();
}

export async function jobLog(id: string): Promise<{ tail: string; lines: number }> {
  const res = await fetch(`${await coreBaseUrl()}/jobs/${encodeURIComponent(id)}/log`);
  if (!res.ok) throw new Error(`log ${res.status}`);
  return res.json();
}

export async function jobFocus(id: string): Promise<void> {
  await fetch(`${await coreBaseUrl()}/jobs/${encodeURIComponent(id)}/focus`, { method: "POST" }).catch(() => {});
}

export async function uploadAttachment(file: File): Promise<Attachment> {
  const buf = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const res = await fetch(`${await coreBaseUrl()}/attachments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: file.name || `粘贴的图片.${(file.type.split("/")[1] ?? "png").replace("jpeg", "jpg")}`, mime: file.type || "application/octet-stream", data: btoa(binary) }),
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `上传失败：core 返回 ${res.status}`);
  return res.json();
}

export async function attachmentUrl(id: string): Promise<string> {
  return `${await coreBaseUrl()}/attachments/${encodeURIComponent(id)}`;
}

export async function threads(): Promise<ThreadsResponse> {
  const res = await fetch(`${await coreBaseUrl()}/threads`);
  if (!res.ok) throw new Error(`threads ${res.status}`);
  return res.json();
}

export async function threadById(id: string): Promise<Thread> {
  const res = await fetch(`${await coreBaseUrl()}/threads/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`thread ${res.status}`);
  return res.json();
}

export async function threadAction(id: string, action: "done" | "ignore" | "refresh"): Promise<Thread | null> {
  const res = await fetch(`${await coreBaseUrl()}/threads/${encodeURIComponent(id)}/${action}`, { method: "POST" });
  if (!res.ok) throw new Error(`thread ${action} ${res.status}`);
  return action === "refresh" ? res.json() : null;
}


/** 把一个线程连同 Friday 做好的功课带进会话窗开新对话。 */
export function threadPrompt(t: Thread): string {
  const b = t.brief;
  return [
    `帮我处理 ${t.userName} 在 Slack 找我的这件事（${t.kind === "dm" ? "私聊" : t.channelName}）。`,
    `原文：`,
    ...t.items.map((i) => `- ${i.text}${i.permalink ? `（${i.permalink}）` : ""}`),
    b ? `你做的功课：${b.situation}。需要我：${b.needs}。${b.context.length ? `背景：${b.context.join("；")}。` : ""}${b.reply ? `你拟的回复：${b.reply}` : ""}` : "",
    `先给判断和方案，等我确认再动手。`,
  ].filter(Boolean).join("\n");
}

export async function taskBoard(): Promise<TaskBoard> {
  const res = await fetch(`${await coreBaseUrl()}/tasks`);
  if (!res.ok) throw new Error(`tasks ${res.status}`);
  return res.json();
}

export async function createTask(input: { title: string; note?: string; url?: string; project?: string; due?: string }): Promise<Task> {
  const res = await fetch(`${await coreBaseUrl()}/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `core 返回 ${res.status}`);
  return res.json();
}

export async function taskApprove(id: string, actionId: string): Promise<Task> {
  const res = await fetch(`${await coreBaseUrl()}/tasks/${encodeURIComponent(id)}/approve/${encodeURIComponent(actionId)}`, { method: "POST" });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `core 返回 ${res.status}`);
  return res.json();
}

export async function taskReject(id: string, reason?: string): Promise<Task> {
  const res = await fetch(`${await coreBaseUrl()}/tasks/${encodeURIComponent(id)}/reject`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason }) });
  if (!res.ok) throw new Error(`reject ${res.status}`);
  return res.json();
}

export async function taskRetry(id: string): Promise<Task> {
  const res = await fetch(`${await coreBaseUrl()}/tasks/${encodeURIComponent(id)}/retry`, { method: "POST" });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `core 返回 ${res.status}`);
  return res.json();
}

export async function taskSet(id: string, action: "done" | "ignore"): Promise<Task> {
  const res = await fetch(`${await coreBaseUrl()}/tasks/${encodeURIComponent(id)}/${action}`, { method: "POST" });
  if (!res.ok) throw new Error(`${action} ${res.status}`);
  return res.json();
}

export async function audit(taskId?: string, limit = 200): Promise<AuditEvent[]> {
  const qs = new URLSearchParams({ limit: String(limit), ...(taskId ? { taskId } : {}) });
  const res = await fetch(`${await coreBaseUrl()}/audit?${qs}`);
  if (!res.ok) throw new Error(`audit ${res.status}`);
  return res.json();
}

export async function auditUndo(id: string): Promise<void> {
  const res = await fetch(`${await coreBaseUrl()}/audit/${encodeURIComponent(id)}/undo`, { method: "POST" });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `撤销失败 ${res.status}`);
}
