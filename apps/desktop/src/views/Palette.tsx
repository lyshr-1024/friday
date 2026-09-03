import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LogicalSize, getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Todo } from "@friday/shared";
import { ask, health, isTodayCommand, note, parseNote, today } from "../lib/core";

type Status = { state: "checking" } | { state: "ok"; ms: number; version: string } | { state: "down" };

export function Palette() {
  const [prompt, setPrompt] = useState("");
  const [answer, setAnswer] = useState("");
  const [todos, setTodos] = useState<Todo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>({ state: "checking" });
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const unlisten = listen("friday://shown", () => {
      inputRef.current?.focus();
      inputRef.current?.select();
      void checkHealth();
    });
    void checkHealth();
    return () => void unlisten.then((f) => f());
  }, []);

  async function checkHealth() {
    const t0 = performance.now();
    try {
      const h = await health();
      setStatus({ state: "ok", ms: Math.round(performance.now() - t0), version: h.version });
    } catch {
      setStatus({ state: "down" });
    }
  }

  function begin() {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy(true);
    setAnswer("");
    setTodos([]);
    setError(null);
    return ctrl;
  }

  function fail(e: unknown, ctrl: AbortController) {
    if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : String(e));
  }

  async function submit() {
    if (busy) return;
    const text = prompt.trim();
    if (isTodayCommand(text)) return submitToday();
    const noteText = parseNote(text);
    if (noteText) return submitNote(noteText);

    const ctrl = begin();
    try {
      for await (const ev of ask({ prompt: text }, ctrl.signal)) {
        if (ev.type === "delta") setAnswer((a) => a + ev.text);
        if (ev.type === "error") setError(ev.message);
      }
    } catch (e) {
      fail(e, ctrl);
    } finally {
      setBusy(false);
    }
  }

  async function submitToday() {
    const ctrl = begin();
    setAnswer("正在汇总 Meegle 与本地待办…");
    try {
      const res = await today(ctrl.signal);
      setAnswer(res.brief);
      setTodos(res.todos);
      const errs = Object.entries(res.sourceErrors);
      if (errs.length) setError(errs.map(([s, m]) => `${s}：${m}`).join("\n"));
      setPrompt("");
    } catch (e) {
      setAnswer("");
      fail(e, ctrl);
    } finally {
      setBusy(false);
    }
  }

  async function submitNote(text: string) {
    const ctrl = begin();
    try {
      const todo = await note({ text });
      setAnswer(`已记录：${todo.text}`);
      setPrompt("");
    } catch (e) {
      fail(e, ctrl);
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      if (busy) abortRef.current?.abort();
      else void invoke("hide_main");
    }
    if (e.key === "Enter" && !e.nativeEvent.isComposing) void submit();
    if (e.key === "," && e.metaKey) void invoke("open_settings");
  }

  const hasOutput = Boolean(answer || error);

  // Spotlight 式：空闲只留一条搜索栏，有内容再展开。
  useEffect(() => {
    void getCurrentWindow().setSize(new LogicalSize(680, hasOutput ? 460 : 60));
  }, [hasOutput]);

  return (
    <div className="palette" onKeyDown={onKeyDown}>
      <div className="palette__bar">
        <svg className="palette__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          ref={inputRef}
          className="palette__input"
          placeholder="问 Friday…"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          autoFocus
          spellCheck={false}
        />
        {busy && <span className="pulse" aria-label="thinking" />}
      </div>

      {hasOutput && (
      <div className="palette__body">
        {error && <p className="err">{error}</p>}
        {answer && <div className="answer">{answer}</div>}
        {todos.length > 0 && (
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
        )}
      </div>
      )}

      {hasOutput && (
      <footer className="palette__foot">
        <span className={`dot dot--${status.state}`} />
        <span>
          {status.state === "ok" && `Friday ${status.version}`}
          {status.state === "down" && "core 未响应"}
          {status.state === "checking" && "连接中…"}
        </span>
        <span className="foot__right">
          <span><kbd>↵</kbd> 空输入看简报</span>
          <span><kbd>记</kbd> 添加待办</span>
          <span><kbd>esc</kbd> 关闭</span>
        </span>
      </footer>
      )}
    </div>
  );
}
