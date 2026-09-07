import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Attachment, ConversationSummary, HotResponse, Job, Message, ModelId, Thread } from "@friday/shared";
import { ask, askSubscribe, cancelAsk, conversationById, conversations, hot, jobs as fetchJobs, newConversation, settings, taskBoard, threadPrompt, threads as fetchThreads, updateSettings, uploadAttachment } from "../lib/core";
import type { AskEvent } from "../lib/core";
import { ModelSelect } from "./ModelSelect";
import { AssistantBody, AttachmentStrip, HotList, LinkMenuHost, Linkified, fmtTime } from "./shared";
import { Board } from "./Board";
import type { Task } from "@friday/shared";
import { useImeGuard } from "../lib/ime";

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

  const [jobList, setJobList] = useState<Job[]>([]);

  const [pending, setPending] = useState<Attachment[]>([]);

  const [drawer, setDrawer] = useState(false);
  const [tab, setTab] = useState<"board" | "hot">("board");
  const [reviewCount, setReviewCount] = useState(0);
  const [uploading, setUploading] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const [hotData, setHotData] = useState<HotResponse | null>(null);
  const [hotBusy, setHotBusy] = useState(false);
  const [model, setModel] = useState<ModelId | null>(null);

  const [skills, setSkills] = useState<boolean | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const convRef = useRef<string | null>(null);
  const ime = useImeGuard();
  convRef.current = convId;

  useEffect(() => {
    void refreshList();
    void settings().then((s) => { setModel(s.model); setSkills(s.skills); }).catch(() => {});
    void invoke<OpenPayload | null>("take_pending_chat").then((p) => void openPayload(p ?? {}));
    const unlisten = listen<OpenPayload>("friday://open-conversation", (e) => void openPayload(e.payload));
    return () => void unlisten.then((f) => f());
  }, []);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [messages, draft, busy]);

  useEffect(() => {
    const tick = () => void taskBoard().then((b) => setReviewCount(b.counts.review)).catch(() => {});
    tick();
    const t = setInterval(tick, 20000);
    return () => clearInterval(t);
  }, []);

  function discussTask(t: Task) {
    setDrawer(true);
    void (async () => {
      const conv = await newConversation();
      setConvId(conv.id);
      convRef.current = conv.id;
      setMessages([]);
      const lines = [
        `和我讨论这个任务：${t.title}`,
        t.understanding ? `你的理解：${t.understanding}` : "",
        t.plan ? `你的方案：${t.plan}` : "",
        t.progress ? `进展：${t.progress}` : "",
        t.report ? `交付报告概要：${t.report.summary}；测试结果：${t.report.testResult}` : "",
        t.pending?.length ? `等我点头的动作：${t.pending.map((p) => p.label).join("、")}` : "",
        "先说你的判断，我有疑问会问。",
      ].filter(Boolean);
      void send(lines.join("\n"), conv.id);
    })();
  }

  async function openThreadById(id: string) {
    const list = await fetchThreads();
    const t: Thread | undefined = list.threads.find((x) => x.id === id);
    if (!t) return;
    setDrawer(true);
    const conv = await newConversation();
    setConvId(conv.id);
    convRef.current = conv.id;
    setMessages([]);
    void send(threadPrompt(t), conv.id);
  }

  // 任务列表：有运行中的每 5 秒刷，否则 30 秒。
  useEffect(() => {
    const load = () => void fetchJobs().then(setJobList).catch(() => {});
    load();
    const t = setInterval(load, jobList.some((j) => j.status === "running") ? 5000 : 30000);
    return () => clearInterval(t);
  }, [jobList.some((j) => j.status === "running")]);

  // 有别的会话在后台生成时定时刷新侧栏，跑完把转圈去掉。
  useEffect(() => {
    if (!list.some((c) => c.running)) return;
    const t = setInterval(() => void refreshList(), 5000);
    return () => clearInterval(t);
  }, [list]);

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

  // 切换会话只取消订阅，后台生成继续；切回来时若还在跑就重新订阅并回放。
  async function load(id: string) {
    abortRef.current?.abort();
    setBusy(false);
    setDraft("");
    const conv = await conversationById(id);
    setConvId(conv.id);
    convRef.current = conv.id;
    setMessages(conv.messages);
    if (conv.running) void follow(conv.id, askSubscribe(conv.id, newSubscription()));
  }

  function newSubscription(): AbortSignal {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    return ctrl.signal;
  }

  // 消费一条事件流；结束后从 core 重新拉这条会话，拿到落库后的消息。
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
    void refreshList();
  }

  async function startNew() {
    setDrawer(true);
    const conv = await newConversation();
    abortRef.current?.abort();
    setBusy(false);
    setDraft("");
    setConvId(conv.id);
    convRef.current = conv.id;
    setMessages([]);
    setInput("");
    inputRef.current?.focus();
  }

  function push(m: Omit<Message, "id" | "createdAt">) {
    setMessages((ms) => [...ms, local(m)]);
  }

  async function send(text: string, id = convRef.current) {
    const prompt = text.trim() || (pending.length ? "看看这些附件" : "");
    if (!prompt || busy || !id || uploading > 0) return;
    const attachments = pending;
    setInput("");
    setPending([]);
    push({ role: "user", kind: "ask", content: prompt, ...(attachments.length ? { payload: { attachments } } : {}) });
    void refreshList();
    await follow(id, ask({ prompt, conversationId: id, ...(attachments.length ? { attachments: attachments.map((a) => a.id) } : {}) }, newSubscription()));
  }

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

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
  }

  function interrupt() {
    if (convRef.current) void cancelAsk(convRef.current);
  }

  async function loadHot(refresh = false) {
    setHotBusy(true);
    try {
      setHotData(await hot(new AbortController().signal, refresh));
    } finally {
      setHotBusy(false);
    }
  }



  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      if (ime.isImeEnter(e)) return;
      e.preventDefault();
      void send(input);
    }
    if (e.key === "Escape" && busy) interrupt();
  }

  // 挂在 window 上，焦点不在输入框（比如点了空白处）时快捷键也要生效。
  useEffect(() => {
    function onGlobalKey(e: KeyboardEvent) {
      if (!e.metaKey) return;
      if (e.key === "n") {
        e.preventDefault();
        void startNew();
      } else if (e.key === "j") {
        e.preventDefault();
        setDrawer((v) => !v);
      } else if (e.key === "w") {
        e.preventDefault();
        void getCurrentWindow().close();
      } else if (e.key === ",") {
        e.preventDefault();
        void invoke("open_settings");
      }
    }
    window.addEventListener("keydown", onGlobalKey);
    return () => window.removeEventListener("keydown", onGlobalKey);
  }, []);


  return (
    <div className="chat">
      <LinkMenuHost />
      <div className="wb">
        <header className="wb__nav" data-tauri-drag-region>
          <div className="wb__tabs">
            <button className={tab === "board" ? "on" : ""} onClick={() => setTab("board")}>工作台{reviewCount ? <span className="board__badge">{reviewCount}</span> : null}</button>
            <button className={tab === "hot" ? "on" : ""} onClick={() => { setTab("hot"); if (!hotData) void loadHot(); }}>AI 热点</button>
          </div>
          <div className="wb__right">
            {jobList.some((j) => j.status === "running") && <span className="wb__jobs mono"><span className="side__spin" /> {jobList.filter((j) => j.status === "running").length} 个任务在跑</span>}
            <button className={`pill ${drawer ? "pill--on" : ""}`} onClick={() => setDrawer((v) => !v)} title="问 Friday（⌘J）">问 Friday <kbd>⌘J</kbd></button>
          </div>
        </header>
        <div className="wb__body">
          {tab === "board" && <Board onDiscuss={discussTask} onOpenThread={(id) => void openThreadById(id)} />}
          {tab === "hot" && (
            <div className="wb__hot">
              <div className="today__head" style={{ border: "none", padding: "0 0 8px" }}>
                <span>AI 热点</span>
                <button className="today__refresh" disabled={hotBusy} onClick={() => void loadHot(true)}>{hotBusy ? "拉取中…" : "重新拉取"}</button>
              </div>
              {hotData ? (
                <>
                  <HotList items={hotData.items} />
                  <div className="today__time">更新于 {fmtTime(hotData.generatedAt)}</div>
                </>
              ) : (
                <div className="chat__empty">{hotBusy ? "正在汇总 HN、HF Papers、OpenAI、Simon Willison、量子位…" : "点「重新拉取」获取。"}</div>
              )}
            </div>
          )}
        </div>
      </div>

      {drawer && (
        <aside className="drawer" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
          <header className="drawer__head">
            <select className="model-select model-select--compact drawer__conv" value={convId ?? ""} onChange={(e) => void load(e.target.value)} title="最近的对话">
              {convId && !list.some((c) => c.id === convId) && <option value={convId}>当前对话</option>}
              {list.slice(0, 12).map((c) => (
                <option key={c.id} value={c.id}>{c.running ? "● " : ""}{c.title.slice(0, 28)}</option>
              ))}
            </select>
            <button className="pill" onClick={() => void startNew()} title="新对话（⌘N）">新对话</button>
            <button
              className={`pill ${skills ? "pill--on" : ""}`}
              disabled={skills === null}
              title="Skill 模式：会话里直接调用本机 skill"
              onClick={() => { const next = !skills; setSkills(next); void updateSettings({ skills: next }); }}
            >
              Skill
            </button>
            <ModelSelect compact value={model} onChange={(m) => { setModel(m); void updateSettings({ model: m }); }} />
            <button className="drawer__close" onClick={() => setDrawer(false)} aria-label="收起">×</button>
          </header>
          <div className="chat__body" ref={bodyRef}>
            {messages.length === 0 && !draft && !busy && (
              <div className="chat__empty">
                <div className="chat__mark">F</div>
                <div className="chat__empty-title">问点什么</div>
                <div className="chat__empty-hint">或者在任务详情里点「在会话里讨论」，我会带着那条任务的上下文过来。</div>
              </div>
            )}
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
                placeholder={busy ? "生成中，Esc 中断" : uploading ? "上传中…" : "问 Friday，可粘贴图片或拖入文件"}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                onPaste={onPaste}
                {...ime.handlers}
                autoFocus
              />
              <button className="composer__send" disabled={busy || uploading > 0 || (!input.trim() && !pending.length)} onClick={() => void send(input)} aria-label="发送">
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" /></svg>
              </button>
            </div>
            <div className="composer__hint">Enter 发送 · Shift+Enter 换行 · ⌘J 收起</div>
          </div>
        </aside>
      )}
    </div>
  );
}
