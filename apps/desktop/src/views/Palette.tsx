import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LogicalSize, getCurrentWindow } from "@tauri-apps/api/window";
import type { HotResponse, InboxResponse, Message, TodosSyncResponse } from "@friday/shared";
import { ask, commandOf, health, hot, inbox, inboxDone, newConversation, note, openTodos, parseNote, parseRun, run, syncTodos } from "../lib/core";
import { AssistantBody, HotList, InboxList, TodoList } from "./shared";
import { useImeGuard } from "../lib/ime";

type Status = { state: "checking" } | { state: "ok"; version: string } | { state: "down" };
type Panel = { kind: "hot"; data: HotResponse } | { kind: "todos"; data: TodosSyncResponse } | { kind: "inbox"; data: InboxResponse };

const GUIDE = [
  { key: "inbox", label: "Slack 收件", hint: "@ 我的与私聊，已预处理并附回复草稿" },
  { key: "hot", label: "AI 热点", hint: "HN · HF Papers · OpenAI · Simon W · 量子位" },
  { key: "todos", label: "待办", hint: "Meegle + 本地，秒开" },
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
  const [panel, setPanel] = useState<Panel | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [guideIndex, setGuideIndex] = useState(0);
  const [todoCount, setTodoCount] = useState<number | null>(null);
  const [status, setStatus] = useState<Status>({ state: "checking" });
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // 本次呼出期间的临时会话：追问时整段搬进会话窗继续。
  const convRef = useRef<string | null>(null);
  const ime = useImeGuard();

  const hasResult = Boolean(result || panel || draft || busy);

  useEffect(() => {
    void refresh();
    const unlisten = listen("friday://shown", () => {
      reset();
      inputRef.current?.focus();
      void refresh();
    });
    // 点到面板空白处后焦点会离开输入框，把它拉回来，快捷键才不会失灵。
    const refocus = () => setTimeout(() => inputRef.current?.focus(), 0);
    window.addEventListener("mouseup", refocus);
    return () => {
      void unlisten.then((f) => f());
      window.removeEventListener("mouseup", refocus);
    };
  }, []);

  useEffect(() => {
    void getCurrentWindow().setSize(new LogicalSize(680, hasResult ? RESULT_HEIGHT : IDLE_HEIGHT));
  }, [hasResult]);

  function reset() {
    abortRef.current?.abort();
    setPrompt("");
    setResult(null);
    setPanel(null);
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
    setPanel(null);
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
    const cmd = commandOf(text);
    if (cmd === "hot") return submitHot();
    if (cmd === "todos") return submitTodos();
    if (cmd === "inbox") return submitInbox();
    const noteText = parseNote(text);
    if (noteText) return submitNote(noteText);
    const runReq = parseRun(text);
    if (runReq) return submitRun(runReq);
    // 已经有一轮问答，再问就是追问，搬到会话窗里继续。
    if (result?.kind === "ask") return openChat(text);
    return submitAsk(text);
  }

  function runGuide(key: (typeof GUIDE)[number]["key"]) {
    if (key === "hot") return void submitHot();
    if (key === "todos") return void submitTodos();
    if (key === "inbox") return void submitInbox();
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
        if (ev.type === "reset") {
          answer = "";
          setDraft("");
        }
        if (ev.type === "error") done(ctrl, { role: "assistant", kind: "error", content: ev.message });
      }
      if (answer) done(ctrl, { role: "assistant", kind: "ask", content: answer });
      else setBusy(false);
    } catch (e) {
      done(ctrl, undefined, e);
    }
  }

  async function submitHot(refresh = false) {
    const ctrl = begin();
    try {
      const data = await hot(ctrl.signal, refresh);
      setPanel({ kind: "hot", data });
      setBusy(false);
    } catch (e) {
      done(ctrl, undefined, e);
    }
  }

  async function submitInbox(sync = false) {
    const ctrl = begin();
    try {
      const data = await inbox(sync, ctrl.signal);
      setPanel({ kind: "inbox", data });
      setBusy(false);
    } catch (e) {
      done(ctrl, undefined, e);
    }
  }

  function inboxItemDone(id: string) {
    void inboxDone(id);
    setPanel((p) => (p?.kind === "inbox" ? { kind: "inbox", data: { ...p.data, items: p.data.items.filter((i) => i.id !== id) } } : p));
  }

  async function submitTodos() {
    const ctrl = begin();
    try {
      const data = await syncTodos(ctrl.signal);
      setTodoCount(data.todos.length);
      setPanel({ kind: "todos", data });
      setBusy(false);
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
    } else if (e.key === "Enter") {
      if (ime.isImeEnter(e)) return;
      void submit(e.metaKey);
    } else if (e.metaKey && e.key === ",") {
      void invoke("open_settings");
    } else if (e.metaKey && e.key === "r" && panel?.kind === "hot") {
      e.preventDefault();
      void submitHot(true);
    } else if (e.metaKey && e.key === "r" && panel?.kind === "inbox") {
      e.preventDefault();
      void submitInbox(true);
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
          {...ime.handlers}
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
            {panel?.kind === "hot" && (
              <>
                {Object.keys(panel.data.sourceErrors).length > 0 && (
                  <div className="muted mono" style={{ marginBottom: 8 }}>
                    拉取失败：{Object.entries(panel.data.sourceErrors).map(([s]) => s).join("、")}
                  </div>
                )}
                <HotList items={panel.data.items} />
              </>
            )}
            {panel?.kind === "inbox" && (
              <>
                {!panel.data.configured && <div className="err">Slack 还没接入：在终端跑 scripts/slack-auth.sh 写入登录态。</div>}
                {panel.data.lastError && <div className="err">{panel.data.lastError}</div>}
                <InboxList items={panel.data.items} onDone={inboxItemDone} />
                {panel.data.lastSyncAt && <div className="muted mono" style={{ marginTop: 10 }}>上次同步 {new Date(panel.data.lastSyncAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</div>}
              </>
            )}
            {panel?.kind === "todos" && (
              <>
                {Object.keys(panel.data.sourceErrors).length > 0 && (
                  <div className="err">{Object.entries(panel.data.sourceErrors).map(([s, m]) => `${s}：${m}`).join("\n")}</div>
                )}
                {panel.data.todos.length ? <TodoList todos={panel.data.todos} /> : <div className="muted">没有未完成的待办</div>}
              </>
            )}
          </div>
          <footer className="palette__foot">
            <span className={`dot dot--${status.state}`} />
            <span>{status.state === "ok" ? `Friday ${status.version}` : status.state === "down" ? "core 未响应" : "连接中…"}</span>
            <span className="foot__right">
              {result?.kind === "ask" && <span><kbd>↵</kbd> 追问进会话窗</span>}
              {panel?.kind === "hot" && <span><kbd>⌘R</kbd> 重新拉取</span>}
              {panel?.kind === "inbox" && <span><kbd>⌘R</kbd> 立即同步</span>}
              <span><kbd>esc</kbd> {busy ? "中断" : "清空"}</span>
            </span>
          </footer>
        </>
      )}
    </div>
  );
}
