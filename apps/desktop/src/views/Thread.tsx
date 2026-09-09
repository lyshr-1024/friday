import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import type { Attachment, Job, Message } from "@friday/shared";
import { ask, askSubscribe, cancelAsk, conversationById, jobs as fetchJobs, uploadAttachment } from "../lib/core";
import type { AskEvent } from "../lib/core";
import { useImeGuard } from "../lib/ime";
import { AssistantBody, AttachmentStrip, Linkified } from "./shared";

export interface ThreadHandle {
  load(id: string): Promise<void>;
  reset(): void;
  send(text: string, id?: string): Promise<void>;
  focus(): void;
}

export interface Resolved {
  id: string;
  prompt: string;
}

interface Props {
  /** 已经绑定的会话；null 表示还没有，第一句发出时由 resolve 决定落到哪 */
  conversationId: string | null;
  resolve?: (prompt: string) => Promise<Resolved | null>;
  resolvingText?: string;
  onConversation?: (id: string | null) => void;
  emptyTitle: string;
  emptyHint: string;
  placeholder?: string;
  hint?: string;
  banner?: ReactNode;
  onEscape?: () => void;
  autoFocus?: boolean;
}

let localId = 0;
const local = (m: Omit<Message, "id" | "createdAt">): Message => ({ ...m, id: `local-${++localId}`, createdAt: new Date().toISOString() });

