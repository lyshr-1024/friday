import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LogicalSize, getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Message, RunResponse, TodayResponse, Todo } from "@friday/shared";
import {
  ask,
  conversation,
  health,
  isTodayCommand,
  newConversation,
  note,
  openTodos,
  parseNote,
  parseRun,
  run,
  today,
} from "../lib/core";

type Status = { state: "checking" } | { state: "ok"; version: string } | { state: "down" };

const GUIDE = [
  { key: "today", label: "今日简报", hint: "Meegle 待办 + 本地记录，生成中文摘要" },
  { key: "note", label: "记一条待办", hint: "记 买牛奶" },
  { key: "run", label: "跑项目", hint: "跑 friday 修一下登录页" },
  { key: "settings", label: "打开设置", hint: "⌘ ," },
] as const;

const IDLE_HEIGHT = 56 + 12 + GUIDE.length * 40 + 34;
const ACTIVE_HEIGHT = 560;

let localId = 0;
const local = (m: Omit<Message, "id" | "createdAt">): Message => ({ ...m, id: `local-${++localId}`, createdAt: new Date().toISOString() });

export function Palette() {
  const [convId, setConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [guideIndex, setGuideIndex] = useState(0);
  const [todoCount, setTodoCount] = useState<number | null>(null);
  const [status, setStatus] = useState<Status>({ state: "checking" });
  const inputRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const active = messages.length > 0 || busy;

  useEffect(() => {
    void refresh();
    const unlisten = listen("friday://shown", () => {
      inputRef.current?.focus();
      void refresh();
    });
    return () => void unlisten.then((f) => f());
  }, []);

  useEffect(() => {
    void getCurrentWindow().setSize(new LogicalSize(680, active ? ACTIVE_HEIGHT : IDLE_HEIGHT));
    void invoke("set_pinned", { pinned: active });
  }, [active]);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [messages, draft]);

  async function refresh() {
    try {
      const h = await health();
      setStatus({ state: "ok", version: h.version });
      if (!convId) {
        const conv = await conversation();
        setConvId(conv.id);
        setMessages(conv.messages);
      }
      setTodoCount((await openTodos()).length);
    } catch {
      setStatus({ state: "down" });
    }
  }

  function push(m: Omit<Message, "id" | "createdAt">) {
    setMessages((ms) => [...ms, local(m)]);
  }

  function begin() {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy(true);
    setDraft("");
    return ctrl;
  }

  function finish(ctrl: AbortController, e?: unknown) {
    if (e && !ctrl.signal.aborted) push({ role: "assistant", kind: "error", content: e instanceof Error ? e.message : String(e) });
    setBusy(false);
    setDraft("");
  }

  async function submit() {
    if (busy) return;
    const text = prompt.trim();
    if (!text && !active) return runGuide(GUIDE[guideIndex]!.key);
    if (isTodayCommand(text)) return submitToday();
    const noteText = parseNote(text);
    if (noteText) return submitNote(noteText);
    const runReq = parseRun(text);
    if (runReq) return submitRun(runReq);
    return submitAsk(text);
  }

  function runGuide(key: (typeof GUIDE)[number]["key"]) {
    if (key === "today") return void submitToday();
    if (key === "settings") return void invoke("open_settings");
    setPrompt(key === "note" ? "记 " : "跑 ");
    inputRef.current?.focus();
  }

  async function submitAsk(text: string) {
    const ctrl = begin();
    push({ role: "user", kind: "ask", content: text });
    setPrompt("");
    let answer = "";
    try {
      for await (const ev of ask({ prompt: text, ...(convId ? { conversationId: convId } : {}) }, ctrl.signal)) {
        if (ev.type === "delta") {
          answer += ev.text;
          setDraft(answer);
        }
        if (ev.type === "error") push({ role: "assistant", kind: "error", content: ev.message });
      }
      if (answer) push({ role: "assistant", kind: "ask", content: answer });
      finish(ctrl);
    } catch (e) {
      if (answer) push({ role: "assistant", kind: "ask", content: answer });
      finish(ctrl, e);
    }
  }

  async function submitToday() {
    const ctrl = begin();
    push({ role: "user", kind: "today", content: "今日简报" });
    setPrompt("");
    try {
      const res = await today(ctrl.signal, convId ?? undefined);
      push({ role: "assistant", kind: "today", content: res.brief, payload: res });
      const errs = Object.entries(res.sourceErrors);
      if (errs.length) push({ role: "assistant", kind: "error", content: errs.map(([s, m]) => `${s}：${m}`).join("\n") });
      setTodoCount(res.todos.length);
      finish(ctrl);
    } catch (e) {
      finish(ctrl, e);
    }
  }

  async function submitNote(text: string) {
    const ctrl = begin();
    push({ role: "user", kind: "note", content: `记 ${text}` });
    setPrompt("");
    try {
      const todo = await note({ text, ...(convId ? { conversationId: convId } : {}) });
      push({ role: "assistant", kind: "note", content: `已记录：${todo.text}`, payload: todo });
      setTodoCount((n) => (n ?? 0) + 1);
      finish(ctrl);
    } catch (e) {
      finish(ctrl, e);
    }
  }

  async function submitRun(req: { project: string; task?: string }) {
    const ctrl = begin();
    push({ role: "user", kind: "run", content: `跑 ${req.project}${req.task ? ` ${req.task}` : ""}` });
    setPrompt("");
    try {
      const res = await run({ ...req, ...(convId ? { conversationId: convId } : {}) });
      const content =
        res.status === "ambiguous"
          ? `「${req.project}」匹配到多个项目，请用完整名字`
          : `已在 ${res.terminal === "ghostty" ? "Ghostty" : "Terminal"} 打开 ${res.project}`;
      push({ role: "assistant", kind: "run", content, payload: res });
      finish(ctrl);
    } catch (e) {
      finish(ctrl, e);
    }
  }

  async function startNew() {
    abortRef.current?.abort();
    const conv = await newConversation();
    setConvId(conv.id);
    setMessages([]);
    setDraft("");
    setBusy(false);
    setPrompt("");
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      if (busy) abortRef.current?.abort();
      else void invoke("hide_main");
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      void submit();
    } else if (e.metaKey && e.key === ",") {
      void invoke("open_settings");
    } else if (e.metaKey && e.key === "n") {
      e.preventDefault();
      void startNew();
    } else if (!active && !prompt && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      setGuideIndex((i) => (i + (e.key === "ArrowDown" ? 1 : GUIDE.length - 1)) % GUIDE.length);
    }
  }

  return (
    <div className="palette" onKeyDown={onKeyDown}>
      <div className="palette__bar">
        <input
          ref={inputRef}
          className="palette__input"
          placeholder={active ? "继续问，或 ⌘N 新对话" : "问点什么…"}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          autoFocus
          spellCheck={false}
        />
        {busy && <span className="progress" aria-label="working" />}
      </div>

      {!active && (
        <div className="guide">
          {GUIDE.map((g, i) => (
            <button
              key={g.key}
              className={`guide__item ${i === guideIndex ? "guide__item--active" : ""}`}
              onMouseEnter={() => setGuideIndex(i)}
              onClick={() => runGuide(g.key)}
            >
              <span className="guide__label">{g.label}</span>
              <span className="guide__hint">{g.hint}</span>
              {i === guideIndex && <kbd>↵</kbd>}
            </button>
          ))}
          <div className="guide__status">
            <span className={`dot dot--${status.state}`} />
            {status.state === "ok" && (todoCount === null ? "Friday 就绪" : `${todoCount} 条待办 · Friday 就绪`)}
            {status.state === "down" && "core 未响应"}
            {status.state === "checking" && "连接中…"}
          </div>
        </div>
      )}

      {active && (
        <>
          <div className="palette__body" ref={bodyRef}>
            {messages.map((m) => (
              <MessageView key={m.id} m={m} />
            ))}
            {draft && <div className="msg msg--assistant answer">{draft}</div>}
          </div>
          <footer className="palette__foot">
            <span className={`dot dot--${status.state}`} />
            <span>{status.state === "ok" ? `Friday ${status.version}` : status.state === "down" ? "core 未响应" : "连接中…"}</span>
            <span className="foot__right">
              <span><kbd>⌘N</kbd> 新对话</span>
              <span><kbd>esc</kbd> {busy ? "中断" : "收起"}</span>
            </span>
          </footer>
        </>
      )}
    </div>
  );
}

