import { invoke } from "@tauri-apps/api/core";
import type { HealthResponse, AskRequest } from "@friday/shared";

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
