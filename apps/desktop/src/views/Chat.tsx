import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ConversationSummary, HotResponse, ModelId } from "@friday/shared";
import { MODEL_OPTIONS } from "@friday/shared";
import { cancelAsk, conversations, hot, newConversation, routeAsk, settings, updateSettings } from "../lib/core";
import type { RouteResult } from "../lib/core";
import { ModelSelect } from "./ModelSelect";
import { HotList, LinkMenuHost, fmtTime } from "./shared";
import { Board } from "./Board";
import type { BoardView } from "./Board";
import { Thread } from "./Thread";
import type { ThreadHandle } from "./Thread";
import { applyTheme, onThemeChange } from "../lib/theme";

interface OpenPayload {
  conversationId?: string | null;
  initialPrompt?: string | null;
}

type View = BoardView | "hot" | "history" | "ask";

const NAV: Array<{ key: View; label: string; kbd?: string }> = [
  { key: "ask", label: "问 Friday", kbd: "⌘N" },
  { key: "queue", label: "待我决定" },
  { key: "doing", label: "Friday 在做" },
  { key: "history", label: "会话历史" },
  { key: "all", label: "全部任务" },
  { key: "ledger", label: "操作记录" },
  { key: "hot", label: "AI 热点" },
];

/** 进入「问 Friday」视图时要做的事：Thread 挂上之后再执行 */
type PendingOpen = { kind: "reset" } | { kind: "load"; id: string; prompt?: string };