function MessageView({ m }: { m: Message }) {
  if (m.role === "user") return <div className="msg msg--user">{m.content}</div>;
  if (m.kind === "error") return <div className="msg msg--assistant err">{m.content}</div>;
  if (m.kind === "today" && m.payload) {
    const res = m.payload as TodayResponse;
    return (
      <div className="msg msg--assistant">
        <div className="answer">{m.content}</div>
        {res.todos.length > 0 && (
          <details className="todos-fold">
            <summary>{res.todos.length} 条待办</summary>
            <TodoList todos={res.todos} />
          </details>
        )}
      </div>
    );
  }
  if (m.kind === "run" && m.payload && (m.payload as RunResponse).status === "ambiguous") {
    const res = m.payload as Extract<RunResponse, { status: "ambiguous" }>;
    return (
      <div className="msg msg--assistant">
        <div className="answer">{m.content}</div>
        <ul className="todos">
          {res.candidates.map((c) => (
            <li key={c.dir} className="todo">
              <span>{c.name}</span>
              <span className="todo__due">{c.dir}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return <div className="msg msg--assistant answer">{m.content}</div>;
}

function TodoList({ todos }: { todos: Todo[] }) {
  return (
    <ul className="todos">
      {todos.map((t) => (
        <li key={t.id} className={`todo todo--${t.source}`}>
          <span className="todo__source mono">{t.source}</span>
          {t.sourceUrl ? (
            <a href={t.sourceUrl} onClick={(e) => { e.preventDefault(); void openUrl(t.sourceUrl!); }}>
              {t.text}
            </a>
          ) : (
            <span>{t.text}</span>
          )}
          {t.due && <span className="todo__due mono">{t.due}</span>}
        </li>
      ))}
    </ul>
  );
}
