import type { Attachment } from "@friday/shared";
import { askStream, type AskEvent, type AskOptions } from "./claude.js";
import { buildUserContent } from "./content.js";
import { addMessage, setClaudeSessionId } from "../memory/conversations.js";
import { finishSession, startSession } from "../memory/sessions.js";
import { publish } from "../bus.js";

type Listener = (ev: AskEvent) => void;

interface Run {
  conversationId: string;
  answer: string;
  done: boolean;
  controller: AbortController;
  listeners: Set<Listener>;
}

// 生成任务与 HTTP 连接解耦：客户端断开只是取消订阅，任务继续跑并落库；显式 cancel 才中断。
const runs = new Map<string, Run>();

export function isRunning(conversationId: string): boolean {
  return runs.has(conversationId);
}

export function runningIds(): string[] {
  return [...runs.keys()];
}

export function partialAnswer(conversationId: string): string | undefined {
  return runs.get(conversationId)?.answer;
}

export function startRun(conversationId: string, prompt: string, opts: Omit<AskOptions, "signal">, attachmentIds: string[] = []): Run {
  const existing = runs.get(conversationId);
  if (existing) return existing;
  const run: Run = { conversationId, answer: "", done: false, controller: new AbortController(), listeners: new Set() };
  runs.set(conversationId, run);
  publish({ type: "conversation", id: conversationId, running: true });
  const { content, attached } = buildUserContent(prompt, attachmentIds);
  addMessage(conversationId, { role: "user", kind: "ask", content: prompt, ...(attached.length ? { payload: { attachments: attached satisfies Attachment[] } } : {}) });
  // 延后一拍启动，让发起请求的那次 SSE 先订阅上，避免开头几个事件被合并回放。
  setTimeout(() => void execute(run, content, opts), 0);
  return run;
}

async function execute(run: Run, prompt: Parameters<typeof askStream>[0], opts: Omit<AskOptions, "signal">): Promise<void> {
  const sessionId = startSession("ask", typeof prompt === "string" ? prompt : "(带附件)");
  let error: string | undefined;
  const emit = (ev: AskEvent) => run.listeners.forEach((l) => l(ev));
  try {
    for await (const ev of askStream(prompt, { label: "ask", ...opts, signal: run.controller.signal, conversationId: run.conversationId })) {
      if (ev.type === "delta") run.answer += ev.text;
      if (ev.type === "reset") run.answer = "";
      if (ev.type === "error") error = ev.message;
      if (ev.type === "session") setClaudeSessionId(run.conversationId, ev.sessionId);
      if (ev.type !== "done") emit(ev);
    }
  } catch (e) {
    if (!run.controller.signal.aborted) {
      error = e instanceof Error ? e.message : String(e);
      emit({ type: "error", message: error });
    }
  } finally {
    finishSession(sessionId, run.answer);
    if (run.answer) addMessage(run.conversationId, { role: "assistant", kind: "ask", content: run.answer });
    if (error) addMessage(run.conversationId, { role: "assistant", kind: "error", content: error });
    if (run.controller.signal.aborted && !run.answer) addMessage(run.conversationId, { role: "assistant", kind: "error", content: "已中断" });
    run.done = true;
    runs.delete(run.conversationId);
    publish({ type: "conversation", id: run.conversationId, running: false });
    emit({ type: "done" });
    run.listeners.clear();
  }
}

/** 订阅一个进行中的任务：先回放已生成的部分，再推后续事件。返回取消订阅函数。 */
export function subscribe(conversationId: string, listener: Listener): (() => void) | undefined {
  const run = runs.get(conversationId);
  if (!run) return undefined;
  if (run.answer) listener({ type: "delta", text: run.answer });
  run.listeners.add(listener);
  return () => run.listeners.delete(listener);
}

export function cancelRun(conversationId: string): boolean {
  const run = runs.get(conversationId);
  if (!run) return false;
  run.controller.abort();
  return true;
}
