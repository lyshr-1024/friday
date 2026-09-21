import { invoke } from "@tauri-apps/api/core";
import type { UsageRange, UsageSummary, AskRequest, Attachment, AuditEvent, Conversation, ConversationSummary, HealthResponse, HotResponse, InboxResponse, Job, MemoryFile, MemoryFileResponse, NoteRequest, RunRequest, RunResponse, SearchResult, RollbackReason, SettingsResponse, SettingsUpdate, Stage, StateTransition, Task, TaskBoard, TerminalState, Todo, TodosSyncResponse } from "@friday/shared";

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

export interface RouteResult {
  conversationId?: string;
  title?: string;
  why: string;
}

/** 自由对话的第一句：让 Friday 判断接着哪段旧会话还是新话题。 */
export async function routeAsk(prompt: string): Promise<RouteResult> {
  const res = await fetch(`${await coreBaseUrl()}/route`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt }) });
  if (!res.ok) throw new Error(`route ${res.status}`);
  return res.json();
}

export interface Activity {
  ts: string;
  kind: "say" | "tool" | "user";
  text: string;
  ok?: boolean;
}

/** 终端里 Claude Code 最近的动作（从 transcript 读）+ 此刻的终端状态 */
export async function jobActivity(id: string, limit = 6): Promise<{ items: Activity[]; terminal: TerminalState }> {
  const res = await fetch(`${await coreBaseUrl()}/jobs/${encodeURIComponent(id)}/activity?limit=${limit}`);
  if (!res.ok) throw new Error(`activity ${res.status}`);
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


export async function listHandbooks(): Promise<string[]> {
  const res = await fetch(`${await coreBaseUrl()}/handbooks`);
  if (!res.ok) return [];
  return ((await res.json()) as { files: string[] }).files;
}

export async function readHandbook(slug: string): Promise<{ name: string; path: string; content: string }> {
  const res = await fetch(`${await coreBaseUrl()}/handbooks/${encodeURIComponent(slug)}`);
  if (!res.ok) throw new Error(`读取失败：core 返回 ${res.status}`);
  return res.json();
}

export async function writeHandbook(slug: string, content: string): Promise<{ name: string; path: string; content: string }> {
  const res = await fetch(`${await coreBaseUrl()}/handbooks/${encodeURIComponent(slug)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(`保存失败：core 返回 ${res.status}`);
  return res.json();
}

export async function learnHistory(): Promise<{ taskId?: string; groups?: number; candidates?: number; skipped?: string }> {
  const res = await fetch(`${await coreBaseUrl()}/tasks/learn-history`, { method: "POST" });
  if (!res.ok) throw new Error(`core 返回 ${res.status}`);
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

/** 问一遍还标着在跑的终端窗口还在不在，手动关掉的收尾。窗口重新聚焦时调。 */
export async function jobsSweep(): Promise<string[]> {
  const res = await fetch(`${await coreBaseUrl()}/jobs/sweep`, { method: "POST" }).catch(() => null);
  if (!res?.ok) return [];
  return ((await res.json().catch(() => null)) as { closed?: string[] } | null)?.closed ?? [];
}

/** 终端窗口关了但任务没完：重开一个，接回原来那个 Claude 会话。 */
export async function jobReopen(id: string): Promise<{ status: string }> {
  const res = await fetch(`${await coreBaseUrl()}/jobs/${encodeURIComponent(id)}/reopen`, { method: "POST" });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `core 返回 ${res.status}`);
  return res.json();
}

/** 把终端窗口拉到前台。窗口已经没了的话后端会重开一个接回原会话，返回 reopened。 */
export async function jobFocus(id: string): Promise<{ focused: boolean; reopened?: string }> {
  const res = await fetch(`${await coreBaseUrl()}/jobs/${encodeURIComponent(id)}/focus`, { method: "POST" }).catch(() => null);
  if (!res?.ok) return { focused: false };
  return res.json();
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


export async function searchAll(q: string): Promise<SearchResult> {
  const res = await fetch(`${await coreBaseUrl()}/search?q=${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error(`search ${res.status}`);
  return res.json();
}

export async function taskBoard(): Promise<TaskBoard> {
  const res = await fetch(`${await coreBaseUrl()}/tasks`);
  if (!res.ok) throw new Error(`tasks ${res.status}`);
  return res.json();
}

export async function taskNode(id: string): Promise<{ canConfirm: boolean; missing: string[] }> {
  const res = await fetch(`${await coreBaseUrl()}/tasks/${encodeURIComponent(id)}/node`);
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `node ${res.status}`);
  return res.json();
}

export async function taskConfirmNode(id: string): Promise<Task> {
  const res = await fetch(`${await coreBaseUrl()}/tasks/${encodeURIComponent(id)}/node/confirm`, { method: "POST" });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `confirm ${res.status}`);
  return res.json();
}

export async function taskTransitions(id: string): Promise<StateTransition[]> {
  const res = await fetch(`${await coreBaseUrl()}/tasks/${encodeURIComponent(id)}/transitions`);
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `transitions ${res.status}`);
  return ((await res.json()) as { transitions: StateTransition[] }).transitions;
}

