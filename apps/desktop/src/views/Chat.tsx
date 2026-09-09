import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Attachment, ConversationSummary, HotResponse, Job, Message, ModelId, Task } from "@friday/shared";
import { MODEL_OPTIONS } from "@friday/shared";
import { ask, askSubscribe, cancelAsk, conversationById, conversations, hot, jobs as fetchJobs, newConversation, routeAsk, settings, taskBindConversation, threadById, updateSettings, uploadAttachment } from "../lib/core";
import type { AskEvent, RouteResult } from "../lib/core";
import { ModelSelect } from "./ModelSelect";
import { AssistantBody, AttachmentStrip, HotList, LinkMenuHost, Linkified, decodeSlack, fmtTime } from "./shared";
import { Board } from "./Board";
import type { BoardView } from "./Board";
import { useImeGuard } from "../lib/ime";
import { applyTheme, onThemeChange } from "../lib/theme";

interface OpenPayload {
  conversationId?: string | null;
  initialPrompt?: string | null;
}

type View = BoardView | "hot" | "history";

const KIND: Record<string, string> = { slack: "Slack", meegle: "Meegle", verbal: "口头", doc: "文档", code: "代码", other: "其他" };

const NAV: Array<{ key: View; label: string }> = [
  { key: "queue", label: "待我决定" },
  { key: "doing", label: "Friday 在做" },
  { key: "history", label: "会话历史" },
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
  // 自由对话模式：⌘N 进来的，抽屉不跟任务板走；第一句发出时由 Friday 路由到旧会话或新开
  const [free, setFree] = useState(false);
  const freeRef = useRef(false);
  const [routing, setRouting] = useState(false);
  const [routeHint, setRouteHint] = useState<(RouteResult & { prompt: string }) | null>(null);
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
  freeRef.current = free;

  useEffect(() => {
    void refreshList();
    void loadSettings();
    void invoke<OpenPayload | null>("take_pending_chat").then((p) => { if (p && (p.conversationId || p.initialPrompt)) void openPayload(p); });
    const unlisten = listen<OpenPayload>("friday://open-conversation", (e) => void openPayload(e.payload));
    const stopTheme = onThemeChange(applyTheme);
    return () => {
      void unlisten.then((f) => f());
      stopTheme();
    };
  }, []);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [messages, draft, busy]);

  // 「聚焦终端」：任务板在别的视图时先切回去，Board 挂上后自己去选中那条任务
  useEffect(() => {
    const onFocusJob = () => setView("queue");
    window.addEventListener("friday:focus-job", onFocusJob);
    return () => window.removeEventListener("friday:focus-job", onFocusJob);
  }, []);

  // 窗口常比 sidecar 先起来，第一次拉设置会失败；失败就隔 2 秒再试，否则 Skill / 模型开关会一直是灰的
  async function loadSettings(tries = 20) {
    for (let i = 0; i < tries; i++) {
      try {
        const s = await settings();
        setModel(s.model);
        setSkills(s.skills);
        applyTheme(s.theme);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  const taskRef = useRef<Task | null>(null);

  /** 工作台里展开哪条任务，抽屉就切到哪条任务的会话；没聊过的先空着，第一句话发出去时再建会话并绑定。 */
  function syncDrawerToTask(t: Task | null) {
    if (freeRef.current) return;
    taskRef.current = t;
    if (!t) {
      setConvTask(null);
      return;
    }
    setConvTask({ id: t.id, title: t.title });
    if (t.source.conversationId && t.source.conversationId !== convRef.current) {
      void load(t.source.conversationId).catch(() => {});
    } else if (!t.source.conversationId) {
      abortRef.current?.abort();
      setBusy(false);
      setDraft("");
      setConvId(null);
      convRef.current = null;
      setMessages([]);
    }
  }

  async function taskContext(t: Task): Promise<string[]> {
    const thread = t.source.threadId ? await threadById(t.source.threadId).catch(() => null) : null;
    const raw = thread?.items.map((i) => `${i.userName}：${decodeSlack(i.text)}（${i.permalink}）`).join("\n").slice(0, 1500);
    return [
      `这条任务：${t.title}`,
      `来源：${KIND[t.kind] ?? t.kind}${t.project ? ` · 项目 ${t.project}` : ""}${t.source.meegleId ? ` · Meegle #${t.source.meegleId}` : ""}`,
      t.source.note ? `我交代的原话：${t.source.note}` : "",
      t.source.url ? `我给的链接：${t.source.url}（需要的话直接读它）` : "",
      raw ? `Slack 原文：\n${raw}` : "",
      t.understanding ? `你的理解：${t.understanding}` : "",
      t.plan ? `你的方案：${t.plan}` : "",
      t.progress ? `进展：${t.progress}` : "",
      t.report ? `交付报告概要：${t.report.summary}；测试结果：${t.report.testResult}` : "",
      t.pending?.length ? `等我点头的动作：${t.pending.map((p) => p.label).join("、")}` : "",
    ].filter(Boolean);
  }

  /** 给任务开一段新会话并绑定到任务上。 */
  async function openTaskConversation(t: Task): Promise<string> {
    const conv = await newConversation();
    setConvId(conv.id);
    convRef.current = conv.id;
    setMessages([]);
    void taskBindConversation(t.id, conv.id).then(() => window.dispatchEvent(new Event("friday:tasks-changed"))).catch(() => {});
    return conv.id;
  }

  function discussTask(t: Task) {
    setDrawer(true);
    setFree(false);
    freeRef.current = false;
    setRouteHint(null);
    syncDrawerToTask(t);
    void (async () => {
      if (t.source.conversationId) {
        setTimeout(() => inputRef.current?.focus(), 0);
        return;
      }
      const id = await openTaskConversation(t);
      const lines = [...(await taskContext(t)), "先说你的判断，我有疑问会问。"];
      void send(lines.join("\n"), id);
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
    setFree(true);
    freeRef.current = true;
    setRouteHint(null);
    setConvTask(null);
    taskRef.current = null;
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

  /** ⌘N：抽屉弹出但先不建会话，等第一句话出来再由 Friday 决定接旧还是开新。 */
  function openFree() {
    setDrawer(true);
    setFree(true);
    freeRef.current = true;
    setConvTask(null);
    taskRef.current = null;
    setRouteHint(null);
    abortRef.current?.abort();
    setBusy(false);
    setDraft("");
    setConvId(null);
    convRef.current = null;
    setMessages([]);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  /** 路由判断错了：换一段新会话，把刚才那句重新发过去。 */
  async function redoAsNew() {
    const hint = routeHint;
    if (!hint) return;
    if (convRef.current) void cancelAsk(convRef.current);
    abortRef.current?.abort();
    setBusy(false);
    setDraft("");
    setRouteHint(null);
    const conv = await newConversation();
    setConvId(conv.id);
    convRef.current = conv.id;
    setMessages([]);
    void send(hint.prompt, conv.id);
  }

  function push(m: Omit<Message, "id" | "createdAt">) {
    setMessages((ms) => [...ms, local(m)]);
  }

  async function send(text: string, id = convRef.current) {
    let prompt = text.trim() || (pending.length ? "看看这些附件" : "");
    if (!prompt || busy || uploading > 0) return;
    if (!id && taskRef.current) {
      const t = taskRef.current;
      id = await openTaskConversation(t);
      prompt = [...(await taskContext(t)), "", prompt].join("\n");
    } else if (!id && freeRef.current) {
      setRouting(true);
      const r = await routeAsk(prompt).catch((): RouteResult => ({ why: "路由失败，新开一段" }));
      setRouting(false);
      if (r.conversationId) {
        await load(r.conversationId).catch(() => {});
        id = convRef.current;
      }
      if (!id) {
        const conv = await newConversation();
        setConvId(conv.id);
        convRef.current = conv.id;
        setMessages([]);
        id = conv.id;
      }
      setRouteHint(r.conversationId && id === r.conversationId ? { ...r, prompt } : null);
    }
    if (!id) return;
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
    if (e.key === "Escape") {
      if (busy) interrupt();
      else setDrawer(false);
    }
  }

  function go(v: View) {
    setView(v);
    if (v === "history") void refreshList();
    if (v === "hot" && !hotData) void loadHot();
    setRailHover(false);
  }

  useEffect(() => {
    function onGlobalKey(e: KeyboardEvent) {
      if (!e.metaKey) return;
      if (e.key === "n" && !e.shiftKey) {
        e.preventDefault();
        openFree();
      } else if ((e.key === "N" || e.key === "n") && e.shiftKey) {
        e.preventDefault();
        void startNew();
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
  const convTitle = convId ? (list.find((c) => c.id === convId)?.title ?? "当前对话") : "新话题 · 发出后判断";

  /** 从「会话历史」点开一段旧会话：自由对话模式，不跟任务板走 */
  function openHistory(id: string) {
    setDrawer(true);
    setFree(true);
    freeRef.current = true;
    setRouteHint(null);
    setConvTask(null);
    taskRef.current = null;
    void load(id);
  }
  const modelLabel = MODEL_OPTIONS.find((m) => m.id === model)?.label ?? "";
  const railOpen = railPinned || railHover;

  const tools = (
    <>
      <button className="b b--ghost" onClick={openFree}>问 Friday<kbd>⌘N</kbd></button>
    </>
  );

  return (
    <div className={`chat ${drawer ? "chat--drawer" : ""}`}>
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
          <button className="b b--ghost" onClick={openFree}>问 Friday<kbd>⌘N</kbd></button>
          <div className="rail__status">
            {running > 0 && <><span className="side__spin" />{running} 个任务在跑 · </>}
            {modelLabel || "跟随 Claude Code"} · ⌘\ 固定
          </div>
        </div>
      </nav>

      <div className="wb">
        {view === "history" ? (
          <>
            <header className="q__head" data-tauri-drag-region>
              <div className="q__row" data-tauri-drag-region>
                <div className="q__title" data-tauri-drag-region>
                  <h1 data-tauri-drag-region>会话历史</h1>
                  <span className="q__count">{list.length} 段</span>
                </div>
                <div className="q__tools">{tools}</div>
              </div>
            </header>
            <div className="wb__scroll">
              <div className="wb__page">
                {list.length === 0 ? (
                  <div className="empty"><strong>还没有会话</strong>⌘N 问 Friday 一句就有了。</div>
                ) : (
                  <div className="list">
                    {list.map((c) => (
                      <button key={c.id} className={`row row--compact ${c.id === convId ? "row--on" : ""}`} onClick={() => openHistory(c.id)}>
                        <span className={`dot ${c.running ? "dot--processing" : ""}`} />
                        <span className="row__main">
                          <div className="row__title">{c.title}</div>
                        </span>
                        <span className="row__right row__right--dim">{c.running ? "生成中 · " : ""}{c.messageCount} 条 · {fmtTime(c.updatedAt)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </>
        ) : view === "hot" ? (
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
          <Board view={view} tools={tools} onDiscuss={discussTask} onCounts={setCounts} onFocusChange={syncDrawerToTask} />
        )}
      </div>

      {drawer && (
        <aside className="drawer" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
          <header className="drawer__head" data-tauri-drag-region>
            {convTask ? (
              <span className="drawer__task" title={convTask.title}><span className="dot dot--processing" />{convTask.title}</span>
            ) : (
            <span className="drawer__task" title={convTitle}>{convTitle}</span>
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
          {routeHint?.conversationId && (
            <div className="drawer__route">
              <span className="drawer__route-text" title={routeHint.why}>接着：{routeHint.title?.slice(0, 24)} · {routeHint.why}</span>
              <button className="b b--text" onClick={() => void redoAsNew()}>其实是新话题</button>
            </div>
          )}
          <div className="chat__body" ref={bodyRef}>
            {messages.length === 0 && !draft && !busy && !routing && (
              <div className="chat__empty">
                <div className="chat__mark">F</div>
                <div className="chat__empty-title">{convTask ? "关于这条任务，直接问" : free ? "说吧" : "问点什么"}</div>
                <div className="chat__empty-hint">{convTask ? `我会带着「${convTask.title.slice(0, 30)}」的情境、链接和原文来回答。` : free ? "问题直接答；要干的活我先说判断，你点头我再开工。接着之前的话题说也行，我会认出来。" : "工作台里展开哪条任务，这里就跟到哪条。"}</div>
              </div>
            )}
            {routing && <div className="drawer__routing"><span className="side__spin" />正在看这是不是接着之前聊的…</div>}
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
            <div className="composer__hint">Enter 发送 · Shift+Enter 换行 · Esc 收起 · ⌘⇧N 直接开新对话</div>
          </div>
        </aside>
      )}
    </div>
  );
}
