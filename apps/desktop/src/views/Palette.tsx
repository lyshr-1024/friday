import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LogicalSize, getCurrentWindow } from "@tauri-apps/api/window";
import type { Message } from "@friday/shared";
import { ask, health, isTodayCommand, newConversation, note, openTodos, parseNote, parseRun, run, today } from "../lib/core";
import { AssistantBody } from "./shared";

type Status = { state: "checking" } | { state: "ok"; version: string } | { state: "down" };

const GUIDE = [
  { key: "today", label: "今日简报", hint: "Meegle 待办 + 本地记录" },
  { key: "note", label: "记一条待办", hint: "记 买牛奶" },
  { key: "run", label: "跑项目", hint: "跑 friday 修一下登录页" },
  { key: "chat", label: "打开会话窗", hint: "多轮对话，⌘↵ 也可以" },
  { key: "settings", label: "设置", hint: "⌘ ," },
] as const;

const IDLE_HEIGHT = 56 + 12 + GUIDE.length * 40 + 34;
const RESULT_HEIGHT = 400;

export function Palette() {
  const [prompt, setPrompt] = useState("");
  const [result, setResult] = useState<Message | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [guideIndex, setGuideIndex] = useState(0);
  const [todoCount, setTodoCount] = useState<number | null>(null);
  const [status, setStatus] = useState<Status>({ state: "checking" });
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // 本次呼出期间的临时会话：追问时整段搬进会话窗继续。
  const convRef = useRef<string | null>(null);

  const hasResult = Boolean(result || draft || busy);

  useEffect(() => {
    void refresh();
    const unlisten = listen("friday://shown", () => {
      reset();
      inputRef.current?.focus();
      void refresh();
    });
    return () => void unlisten.then((f) => f());
  }, []);

  useEffect(() => {
    void getCurrentWindow().setSize(new LogicalSize(680, hasResult ? RESULT_HEIGHT : IDLE_HEIGHT));
  }, [hasResult]);

  function reset() {
    abortRef.current?.abort();
    setPrompt("");
    setResult(null);
    setDraft("");
    setBusy(false);
    convRef.current = null;
  }

  async function refresh() {
    try {
      const h = await health();
      setStatus({ state: "ok", version: h.version });
      setTodoCount((await openTodos()).length);
    } catch {
      setStatus({ state: "down" });
    }
  }

  async function ensureConv(): Promise<string> {
    convRef.current ??= (await newConversation()).id;
    return convRef.current;
  }

  function begin() {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy(true);
    setResult(null);
    setDraft("");
    setPrompt("");
    return ctrl;
  }

  function done(ctrl: AbortController, m?: Omit<Message, "id" | "createdAt">, e?: unknown) {
    if (m) setResult({ ...m, id: "r", createdAt: new Date().toISOString() });
    if (e && !ctrl.signal.aborted) {
      setResult({ id: "r", role: "assistant", kind: "error", content: e instanceof Error ? e.message : String(e), createdAt: "" });
    }
    setBusy(false);
    setDraft("");
  }

  async function openChat(initialPrompt?: string) {
    const conversationId = result?.kind === "ask" || initialPrompt ? await ensureConv() : (await newConversation()).id;
    await invoke("open_chat", { conversationId, initialPrompt: initialPrompt ?? null });
    reset();
  }

  async function submit(toChat = false) {
    if (busy) return;
    const text = prompt.trim();
    if (!text && !hasResult) return runGuide(GUIDE[guideIndex]!.key);
    if (!text) return;
    if (toChat) return openChat(text);
    if (isTodayCommand(text)) return submitToday();
    const noteText = parseNote(text);
    if (noteText) return submitNote(noteText);
    const runReq = parseRun(text);
    if (runReq) return submitRun(runReq);
    // 已经有一轮问答，再问就是追问，搬到会话窗里继续。
    if (result?.kind === "ask") return openChat(text);
    return submitAsk(text);
  }

  function runGuide(key: (typeof GUIDE)[number]["key"]) {
    if (key === "today") return void submitToday();
    if (key === "settings") return void invoke("open_settings");
    if (key === "chat") return void openChat();
    setPrompt(key === "note" ? "记 " : "跑 ");
    inputRef.current?.focus();
  }

  async function submitAsk(text: string) {
    const ctrl = begin();
    const conversationId = await ensureConv();
    let answer = "";
    try {
      for await (const ev of ask({ prompt: text, conversationId }, ctrl.signal)) {
        if (ev.type === "delta") {
          answer += ev.text;
          setDraft(answer);
        }
        if (ev.type === "error") done(ctrl, { role: "assistant", kind: "error", content: ev.message });
      }
      if (answer) done(ctrl, { role: "assistant", kind: "ask", content: answer });
      else setBusy(false);
    } catch (e) {
      done(ctrl, undefined, e);
    }
  }

  async function submitToday() {
    const ctrl = begin();
    try {
      const res = await today(ctrl.signal, await ensureConv());
      const errs = Object.entries(res.sourceErrors);
      const content = errs.length ? `${res.brief}\n\n${errs.map(([s, m]) => `${s}：${m}`).join("\n")}` : res.brief;
      setTodoCount(res.todos.length);
      done(ctrl, { role: "assistant", kind: "today", content, payload: res });
    } catch (e) {
      done(ctrl, undefined, e);
    }
  }

  async function submitNote(text: string) {
    const ctrl = begin();
    try {
      const todo = await note({ text, conversationId: await ensureConv() });
      setTodoCount((n) => (n ?? 0) + 1);
      done(ctrl, { role: "assistant", kind: "note", content: `已记录：${todo.text}`, payload: todo });
    } catch (e) {
      done(ctrl, undefined, e);
    }
  }

  async function submitRun(req: { project: string; task?: string }) {
    const ctrl = begin();
    try {
      const res = await run({ ...req, conversationId: await ensureConv() });
      const content =
        res.status === "ambiguous"
          ? `「${req.project}」匹配到多个项目，请用完整名字`
          : `已在 ${res.terminal === "ghostty" ? "Ghostty" : "Terminal"} 打开 ${res.project}`;
      done(ctrl, { role: "assistant", kind: "run", content, payload: res });
    } catch (e) {
      done(ctrl, undefined, e);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      if (busy) abortRef.current?.abort();
      else if (hasResult) reset();
      else void invoke("hide_main");
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      void submit(e.metaKey);
    } else if (e.metaKey && e.key === ",") {
      void invoke("open_settings");
    } else if (!hasResult && !prompt && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
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
          placeholder={result?.kind === "ask" ? "继续问会打开会话窗…" : "问点什么…"}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          autoFocus
          spellCheck={false}
        />
        {busy && <span className="progress" aria-label="working" />}
      </div>

      {!hasResult && (
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

      {hasResult && (
        <>
          <div className="palette__body">
            {draft && <div className="answer">{draft}</div>}
            {result && !draft && <AssistantBody m={result} />}
          </div>
          <footer className="palette__foot">
            <span className={`dot dot--${status.state}`} />
            <span>{status.state === "ok" ? `Friday ${status.version}` : status.state === "down" ? "core 未响应" : "连接中…"}</span>
            <span className="foot__right">
              {result?.kind === "ask" && <span><kbd>↵</kbd> 追问进会话窗</span>}
              <span><kbd>esc</kbd> {busy ? "中断" : "清空"}</span>
            </span>
          </footer>
        </>
      )}
    </div>
  );
}
