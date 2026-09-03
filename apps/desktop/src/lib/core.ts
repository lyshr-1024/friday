import { invoke } from "@tauri-apps/api/core";
import type { HealthResponse, AskRequest, NoteRequest, RunRequest, RunResponse, SettingsResponse, TodayResponse, Todo } from "@friday/shared";

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
  | { type: "done" }
  | { type: "error"; message: string };

export async function* ask(body: AskRequest, signal: AbortSignal): AsyncGenerator<AskEvent> {
  const res = await fetch(`${await coreBaseUrl()}/ask`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    yield { type: "error", message: `core 返回 ${res.status}` };
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

export async function today(signal: AbortSignal): Promise<TodayResponse> {
  const res = await fetch(`${await coreBaseUrl()}/today`, { signal });
  if (!res.ok) throw new Error(`简报失败：core 返回 ${res.status}`);
  return res.json();
}

export function isTodayCommand(input: string): boolean {
  return input === "" || /^(\/today|今天|今日)$/.test(input);
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
