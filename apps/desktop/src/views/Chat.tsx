import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ConversationSummary, HotResponse, Message } from "@friday/shared";
import { ask, conversationById, conversations, hot, newConversation } from "../lib/core";
import { AssistantBody, HotList, fmtTime } from "./shared";

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
  const [showHot, setShowHot] = useState(false);
  const [hotData, setHotData] = useState<HotResponse | null>(null);
  const [hotBusy, setHotBusy] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const convRef = useRef<string | null>(null);
  convRef.current = convId;

  useEffect(() => {
    void refreshList();
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

  async function loadHot(refresh = false) {
    setHotBusy(true);
    try {
      setHotData(await hot(new AbortController().signal, refresh));
    } finally {
      setHotBusy(false);
    }
  }

  function toggleHot() {
    setShowHot((v) => {
      if (!v && !hotData) void loadHot();
      return !v;
    });
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
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M8 3v10M3 8h10" /></svg>
          <span>新对话</span>
          <kbd>⌘N</kbd>
        </button>
        <div className="side__label">最近</div>
        <div className="side__list">
          {list.map((c) => (
            <button key={c.id} className={`side__item ${c.id === convId ? "side__item--active" : ""}`} onClick={() => void load(c.id)}>
              <span className="side__title">{c.title}</span>
              <span className="side__time">{fmtTime(c.updatedAt)}</span>
            </button>
          ))}
        </div>
        <button className={`side__today ${showHot ? "side__today--on" : ""}`} onClick={toggleHot}>
          AI 热点
          {hotData && <span className="side__count">{hotData.items.length}</span>}
        </button>
      </aside>

      <main className="chat__main">
        <header className="chat__head" data-tauri-drag-region>
          <span className="chat__title">{title}</span>
          {busy && <span className="chat__busy" />}
          <span className="chat__count">{messages.length ? `${messages.length} 条` : ""}</span>
        </header>
        <div className="chat__body" ref={bodyRef}>
          {messages.length === 0 && !draft && (
            <div className="chat__empty">
              <div className="chat__mark">F</div>
              <div className="chat__empty-title">和 Friday 聊点什么</div>
              <div className="chat__empty-hint">它记得这个对话里说过的话，能查项目 git 状态、改记忆库、记待办，涉及编码会在终端里帮你打开 Claude Code。</div>
            </div>
          )}
          {messages.map((m) =>
            m.role === "user" ? (
              <div key={m.id} className="turn turn--user">
                <div className="bubble bubble--user">{m.content}</div>
              </div>
            ) : (
              <div key={m.id} className="turn turn--assistant">
                <div className="avatar">F</div>
                <div className="bubble bubble--assistant">
                  <AssistantBody m={m} />
                </div>
              </div>
            ),
          )}
          {draft && (
            <div className="turn turn--assistant">
              <div className="avatar">F</div>
              <div className="bubble bubble--assistant answer">{draft}</div>
            </div>
          )}
        </div>
        <div className="composer">
          <div className="composer__box">
          <textarea
            ref={inputRef}
            className="composer__input"
            rows={1}
            placeholder={busy ? "生成中，Esc 中断" : "给 Friday 发消息"}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            autoFocus
          />
          <button className="composer__send" disabled={busy || !input.trim()} onClick={() => void send(input)} aria-label="发送">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" /></svg>
          </button>
          </div>
          <div className="composer__hint">Enter 发送 · Shift+Enter 换行 · ⌘N 新对话</div>
        </div>
      </main>

      {showHot && (
        <aside className="chat__today">
          <header className="today__head">
            <span>AI 热点</span>
            <button className="today__refresh" disabled={hotBusy} onClick={() => void loadHot(true)}>
              {hotBusy ? "拉取中…" : "重新拉取"}
            </button>
          </header>
          {hotData ? (
            <div className="today__body">
              <HotList items={hotData.items} />
              <div className="today__time">更新于 {fmtTime(hotData.generatedAt)}</div>
            </div>
          ) : (
            <div className="today__body chat__empty">{hotBusy ? "正在汇总 HN、HF Papers、OpenAI、Simon Willison、量子位…" : "点「重新拉取」获取。"}</div>
          )}
        </aside>
      )}
    </div>
  );
}