export async function taskTransition(id: string, to: StateTransition): Promise<Task> {
  const res = await fetch(`${await coreBaseUrl()}/tasks/${encodeURIComponent(id)}/transition`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(to),
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `transition ${res.status}`);
  return res.json();
}

export async function createTask(input: { title: string; note?: string; url?: string; project?: string; due?: string }): Promise<Task> {
  const res = await fetch(`${await coreBaseUrl()}/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `core 返回 ${res.status}`);
  return res.json();
}

export async function taskApprove(id: string, actionId: string, text?: string): Promise<Task> {
  const res = await fetch(`${await coreBaseUrl()}/tasks/${encodeURIComponent(id)}/approve/${encodeURIComponent(actionId)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(text ? { text } : {}) });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `core 返回 ${res.status}`);
  return res.json();
}

/** 立刻同步一次 Meegle 工单 */
export async function syncMeegle(): Promise<{ added: number; closed: number; reopened: number; error?: string }> {
  const res = await fetch(`${await coreBaseUrl()}/tasks/sync-meegle`, { method: "POST" });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `sync ${res.status}`);
  return res.json();
}

/** 读一条自学任务的研究笔记全文 */
export async function taskResearch(id: string): Promise<{ file: string; content: string }> {
  const res = await fetch(`${await coreBaseUrl()}/tasks/${encodeURIComponent(id)}/research`);
  if (!res.ok) throw new Error(`research ${res.status}`);
  return res.json();
}

/** 关掉一个终端。任务不动，用户可能还想接着做。 */
export async function closeJob(id: string): Promise<{ closed: boolean }> {
  const res = await fetch(`${await coreBaseUrl()}/jobs/${encodeURIComponent(id)}/close`, { method: "POST" });
  if (!res.ok) throw new Error(`关闭失败：core 返回 ${res.status}`);
  return res.json();
}

/** 批量关终端。onlyFinished 只关任务已完成或忽略的。 */
export async function closeAllJobs(onlyFinished = false): Promise<{ closed: number; scanned: number }> {
  const res = await fetch(`${await coreBaseUrl()}/jobs/close-all`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ onlyFinished }),
  });
  if (!res.ok) throw new Error(`关闭失败：core 返回 ${res.status}`);
  return res.json();
}

export async function taskPin(id: string, pinned: boolean): Promise<Task> {
  const res = await fetch(`${await coreBaseUrl()}/tasks/${encodeURIComponent(id)}/pin`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pinned }) });
  if (!res.ok) throw new Error(`pin ${res.status}`);
  return res.json();
}

export async function taskEdit(id: string, patch: { title?: string; understanding?: string }): Promise<Task> {
  const res = await fetch(`${await coreBaseUrl()}/tasks/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `core 返回 ${res.status}`);
  return res.json();
}

export async function taskDelete(id: string): Promise<void> {
  const res = await fetch(`${await coreBaseUrl()}/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `core 返回 ${res.status}`);
}

/** 把阶段拨到某一档。往回拨要说清是 Friday 推错了（misjudged，会学）还是真被打回了（bounced，不学）。 */
export async function taskStage(id: string, stage: Stage, reason?: RollbackReason, note?: string): Promise<Task> {
  const res = await fetch(`${await coreBaseUrl()}/tasks/${encodeURIComponent(id)}/stage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stage, ...(reason ? { reason } : {}), ...(note ? { note } : {}) }),
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `stage ${res.status}`);
  return res.json();
}

/** 回答卡片上那一问（「看起来提测了？」）。答什么都算一次经验 */
export async function taskStageHint(id: string, yes: boolean): Promise<Task> {
  const res = await fetch(`${await coreBaseUrl()}/tasks/${encodeURIComponent(id)}/stage-hint`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ yes }),
  });
  if (!res.ok) throw new Error(`stage-hint ${res.status}`);
  return res.json();
}

export async function taskVerify(id: string, index: number, checked: boolean): Promise<Task> {
  const res = await fetch(`${await coreBaseUrl()}/tasks/${encodeURIComponent(id)}/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ index, checked }) });
  if (!res.ok) throw new Error(`verify ${res.status}`);
  return res.json();
}