export function Chat() {
  const [list, setList] = useState<ConversationSummary[]>([]);
  const [view, setView] = useState<View>("queue");
  // 导航栏固定在左侧；⌘\ 收起 / 展开，记在本机
  const [railOpen, setRailOpen] = useState(() => { try { return localStorage.getItem("friday:rail") !== "0"; } catch { return true; } });
  const [counts, setCounts] = useState({ decide: 0, doing: 0 });
  const [hotData, setHotData] = useState<HotResponse | null>(null);
  const [hotBusy, setHotBusy] = useState(false);
  const [model, setModel] = useState<ModelId | null>(null);
  const [skills, setSkills] = useState<boolean | null>(null);
  // 「问 Friday」视图：当前会话、路由提示
  const [askConv, setAskConv] = useState<string | null>(null);
  const [routeHint, setRouteHint] = useState<(RouteResult & { prompt: string }) | null>(null);
  const threadRef = useRef<ThreadHandle>(null);
  const pendingOpen = useRef<PendingOpen | null>(null);

  useEffect(() => {
    void refreshList();
    void loadSettings();
    void invoke<OpenPayload | null>("take_pending_chat").then((p) => { if (p && (p.conversationId || p.initialPrompt)) void openPayload(p); });
    const unlisten = listen<OpenPayload>("friday://open-conversation", (e) => void openPayload(e.payload));
    const stopTheme = onThemeChange(applyTheme);
    // 「聚焦终端」：任务板在别的视图时先切回去，Board 挂上后自己去选中那条任务
    const onFocusJob = () => setView("queue");
    window.addEventListener("friday:focus-job", onFocusJob);
    return () => {
      void unlisten.then((f) => f());
      stopTheme();
      window.removeEventListener("friday:focus-job", onFocusJob);
    };
  }, []);

  // Thread 只在「问 Friday」视图里挂着；切过去之后再执行排队的动作
  useEffect(() => {
    if (view !== "ask") return;
    const p = pendingOpen.current;
    pendingOpen.current = null;
    const t = threadRef.current;
    if (!t) return;
    if (!p) {
      t.focus();
      return;
    }
    if (p.kind === "reset") {
      t.reset();
      setRouteHint(null);
      t.focus();
      return;
    }
    void t.load(p.id).then(() => {
      if (p.prompt) void t.send(p.prompt, p.id);
      else t.focus();
    });
  }, [view]);

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

  function openAsk(p: PendingOpen) {
    pendingOpen.current = p;
    if (view === "ask") {
      // 已经在这个视图，effect 不会再跑，直接做
      const t = threadRef.current;
      pendingOpen.current = null;
      if (!t) return;
      if (p.kind === "reset") {
        t.reset();
        setRouteHint(null);
        t.focus();
      } else {
        void t.load(p.id).then(() => (p.prompt ? t.send(p.prompt, p.id) : t.focus()));
      }
      return;
    }
    setView("ask");
  }

  async function openPayload(p: OpenPayload) {
    const id = p.conversationId ?? (await newConversation()).id;
    openAsk({ kind: "load", id, ...(p.initialPrompt ? { prompt: p.initialPrompt } : {}) });
  }

  /** ⌘N：进「问 Friday」，先不建会话，第一句发出时由 Friday 决定接旧还是开新 */
  function openFree() {
    openAsk({ kind: "reset" });
  }

  /** ⌘⇧N：明确要一段新会话 */
  async function startNew() {
    const conv = await newConversation();
    setRouteHint(null);
    openAsk({ kind: "load", id: conv.id });
  }

  /** 自由对话的第一句：问 Friday 这是接着哪段说的，还是新话题 */
  async function resolveFree(prompt: string) {
    const r = await routeAsk(prompt).catch((): RouteResult => ({ why: "路由失败，新开一段" }));
    const id = r.conversationId ?? (await newConversation()).id;
    setRouteHint(r.conversationId ? { ...r, prompt } : null);
    return { id, prompt };
  }

  /** 路由判断错了：换一段新会话，把刚才那句重新发过去 */
  async function redoAsNew() {
    const hint = routeHint;
    const t = threadRef.current;
    if (!hint || !t) return;
    if (askConv) void cancelAsk(askConv);
    setRouteHint(null);
    const conv = await newConversation();
    await t.load(conv.id);
    void t.send(hint.prompt, conv.id);
  }

  async function loadHot(refresh = false) {
    setHotBusy(true);
    try {
      setHotData(await hot(new AbortController().signal, refresh));
    } finally {
      setHotBusy(false);
    }
  }

  function go(v: View) {
    if (v === "ask") {
      openAsk(askConv ? { kind: "load", id: askConv } : { kind: "reset" });
      return;
    }
    setView(v);
    if (v === "history") void refreshList();
    if (v === "hot" && !hotData) void loadHot();
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
        setRailOpen((v) => { try { localStorage.setItem("friday:rail", v ? "0" : "1"); } catch {} return !v; });
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
  }, [view]);

  const modelLabel = MODEL_OPTIONS.find((m) => m.id === model)?.label ?? "";
  const askTitle = askConv ? (list.find((c) => c.id === askConv)?.title ?? "当前对话") : "新话题 · 发出后判断";

  const tools = <button className="b b--ghost" onClick={openFree}>问 Friday<kbd>⌘N</kbd></button>;

  const head = (title: string, count: React.ReactNode, right: React.ReactNode) => (
    <header className="q__head" data-tauri-drag-region>
      <div className="q__row" data-tauri-drag-region>
        <div className="q__title" data-tauri-drag-region>
          <h1 data-tauri-drag-region>{title}</h1>
          {count}
        </div>
        <div className="q__tools">{right}</div>
      </div>
    </header>
  );

  return (
    <div className={`chat ${railOpen ? "" : "chat--norail"}`}>
      <LinkMenuHost />
      <nav className={`rail ${railOpen ? "" : "rail--hidden"}`}>
        <div className="rail__brand">Friday</div>
        {NAV.map((n) => (
          <button key={n.key} className={`rail__item ${view === n.key ? "on" : ""}`} onClick={() => go(n.key)}>
            {n.key === "queue" && <span className="dot dot--decide" />}
            {n.key === "doing" && <span className={`dot ${counts.doing ? "dot--processing" : ""}`} />}
            {n.label}
            {n.key === "queue" && counts.decide > 0 && <span className="mono amber">{counts.decide}</span>}
            {n.key === "doing" && counts.doing > 0 && <span className="mono">{counts.doing}</span>}
            {n.kbd && <span className="mono rail__kbd">{n.kbd}</span>}
          </button>
        ))}
        <div className="rail__foot">
          <div className="rail__status">
            {modelLabel || "跟随 Claude Code"} · ⌘\ 收起
          </div>
        </div>
      </nav>

      <div className="wb">
        {view === "ask" ? (
          <>
            {head(
              "问 Friday",
              <span className="q__count q__count--ellipsis" title={askTitle}>{askTitle}</span>,
              <>
                <button className="pill" onClick={() => void startNew()} title="新对话（⌘⇧N）">新对话<kbd>⌘⇧N</kbd></button>
                <button
                  className={`pill ${skills ? "pill--on" : ""}`}
                  disabled={skills === null}
                  title="Skill 模式：会话里直接调用本机 skill"
                  onClick={() => { const next = !skills; setSkills(next); void updateSettings({ skills: next }); }}
                >
                  Skill
                </button>
                <ModelSelect compact value={model} onChange={(m) => { setModel(m); void updateSettings({ model: m }); }} />
              </>,
            )}
            <div className="ask">
              <Thread
                ref={threadRef}
                conversationId={null}
                resolve={resolveFree}
                resolvingText="正在看这是不是接着之前聊的…"
                onConversation={(id) => { setAskConv(id); void refreshList(); }}
                emptyTitle="说吧"
                emptyHint="问题直接答；要干的活我先说判断，你点头我再开工。接着之前的话题说也行，我会认出来。关于某条任务的事，去任务卡里说。"
                hint="Enter 发送 · Shift+Enter 换行 · Esc 回工作台 · ⌘⇧N 直接开新对话"
                onEscape={() => go("queue")}
                autoFocus
                banner={
                  routeHint?.conversationId ? (
                    <div className="route-hint">
                      <span className="route-hint__text" title={routeHint.why}>接着：{routeHint.title?.slice(0, 24)} · {routeHint.why}</span>
                      <button className="b b--text" onClick={() => void redoAsNew()}>其实是新话题</button>
                    </div>
                  ) : null
                }
              />
            </div>
          </>
        ) : view === "history" ? (
          <>
            {head("会话历史", <span className="q__count">{list.length} 段</span>, tools)}
            <div className="wb__scroll">
              <div className="wb__page">
                {list.length === 0 ? (
                  <div className="empty"><strong>还没有会话</strong>⌘N 问 Friday 一句就有了。</div>
                ) : (
                  <div className="list">
                    {list.map((c) => (
                      <button key={c.id} className={`row row--compact ${c.id === askConv ? "row--on" : ""}`} onClick={() => openAsk({ kind: "load", id: c.id })}>
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
            {head(
              "AI 热点",
              hotData && <span className="q__count">更新于 {fmtTime(hotData.generatedAt)}</span>,
              <button className="b b--ghost" disabled={hotBusy} onClick={() => void loadHot(true)}>{hotBusy ? "拉取中…" : "重新拉取"}</button>,
            )}
            <div className="wb__scroll">
              <div className="wb__page hot__page">
                {hotData ? <HotList items={hotData.items} /> : <div className="empty">{hotBusy ? "正在汇总 HN、HF Papers、OpenAI、Simon Willison、量子位…" : "点「重新拉取」获取。"}</div>}
              </div>
            </div>
          </>
        ) : (
          <Board view={view} tools={tools} onCounts={setCounts} />
        )}
      </div>
    </div>
  );
}