/** 一段会话：消息流 + 输入框 + 附件。任务卡里和「问 Friday」视图各用一份，会话归谁由挂在哪决定。 */
export const Thread = forwardRef<ThreadHandle, Props>(function Thread(
  { conversationId, resolve, resolvingText, onConversation, emptyTitle, emptyHint, placeholder, hint, banner, onEscape, autoFocus },
  ref,
) {
  // 起始为空：绑定的会话由下面的 effect 去 load，才会把历史消息拉出来
  const [convId, setConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [pending, setPending] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const [jobList, setJobList] = useState<Job[]>([]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const convRef = useRef<string | null>(null);
  const ime = useImeGuard();
  // 滚动：本来在底部就跟着新内容走；用户往上翻了就不打扰，改成右下角提示；切会话时强制落底
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);
  const [unread, setUnread] = useState(false);
  const forceBottomRef = useRef(false);
  const lastLenRef = useRef(0);

  function scrollToBottom(smooth = false) {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    atBottomRef.current = true;
    setAtBottom(true);
    setUnread(false);
  }
  function onBodyScroll() {
    const el = bodyRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    atBottomRef.current = near;
    setAtBottom(near);
    if (near) setUnread(false);
  }

  useEffect(() => {
    if (conversationId === convRef.current) return;
    if (conversationId) void load(conversationId).catch(() => {});
    else reset();
  }, [conversationId]);

  useEffect(() => {
    const grew = messages.length > lastLenRef.current || Boolean(draft);
    lastLenRef.current = messages.length;
    if (forceBottomRef.current || atBottomRef.current) {
      forceBottomRef.current = false;
      // 等一帧，让新消息先排完版再量高度
      requestAnimationFrame(() => scrollToBottom());
    } else if (grew) {
      setUnread(true);
    }
  }, [messages, draft, busy]);

  useEffect(() => {
    const pull = () => void fetchJobs().then(setJobList).catch(() => {});
    pull();
    const t = setInterval(pull, jobList.some((j) => j.status === "running") ? 5000 : 30000);
    return () => clearInterval(t);
  }, [jobList.some((j) => j.status === "running")]);

  // 终端里的 Claude 交付 / 卡住会往这段会话里追加消息，空闲时每 8 秒对一次
  useEffect(() => {
    if (!convId || busy) return;
    const t = setInterval(() => {
      void conversationById(convId)
        .then((c) => {
          if (convRef.current !== convId) return;
          setMessages((cur) => (c.messages.length !== cur.filter((m) => !m.id.startsWith("local-")).length ? c.messages : cur));
        })
        .catch(() => {});
    }, 8000);
    return () => clearInterval(t);
  }, [convId, busy]);

  function setConversation(id: string | null) {
    setConvId(id);
    convRef.current = id;
    onConversation?.(id);
  }

  function newSubscription(): AbortSignal {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    return ctrl.signal;
  }

  function push(m: Omit<Message, "id" | "createdAt">) {
    setMessages((ms) => [...ms, local(m)]);
  }

  async function load(id: string) {
    abortRef.current?.abort();
    setBusy(false);
    setDraft("");
    const conv = await conversationById(id);
    forceBottomRef.current = true;
    setConversation(conv.id);
    setMessages(conv.messages);
    if (conv.running) void follow(conv.id, askSubscribe(conv.id, newSubscription()));
  }

  function reset() {
    forceBottomRef.current = true;
    setUnread(false);
    abortRef.current?.abort();
    setBusy(false);
    setDraft("");
    setMessages([]);
    setInput("");
    setPending([]);
    setConversation(null);
  }

  async function follow(id: string, events: AsyncGenerator<AskEvent>) {
    setBusy(true);
    let answer = "";
    try {
      for await (const ev of events) {
        if (convRef.current !== id) return;
        if (ev.type === "delta") {
          answer += ev.text;
          setDraft(answer);
        }
        if (ev.type === "reset") {
          answer = "";
          setDraft("");
        }
        if (ev.type === "error") push({ role: "assistant", kind: "error", content: ev.message });
      }
    } catch {
      return;
    }
    if (convRef.current !== id) return;
    try {
      const conv = await conversationById(id);
      setMessages(conv.messages);
    } catch {
      if (answer) push({ role: "assistant", kind: "ask", content: answer });
    }
    setDraft("");
    setBusy(false);
    // Friday 可能在这一轮里用 task_update 改了任务卡，让任务板重新拉
    window.dispatchEvent(new Event("friday:tasks-changed"));
  }

  async function send(text: string, id: string | null = convRef.current) {
    let prompt = text.trim() || (pending.length ? "看看这些附件" : "");
    if (!prompt || busy || uploading > 0 || resolving) return;
    if (!id) {
      if (!resolve) return;
      setResolving(true);
      const r = await resolve(prompt).catch(() => null);
      setResolving(false);
      if (!r) return;
      if (r.id !== convRef.current) await load(r.id).catch(() => setConversation(r.id));
      id = r.id;
      prompt = r.prompt;
    }
    const attachments = pending;
    setInput("");
    setPending([]);
    forceBottomRef.current = true;
    push({ role: "user", kind: "ask", content: text.trim() || prompt, ...(attachments.length ? { payload: { attachments } } : {}) });
    await follow(id, ask({ prompt, conversationId: id, ...(attachments.length ? { attachments: attachments.map((a) => a.id) } : {}) }, newSubscription()));
  }

  useImperativeHandle(ref, () => ({ load, reset, send, focus: () => inputRef.current?.focus() }));

  async function addFiles(files: Iterable<File>) {
    const list = [...files].filter((f) => f.size > 0).slice(0, 10 - pending.length);
    if (!list.length) return;
    setUploading((n) => n + list.length);
    for (const f of list) {
      try {
        const a = await uploadAttachment(f);
        setPending((p) => [...p, a]);
      } catch (e) {
        push({ role: "assistant", kind: "error", content: e instanceof Error ? e.message : String(e) });
      } finally {
        setUploading((n) => n - 1);
      }
    }
  }

  function onPaste(e: React.ClipboardEvent) {
    const files = [...e.clipboardData.items].filter((it) => it.kind === "file").map((it) => it.getAsFile()).filter((f): f is File => Boolean(f));
    if (!files.length) return;
    e.preventDefault();
    void addFiles(files);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      if (ime.isImeEnter(e)) return;
      e.preventDefault();
      void send(input);
    }
    if (e.key === "Escape") {
      if (busy && convRef.current) void cancelAsk(convRef.current);
      else onEscape?.();
    }
  }

  return (
    <div className="thread" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files); }}>
      {banner}
      <div className="thread__scroll">
      <div className="chat__body" ref={bodyRef} onScroll={onBodyScroll}>
        {messages.length === 0 && !draft && !busy && !resolving && (
          <div className="chat__empty">
            <div className="chat__mark">F</div>
            <div className="chat__empty-title">{emptyTitle}</div>
            <div className="chat__empty-hint">{emptyHint}</div>
          </div>
        )}
        {resolving && <div className="thread__resolving"><span className="side__spin" />{resolvingText ?? "正在准备…"}</div>}
        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="turn turn--user">
              <div className="bubble bubble--user">
                {(m.payload as { attachments?: Attachment[] } | undefined)?.attachments && (
                  <AttachmentStrip items={(m.payload as { attachments: Attachment[] }).attachments} />
                )}
                <Linkified text={m.content} />
              </div>
            </div>
          ) : (
            <div key={m.id} className="turn turn--assistant">
              <div className="avatar">F</div>
              <div className="bubble bubble--assistant">
                <AssistantBody m={m} jobs={jobList} />
              </div>
            </div>
          ),
        )}
        {busy && !draft && (
          <div className="turn turn--assistant">
            <div className="avatar avatar--live">F</div>
            <div className="bubble bubble--assistant thinking" aria-label="思考中">
              <span /><span /><span />
            </div>
          </div>
        )}
        {draft && (
          <div className="turn turn--assistant">
            <div className="avatar avatar--live">F</div>
            <div className="bubble bubble--assistant answer answer--streaming">{draft}</div>
          </div>
        )}
      </div>
      {!atBottom && (
        <button className={`thread__jump ${unread ? "thread__jump--unread" : ""}`} onClick={() => scrollToBottom(true)} title="回到底部">
          {unread ? "有新回复" : ""}<span className="thread__jump-arrow">↓</span>
        </button>
      )}
      </div>
      <div className="composer">
        {pending.length > 0 && <AttachmentStrip items={pending} onRemove={(id) => setPending((p) => p.filter((a) => a.id !== id))} />}
        <div className="composer__box">
          <button className="composer__attach" title="添加图片或文件（也可以直接粘贴、拖入）" onClick={() => fileRef.current?.click()}>
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M10.5 5.5 6 10a1.8 1.8 0 0 0 2.5 2.5l5-5a3.2 3.2 0 0 0-4.5-4.5l-5 5a4.6 4.6 0 0 0 6.5 6.5l3.5-3.5" /></svg>
          </button>
          <input ref={fileRef} type="file" multiple hidden onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ""; }} />
          <textarea
            ref={inputRef}
            className="composer__input"
            rows={1}
            placeholder={busy ? "生成中，Esc 中断" : uploading ? "上传中…" : placeholder ?? "问 Friday，可粘贴图片或拖入文件"}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            {...ime.handlers}
            autoFocus={autoFocus}
          />
          <button className="composer__send" disabled={busy || uploading > 0 || resolving || (!input.trim() && !pending.length)} onClick={() => void send(input)} aria-label="发送">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" /></svg>
          </button>
        </div>
        {hint && <div className="composer__hint">{hint}</div>}
      </div>
    </div>
  );
});