/** 二期在一期分支上接着开：设/解除基线任务。 */
/** 项目注册表里的项目，任务卡上手动归属用。 */
/** 手动建一条任务（界面上「＋ 新建」）。落成待办，不占「Friday 在做」。 */
export async function taskCreate(input: { title: string; note?: string; url?: string; project?: string; due?: string }): Promise<Task> {
  const res = await fetch(`${await coreBaseUrl()}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `core 返回 ${res.status}`);
  return res.json();
}

export async function projectList(): Promise<Array<{ name: string; dir: string }>> {
  const res = await fetch(`${await coreBaseUrl()}/projects`);
  if (!res.ok) return [];
  return res.json();
}

/** 手动把任务归到某个项目（不再按标题猜）。 */
export async function taskSetProject(id: string, project: string | null): Promise<Task> {
  const res = await fetch(`${await coreBaseUrl()}/tasks/${encodeURIComponent(id)}/project`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project }) });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `core 返回 ${res.status}`);
  return res.json();
}

/** 手填文档链接。空串表示删掉那一栏。 */
export async function taskSetDocs(id: string, docs: Record<string, string>): Promise<Task> {
  const res = await fetch(`${await coreBaseUrl()}/tasks/${encodeURIComponent(id)}/docs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(docs) });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `core 返回 ${res.status}`);
  return res.json();
}

/** 把另一条需求并进这条：二期跟一期是同一件事，板上只留一条。 */
export async function taskMerge(id: string, fromTaskId: string): Promise<Task> {
  const res = await fetch(`${await coreBaseUrl()}/tasks/${encodeURIComponent(id)}/merge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fromTaskId }) });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `core 返回 ${res.status}`);
  return res.json();
}

export async function taskSetBase(id: string, baseTaskId: string | null): Promise<Task> {
  const res = await fetch(`${await coreBaseUrl()}/tasks/${encodeURIComponent(id)}/base`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseTaskId }) });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `core 返回 ${res.status}`);
  return res.json();
}

export async function taskStart(id: string): Promise<Task> {
  const res = await fetch(`${await coreBaseUrl()}/tasks/${encodeURIComponent(id)}/start`, { method: "POST" });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `core 返回 ${res.status}`);
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

export async function taskBindConversation(id: string, conversationId: string): Promise<Task> {
  const res = await fetch(`${await coreBaseUrl()}/tasks/${encodeURIComponent(id)}/conversation`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId }) });
  if (!res.ok) throw new Error(`task conversation ${res.status}`);
  return res.json();
}

export async function attachConversation(conv: string, taskId: string): Promise<void> {
  const res = await fetch(`${await coreBaseUrl()}/slack/${encodeURIComponent(conv)}/attach`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId }) });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `core 返回 ${res.status}`);
}

export async function detachConversation(conv: string, taskId: string): Promise<void> {
  const res = await fetch(`${await coreBaseUrl()}/slack/${encodeURIComponent(conv)}/attach/${encodeURIComponent(taskId)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `core 返回 ${res.status}`);
}

export async function queryConversation(conv: string): Promise<Task> {
  const res = await fetch(`${await coreBaseUrl()}/slack/${encodeURIComponent(conv)}/query`, { method: "POST" });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `core 返回 ${res.status}`);
  return res.json();
}

export async function conversationToTask(conv: string): Promise<Task> {
  const res = await fetch(`${await coreBaseUrl()}/slack/${encodeURIComponent(conv)}/task`, { method: "POST" });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `core 返回 ${res.status}`);
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

/** 用量统计：按调用点和模型分组的 token 与折合金额 */
export async function usage(range: UsageRange): Promise<UsageSummary> {
  const res = await fetch(`${await coreBaseUrl()}/usage?range=${range}`);
  if (!res.ok) throw new Error(`usage ${res.status}`);
  return res.json();
}
