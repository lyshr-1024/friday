import { query } from "@anthropic-ai/claude-agent-sdk";

export type AskEvent =
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

export interface AskOptions {
  systemPrompt: string;
  cwd: string;
  signal?: AbortSignal;
}

export async function* askStream(prompt: string, opts: AskOptions): AsyncGenerator<AskEvent> {
  const abortController = new AbortController();
  opts.signal?.addEventListener("abort", () => abortController.abort(), { once: true });

  const q = query({
    prompt,
    options: {
      systemPrompt: opts.systemPrompt,
      cwd: opts.cwd,
      tools: [],
      maxTurns: 1,
      includePartialMessages: true,
      persistSession: false,
      settingSources: [],
      abortController,
      stderr: (line) => console.error(`[claude] ${line.trimEnd()}`),
    },
  });

  for await (const msg of q) {
    if (msg.type === "stream_event") {
      const ev = msg.event;
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
        yield { type: "delta", text: ev.delta.text };
      }
    } else if (msg.type === "assistant" && msg.error) {
      yield { type: "error", message: `Claude 返回错误：${msg.error}` };
    } else if (msg.type === "result") {
      if (msg.subtype !== "success") {
        yield { type: "error", message: msg.errors.join("; ") || msg.subtype };
      } else if (msg.is_error) {
        yield { type: "error", message: msg.result };
      }
      yield { type: "done" };
    }
  }
}
