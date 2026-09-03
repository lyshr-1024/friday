import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ask, health, note, parseNote } from "../lib/core";

type Status = { state: "checking" } | { state: "ok"; ms: number; version: string } | { state: "down" };

export function Palette() {
  const [prompt, setPrompt] = useState("");
  const [answer, setAnswer] = useState("");
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

  async function submit() {
    const text = prompt.trim();
    if (!text || busy) return;
    const noteText = parseNote(text);
    if (noteText) return submitNote(noteText);
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy(true);
    setAnswer("");
    setError(null);
    try {
      for await (const ev of ask({ prompt: text }, ctrl.signal)) {
        if (ev.type === "delta") setAnswer((a) => a + ev.text);
        if (ev.type === "error") setError(ev.message);
      }
    } catch (e) {
      if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function submitNote(text: string) {
    setBusy(true);
    setAnswer("");
    setError(null);
    try {
      const todo = await note({ text });
      setAnswer(`已记录：${todo.text}`);
      setPrompt("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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

  const hasOutput = answer || error;

  return (
    <div className="palette" onKeyDown={onKeyDown}>
      <div className="palette__bar">
        <span className="wordmark">F.</span>
        <input
          ref={inputRef}
          className="palette__input"
          placeholder="问我点什么，或「记 …」添加待办"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          autoFocus
          spellCheck={false}
        />
        {busy && <span className="pulse" aria-label="thinking" />}
      </div>

      <div className={`palette__body ${hasOutput ? "" : "palette__body--empty"}`}>
        {error && <p className="err">{error}</p>}
        {answer && <div className="answer">{answer}</div>}
        {!hasOutput && (
          <ul className="hints">
            <li>
              <kbd>↵</kbd> 提问
            </li>
            <li>
              <kbd>esc</kbd> 关闭
            </li>
            <li>
              <kbd>⌘ ,</kbd> 设置
            </li>
          </ul>
        )}
      </div>

      <footer className="palette__foot">
        <span className={`dot dot--${status.state}`} />
        <span className="mono">
          {status.state === "ok" && `core ${status.version} · ${status.ms}ms`}
          {status.state === "down" && "core 未响应"}
          {status.state === "checking" && "连接 core…"}
        </span>
        <span className="mono foot__right">Friday</span>
      </footer>
    </div>
  );
}
