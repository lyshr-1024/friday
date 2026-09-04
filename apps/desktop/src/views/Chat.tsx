import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ConversationSummary, Message, TodayResponse } from "@friday/shared";
import { ask, conversationById, conversations, latestToday, newConversation, today } from "../lib/core";
import { AssistantBody, TodoList, fmtTime } from "./shared";

interface OpenPayload {
  conversationId?: string | null;
  initialPrompt?: string | null;
}

let localId = 0;
const local = (m: Omit<Message, "id" | "createdAt">): Message => ({ ...m, id: `local-${++localId}`, createdAt: new Date().toISOString() });

export function Chat() {
  const [list, setList] = useState<ConversationSummary[]>([]);
  const [convId, setConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [showToday, setShowToday] = useState(false);
  const [todayData, setTodayData] = useState<TodayResponse | null>(null);
  const [todayBusy, setTodayBusy] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const convRef = useRef<string | null>(null);
  convRef.current = convId;

  useEffect(() => {
    void refreshList();
    void latestToday().then((m) => m?.payload && setTodayData(m.payload as TodayResponse)).catch(() => {});
    void invoke<OpenPayload | null>("take_pending_chat").then((p) => void openPayload(p ?? {}));
    const unlisten = listen<OpenPayload>("friday://open-conversation", (e) => void openPayload(e.payload));
    return () => void unlisten.then((f) => f());
  }, []);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [messages, draft]);

  async function refreshList() {
    try {
      setList(await conversations());
    } catch {
      /* core 未响应时侧栏留空 */
    }
  }

  async function openPayload(p: OpenPayload) {
    const id = p.conversationId ?? (await newConversation()).id;
    await load(id);
    if (p.initialPrompt) void send(p.initialPrompt, id);
    else inputRef.current?.focus();
  }

  async function load(id: string) {
    abortRef.current?.abort();
    setBusy(false);
    setDraft("");
    const conv = await conversationById(id);
    setConvId(conv.id);
    setMessages(conv.messages);
  }

  async function startNew() {
    const conv = await newConversation();
    abortRef.current?.abort();
    setBusy(false);
    setDraft("");
    setConvId(conv.id);
    setMessages([]);
    setInput("");
    inputRef.current?.focus();
  }

  function push(m: Omit<Message, "id" | "createdAt">) {
    setMessages((ms) => [...ms, local(m)]);
  }

  async function send(text: string, id = convRef.current) {
    const prompt = text.trim();
    if (!prompt || busy || !id) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy(true);
    setInput("");
    push({ role: "user", kind: "ask", content: prompt });
    let answer = "";
    try {
      for await (const ev of ask({ prompt, conversationId: id }, ctrl.signal)) {
        if (ev.type === "delta") {
          answer += ev.text;
          setDraft(answer);
        }
        if (ev.type === "error") push({ role: "assistant", kind: "error", content: ev.message });
      }
    } catch (e) {
      if (!ctrl.signal.aborted) push({ role: "assistant", kind: "error", content: e instanceof Error ? e.message : String(e) });
    } finally {
      if (answer) push({ role: "assistant", kind: "ask", content: answer });
      setDraft("");
      setBusy(false);
      void refreshList();
    }
  }

  async function refreshToday() {
    setTodayBusy(true);
    try {
      setTodayData(await today(new AbortController().signal));
    } finally {
      setTodayBusy(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(input);
    }
    if (e.key === "Escape" && busy) abortRef.current?.abort();
  }

  function onGlobalKey(e: React.KeyboardEvent) {
    if (e.metaKey && e.key === "n") {
      e.preventDefault();
      void startNew();
    } else if (e.metaKey && e.key === "w") {
      e.preventDefault();
      void getCurrentWindow().close();
    } else if (e.metaKey && e.key === ",") {
      void invoke("open_settings");
    }
  }

  const title = messages.find((m) => m.role === "user")?.content.slice(0, 40) ?? "新对话";

  return (
    <div className="chat" onKeyDown={onGlobalKey}>
      <aside className="chat__side">
        <div className="side__drag" data-tauri-drag-region />
        <button className="side__new" onClick={() => void startNew()}>
          <span>新对话</span>
          <kbd>⌘N</kbd>
        </button>
        <div className="side__list">
          {list.map((c) => (
            <button key={c.id} className={`side__item ${c.id === convId ? "side__item--active" : ""}`} onClick={() => void load(c.id)}>
              <span className="side__title">{c.title}</span>
              <span className="side__time">{fmtTime(c.updatedAt)}</span>
            </button>
          ))}
        </div>
        <button className={`side__today ${showToday ? "side__today--on" : ""}`} onClick={() => setShowToday((v) => !v)}>
          今天
          {todayData && <span className="side__count">{todayData.todos.length}</span>}
        </button>
      </aside>

      <main className="chat__main">
        <header className="chat__head" data-tauri-drag-region>
          <span className="chat__title">{title}</span>
          {busy && <span className="chat__busy" />}
        </header>
        <div className="chat__body" ref={bodyRef}>
          {messages.length === 0 && !draft && <div className="chat__empty">和 Friday 聊点什么。它记得这个对话里说过的话。</div>}
          {messages.map((m) =>
            m.role === "user" ? (
              <div key={m.id} className="bubble bubble--user">{m.content}</div>
            ) : (
              <div key={m.id} className="bubble bubble--assistant">
                <AssistantBody m={m} />
              </div>
            ),
          )}
          {draft && <div className="bubble bubble--assistant answer">{draft}</div>}
        </div>
        <div className="composer">
          <textarea
            ref={inputRef}
            className="composer__input"
            rows={1}
            placeholder={busy ? "生成中，Esc 中断" : "输入消息，Enter 发送，Shift+Enter 换行"}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            autoFocus
          />
        </div>
      </main>

      {showToday && (
        <aside className="chat__today">
          <header className="today__head">
            <span>今天</span>
            <button className="today__refresh" disabled={todayBusy} onClick={() => void refreshToday()}>
              {todayBusy ? "同步中…" : "刷新"}
            </button>
          </header>
          {todayData ? (
            <div className="today__body">
              <div className="answer today__brief">{todayData.brief}</div>
              <TodoList todos={todayData.todos} />
              <div className="today__time">更新于 {fmtTime(todayData.generatedAt)}</div>
            </div>
          ) : (
            <div className="today__body chat__empty">还没生成过简报，点「刷新」拉取 Meegle 与本地待办。</div>
          )}
        </aside>
      )}
    </div>
  );
}
