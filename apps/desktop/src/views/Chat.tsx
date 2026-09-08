import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Attachment, ConversationSummary, HotResponse, Job, Message, ModelId, Task } from "@friday/shared";
import { MODEL_OPTIONS } from "@friday/shared";
import { ask, askSubscribe, cancelAsk, conversationById, conversations, hot, jobs as fetchJobs, newConversation, settings, taskBindConversation, threadById, updateSettings, uploadAttachment } from "../lib/core";
import type { AskEvent } from "../lib/core";
import { ModelSelect } from "./ModelSelect";
import { AssistantBody, AttachmentStrip, HotList, LinkMenuHost, Linkified, decodeSlack, fmtTime } from "./shared";
import { Board } from "./Board";
import type { BoardView } from "./Board";
import { useImeGuard } from "../lib/ime";

interface OpenPayload {
  conversationId?: string | null;
  initialPrompt?: string | null;
}

type View = BoardView | "hot";

const KIND: Record<string, string> = { slack: "Slack", meegle: "Meegle", verbal: "口头", doc: "文档", code: "代码", other: "其他" };

const NAV: Array<{ key: View; label: string }> = [
  { key: "queue", label: "待我决定" },
  { key: "doing", label: "Friday 在做" },
  { key: "all", label: "全部任务" },
  { key: "ledger", label: "操作记录" },
  { key: "hot", label: "AI 热点" },
];

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
  const [convTask, setConvTask] = useState<{ id: string; title: string } | null>(null);
  const [view, setView] = useState<View>("queue");
  const [railHover, setRailHover] = useState(false);
  const [railPinned, setRailPinned] = useState(false);
  const [counts, setCounts] = useState({ decide: 0, doing: 0 });
  const [newTaskSignal, setNewTaskSignal] = useState(0);
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
  const railTimer = useRef<number | null>(null);
  const ime = useImeGuard();
  convRef.current = convId;

  useEffect(() => {
    void refreshList();
    void loadSettings();
    void invoke<OpenPayload | null>("take_pending_chat").then((p) => { if (p && (p.conversationId || p.initialPrompt)) void openPayload(p); });
    const unlisten = listen<OpenPayload>("friday://open-conversation", (e) => void openPayload(e.payload));
    return () => void unlisten.then((f) => f());
  }, []);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [messages, draft, busy]);

  // 窗口常比 sidecar 先起来，第一次拉设置会失败；失败就隔 2 秒再试，否则 Skill / 模型开关会一直是灰的
  async function loadSettings(tries = 20) {
    for (let i = 0; i < tries; i++) {
      try {
        const s = await settings();
        setModel(s.model);
        setSkills(s.skills);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  function discussTask(t: Task) {
    setDrawer(true);
    setConvTask({ id: t.id, title: t.title });
    void (async () => {
      if (t.source.conversationId) {
        // 这条任务已经聊过：接着上次的会话，不再新开
        try {
          await load(t.source.conversationId);
          setTimeout(() => inputRef.current?.focus(), 0);
          return;
        } catch {
          // 会话被删了就重新开一个
        }
      }
      const conv = await newConversation();
      setConvId(conv.id);
      convRef.current = conv.id;
      setMessages([]);
      void taskBindConversation(t.id, conv.id).then(() => window.dispatchEvent(new Event("friday:tasks-changed"))).catch(() => {});
      const thread = t.source.threadId ? await threadById(t.source.threadId).catch(() => null) : null;
      const raw = thread?.items.map((i) => `${i.userName}：${decodeSlack(i.text)}（${i.permalink}）`).join("\n").slice(0, 1500);
      const lines = [
        `和我讨论这个任务：${t.title}`,
        `来源：${KIND[t.kind] ?? t.kind}${t.project ? ` · 项目 ${t.project}` : ""}${t.source.meegleId ? ` · Meegle #${t.source.meegleId}` : ""}`,
        t.source.note ? `我交代的原话：${t.source.note}` : "",
        t.source.url ? `我给的链接：${t.source.url}（需要的话直接读它）` : "",
        raw ? `Slack 原文：\n${raw}` : "",
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

  useEffect(() => {
    const load = () => void fetchJobs().then(setJobList).catch(() => {});
    load();
    const t = setInterval(load, jobList.some((j) => j.status === "running") ? 5000 : 30000);
    return () => clearInterval(t);
  }, [jobList.some((j) => j.status === "running")]);

  useEffect(() => {
    if (!list.some((c) => c.running)) return;
    const t = setInterval(() => void refreshList(), 5000);
    return () => clearInterval(t);
  }, [list]);

  async function refreshList() {
    try {
      setList(await conversations());
    } catch {
    }
  }

  async function openPayload(p: OpenPayload) {
    setDrawer(true);
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
    convRef.current = conv.id;
    setMessages(conv.messages);
    if (conv.running) void follow(conv.id, askSubscribe(conv.id, newSubscription()));
  }

  function newSubscription(): AbortSignal {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    return ctrl.signal;
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
    void refreshList();
  }

  async function startNew() {
    setDrawer(true);
    setConvTask(null);
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

  async function openDrawer() {
    setDrawer(true);
    if (!convRef.current) {
      const conv = await newConversation();
      setConvId(conv.id);
      convRef.current = conv.id;
      setMessages([]);
    }
    setTimeout(() => inputRef.current?.focus(), 0);
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

  function newTask() {
    setView("queue");
    setNewTaskSignal((n) => n + 1);
  }

  function go(v: View) {
    setView(v);
    if (v === "hot" && !hotData) void loadHot();
    setRailHover(false);
  }

  useEffect(() => {
    function onGlobalKey(e: KeyboardEvent) {
      if (!e.metaKey) return;
      if (e.key === "n" && !e.shiftKey) {
        e.preventDefault();
        newTask();
      } else if ((e.key === "N" || e.key === "n") && e.shiftKey) {
        e.preventDefault();
        void startNew();
      } else if (e.key === "j") {
        e.preventDefault();
        if (drawer) setDrawer(false);
        else void openDrawer();
      } else if (e.key === "\\") {
        e.preventDefault();
        setRailPinned((v) => !v);
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
  }, [drawer]);

  function railEnter() {
    if (railTimer.current) window.clearTimeout(railTimer.current);
    setRailHover(true);
  }
  function railLeave() {
    if (railTimer.current) window.clearTimeout(railTimer.current);
    railTimer.current = window.setTimeout(() => setRailHover(false), 260);
  }

  const running = jobList.filter((j) => j.status === "running").length;
  const modelLabel = MODEL_OPTIONS.find((m) => m.id === model)?.label ?? "";
  const railOpen = railPinned || railHover;

  const tools = (
    <>
      <button className="b b--text" onClick={() => (drawer ? setDrawer(false) : void openDrawer())}>问 Friday<kbd>⌘J</kbd></button>
      <button className="b b--ghost" onClick={newTask}>＋ 交代一件事<kbd>⌘N</kbd></button>
    </>
  );

  return (
    <div className="chat">
      <LinkMenuHost />
      <div className="edge" onMouseEnter={railEnter} />
      <nav className={`rail ${railOpen ? "rail--open" : ""}`} onMouseEnter={railEnter} onMouseLeave={railLeave}>
        <div className="rail__brand">Friday</div>
        {NAV.map((n) => (
          <button key={n.key} className={`rail__item ${view === n.key ? "on" : ""}`} onClick={() => go(n.key)}>
            {n.key === "queue" && <span className="dot dot--decide" />}
            {n.key === "doing" && <span className={`dot ${counts.doing ? "dot--processing" : ""}`} />}
            {n.label}
            {n.key === "queue" && counts.decide > 0 && <span className="mono amber">{counts.decide}</span>}
            {n.key === "doing" && counts.doing > 0 && <span className="mono">{counts.doing}</span>}
          </button>
        ))}
        <div className="rail__foot">
          <button className="b b--ghost" onClick={newTask}>交代一件事<kbd>⌘N</kbd></button>
          <button className="rail__row b b--text" style={{ padding: "0 8px" }} onClick={() => void openDrawer()}>问 Friday<kbd>⌘J</kbd></button>
          <div className="rail__status">
            {running > 0 && <><span className="side__spin" />{running} 个任务在跑 · </>}
            {modelLabel || "跟随 Claude Code"} · ⌘\ 固定
          </div>
        </div>
      </nav>

      <div className="wb">
        {view === "hot" ? (
          <>
            <header className="q__head" data-tauri-drag-region>
              <div className="q__row" data-tauri-drag-region>
                <div className="q__title" data-tauri-drag-region>
                  <h1 data-tauri-drag-region>AI 热点</h1>
                  {hotData && <span className="q__count">更新于 {fmtTime(hotData.generatedAt)}</span>}
                </div>
                <div className="q__tools">
                  <button className="b b--ghost" disabled={hotBusy} onClick={() => void loadHot(true)}>{hotBusy ? "拉取中…" : "重新拉取"}</button>
                </div>
              </div>
            </header>
            <div className="wb__scroll">
              <div className="wb__page hot__page">
                {hotData ? <HotList items={hotData.items} /> : <div className="empty">{hotBusy ? "正在汇总 HN、HF Papers、OpenAI、Simon Willison、量子位…" : "点「重新拉取」获取。"}</div>}
              </div>
            </div>
          </>
        ) : (
          <Board view={view} tools={tools} newTaskSignal={newTaskSignal} onDiscuss={discussTask} onCounts={setCounts} />
        )}
      </div>

      {drawer && (
        <aside className="drawer" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
          <header className="drawer__head">
            {convTask ? (
              <span className="drawer__task" title={convTask.title}><span className="dot dot--processing" />{convTask.title}</span>
            ) : (
            <select className="model-select model-select--compact drawer__conv" value={convId ?? ""} onChange={(e) => { setConvTask(null); void load(e.target.value); }} title="最近的对话">
              {convId && !list.some((c) => c.id === convId) && <option value={convId}>当前对话</option>}
              {list.slice(0, 12).map((c) => (
                <option key={c.id} value={c.id}>{c.running ? "● " : ""}{c.title.slice(0, 28)}</option>
              ))}
            </select>
            )}
            {!convTask && <button className="pill" onClick={() => void startNew()} title="新对话（⌘⇧N）">新对话</button>}
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
                <div className="chat__empty-hint">或者在任务里点「在会话里讨论」，我会带着那条任务的上下文过来。</div>
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
            <div className="composer__hint">Enter 发送 · Shift+Enter 换行 · ⌘J 收起 · ⌘⇧N 新对话</div>
          </div>
        </aside>
      )}
    </div>
  );
}
