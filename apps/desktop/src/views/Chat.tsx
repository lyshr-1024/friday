import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ConversationSummary, ModelId, Task } from "@friday/shared";
import { MODEL_OPTIONS } from "@friday/shared";
import { conversations, coreBaseUrl, jobsSweep, mainConversation, mainPresence, routines, settings, updateSettings } from "../lib/core";
import { ModelSelect } from "./ModelSelect";
import { LinkMenuHost, fmtTime } from "./shared";
import { MoreMenu } from "./TaskDialog";
import { Projects } from "./Projects";
import { TerminalsMenu } from "./TerminalsMenu";
import { LearnDialog, ScheduleDialog, WeeklyDialog, openReviews, openWeekly, type Routine } from "./Routines";
import { Board } from "./Board";
import { Search } from "./Search";
import type { BoardRequest, BoardView } from "./Board";
import { UsageStrip } from "./Usage";
import { Needs } from "./Needs";
import { Thread } from "./Thread";
import type { ThreadHandle } from "./Thread";
import { applyBackground, applyTheme, onBackgroundChange, onThemeChange } from "../lib/theme";
import { connectEvents } from "../lib/events";
import type { FridayEvent } from "../lib/events";

interface OpenPayload {
  conversationId?: string | null;
  initialPrompt?: string | null;
  /** 点开系统通知：选中这条任务 */
  taskId?: string | null;
}

type View = BoardView | "history" | "ask" | "projects";

/* 顶栏三个区域：会话、任务、项目。会话历史、操作记录、设置、同步、新建都收进右上「···」 */
const NAV: Array<{ key: View; label: string; kbd?: string }> = [
  { key: "ask", label: "会话", kbd: "⌘N" },
  { key: "queue", label: "任务" },
  { key: "projects", label: "项目" },
];

export function Chat() {
  const [list, setList] = useState<ConversationSummary[]>([]);
  const [view, setView] = useState<View>("queue");
  // 导航栏固定在左侧；⌘\ 收起 / 展开，记在本机
  const [model, setModel] = useState<ModelId | null>(null);
  const [skills, setSkills] = useState<boolean | null>(null);
  // 主对话 id；会话历史里点开的旧会话 id（只读）
  const [mainId, setMainId] = useState<string | null>(null);
  const [mainFailed, setMainFailed] = useState(false);
  const [histConv, setHistConv] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [boardReq, setBoardReq] = useState<BoardRequest | null>(null);
  const threadRef = useRef<ThreadHandle>(null);
  const pendingPrompt = useRef<string | null>(null);
  // 要选中的任务：等切到任务视图、Board 挂上并开始监听之后再发（子组件的 effect 先于这里执行）
  const [openingTask, setOpeningTask] = useState<{ id: string } | null>(null);
  // 周报和学习不进任务列表，在「···」里各开一个弹窗；菜单上带着有没有要你处理的
  const [routine, setRoutine] = useState<Routine | null>(null);
  const [routineTasks, setRoutineTasks] = useState<{ weekly: Task[]; learn: Task[] }>({ weekly: [], learn: [] });
  const pullRoutines = () => routines().then((r) => { setRoutineTasks(r); return r; });
  useEffect(() => {
    void pullRoutines().catch(() => {});
    let timer = 0;
    const onChange = () => { window.clearTimeout(timer); timer = window.setTimeout(() => void pullRoutines().catch(() => {}), 300); };
    window.addEventListener("friday:tasks-changed", onChange);
    return () => { window.clearTimeout(timer); window.removeEventListener("friday:tasks-changed", onChange); };
  }, []);
  useEffect(() => {
    if (openingTask) window.dispatchEvent(new CustomEvent("friday:open-task", { detail: openingTask.id }));
  }, [openingTask]);

  useEffect(() => {
    void refreshList();
    void loadSettings();
    void loadMain();
    void invoke<OpenPayload | null>("take_pending_chat").then((p) => { if (p && (p.conversationId || p.initialPrompt || p.taskId)) void openPayload(p); });
    const unlisten = listen<OpenPayload>("friday://open-conversation", (e) => void openPayload(e.payload));
    const stopTheme = onThemeChange(applyTheme);
    const stopBg = onBackgroundChange((p) => { void coreBaseUrl().then((url) => applyBackground(p, url)); });
    // 「聚焦终端」：任务板在别的视图时先切回去，Board 挂上后自己去选中那条任务
    const onFocusJob = () => setView("queue");
    window.addEventListener("friday:focus-job", onFocusJob);
    // 回到工作台时问一遍终端还在不在：你 ⌘W 关掉窗口没有任何回调，
    // 不问就一直显示着在跑。收掉的会走 SSE 推回来，这里不用管返回值。
    const onWindowFocus = () => { void jobsSweep(); void mainPresence(true).catch(() => {}); };
    const onWindowBlur = () => { void mainPresence(false).catch(() => {}); };
    window.addEventListener("focus", onWindowFocus);
    window.addEventListener("blur", onWindowBlur);
    const stopEvents = connectEvents();
    // 会话生成开始 / 结束：左栏青条要立刻变
    const onEvent = (e: Event) => { if ((e as CustomEvent<FridayEvent>).detail.type === "conversation") void refreshList(); };
    window.addEventListener("friday:event", onEvent);
    return () => {
      void unlisten.then((f) => f());
      stopTheme();
      stopBg();
      stopEvents();
      window.removeEventListener("friday:focus-job", onFocusJob);
      window.removeEventListener("focus", onWindowFocus);
      window.removeEventListener("blur", onWindowBlur);
      window.removeEventListener("friday:event", onEvent);
    };
  }, []);

  // Thread 只在主对话视图里挂着；切过去之后再把排队的话发出去
  useEffect(() => {
    if (view !== "ask" || !mainId) return;
    const prompt = pendingPrompt.current;
    pendingPrompt.current = null;
    const t = threadRef.current;
    if (!t) return;
    if (prompt) void t.load(mainId).then(() => t.send(prompt, mainId));
    else t.focus();
  }, [view, mainId]);

  // 先隔 2 秒试 20 次；还连不上就提示，并在后台每 10 秒继续试，后台起来后自己恢复
  async function loadMain() {
    for (let i = 0; ; i++) {
      try {
        const { id } = await mainConversation();
        setMainId(id);
        setMainFailed(false);
        return;
      } catch {
        if (i >= 20) setMainFailed(true);
        await new Promise((r) => setTimeout(r, i >= 20 ? 10000 : 2000));
      }
    }
  }

  // 窗口常比 sidecar 先起来，第一次拉设置会失败；失败就隔 2 秒再试，否则 Skill / 模型开关会一直是灰的
  async function loadSettings(tries = 20) {
    for (let i = 0; i < tries; i++) {
      try {
        const s = await settings();
        setModel(s.model);
        setSkills(s.skills);
        applyTheme(s.theme);
        applyBackground(s, await coreBaseUrl());
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  // 变更由 /events 推过来；这里只是兜底
  useEffect(() => {
    const t = setInterval(() => void refreshList(), 30000);
    return () => clearInterval(t);
  }, []);
  const runningConvs = useMemo(() => new Set(list.filter((c) => c.running).map((c) => c.id)), [list]);

  /** 终端列表里点了项目的 Claude / 终端：切到项目页并选中它 */
  function openProject(name: string) {
    try {
      localStorage.setItem("friday:project", name);
    } catch {}
    setView("projects");
    window.dispatchEvent(new CustomEvent("friday:pick-project", { detail: name }));
  }

  async function refreshList() {
    try {
      setList(await conversations());
    } catch {
    }
  }

  function openMain(prompt?: string) {
    // 主对话 id 还没到：话先留着，id 到了由 view/mainId 的 effect 发出
    if (prompt || view !== "ask") pendingPrompt.current = prompt ?? pendingPrompt.current;
    if (view === "ask") {
      if (!mainId) return;
      const t = threadRef.current;
      pendingPrompt.current = null;
      if (!t) return;
      if (prompt) void t.load(mainId).then(() => t.send(prompt, mainId));
      else t.focus();
      return;
    }
    setView("ask");
  }

  /** 老会话只读地看：主对话回主视图，其余进会话历史 */
  function openConversation(id: string) {
    if (id === mainId) return openMain();
    setHistConv(id);
    setView("history");
  }

  async function openPayload(p: OpenPayload) {
    if (p.taskId) return openTask(p.taskId);
    // 拿不到主对话 id（后台没起来）时，带 conversationId 的当主对话处理，不落进只读历史
    const id = await mainConversation().then((m) => { setMainId(m.id); return m.id; }).catch(() => null);
    if (id && p.conversationId && p.conversationId !== id) return openConversation(p.conversationId);
    openMain(p.initialPrompt ?? undefined);
  }

  /** 切到任务区再让 Board 选中它（收工了的 Board 会把「已完成」展开）；点的是周报 / 手册的通知就开对应弹窗 */
  async function openTask(id: string) {
    const r = await pullRoutines().catch(() => routineTasks);
    if (r.weekly.some((t) => t.id === id)) return setRoutine("weekly");
    if (r.learn.some((t) => t.id === id)) return setRoutine("learn");
    setView("queue");
    setOpeningTask({ id });
  }

  function go(v: View) {
    if (v === "ask") return openMain();
    setView(v);
    if (v === "history") {
      setHistConv(null);
      void refreshList();
    }
  }

  useEffect(() => {
    function onGlobalKey(e: KeyboardEvent) {
      if (!e.metaKey) return;
      // 终端聚焦时 ⌘ 组合归终端（⌘W 关的是 tmux 窗口，不是 Friday），只留 ⌘N
      if ((e.target as HTMLElement | null)?.closest?.(".xterm") && !(e.key === "n" && !e.shiftKey)) return;
      if (e.key === "n" && !e.shiftKey) {
        e.preventDefault();
        openMain();
      } else if (e.key === "f") {
        e.preventDefault();
        setSearching(true);
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
  const histList = list.filter((c) => c.id !== mainId);

  /** 顶栏「···」：不常用的都在这儿。任务区里的动作由 Board 监听事件去做（它握着同步状态和新建弹层） */
  const toBoard = (kind: BoardRequest["kind"]) => () => { setView("queue"); setBoardReq((r) => ({ kind, n: (r?.n ?? 0) + 1 })); };
  const weeklyPending = openWeekly(routineTasks.weekly)?.pending?.some((p) => p.type === "okr_submit");
  const reviewsPending = openReviews(routineTasks.learn).length;
  const menu = [
    { label: "新建任务", run: toBoard("new") },
    { label: "同步 Slack", run: toBoard("slack") },
    { label: "同步 Meegle", run: toBoard("meegle") },
    { label: weeklyPending ? "周报 · 待提交" : "周报", run: () => setRoutine("weekly") },
    { label: reviewsPending ? `学习 · ${reviewsPending} 批待过目` : "学习", run: () => setRoutine("learn") },
    { label: "定时任务", run: () => setRoutine("schedule") },
    { label: "会话历史", run: () => go("history") },
    { label: "操作记录", run: () => go("ledger") },
    { label: "设置", run: () => void invoke("open_settings") },
  ];

  /* 顶栏一行：FRIDAY · [会话 | 任务 | 项目] …… 终端数 · 用量 · 模型 · ··· */
  const nav = (
    <nav className="topnav" aria-label="视图" data-tauri-drag-region>
      <span className="topnav__brand" data-tauri-drag-region>FRIDAY</span>
      <span className="topnav__seg">
        {NAV.map((n) => (
          <button key={n.key} className={`topnav__item ${view === n.key ? "on" : ""}`} onClick={() => go(n.key)} title={n.kbd ? `${n.label} ${n.kbd}` : n.label}>
            {n.label}
          </button>
        ))}
      </span>
      <span className="topnav__sp" data-tauri-drag-region />
      <TerminalsMenu onOpenTask={(id) => void openTask(id)} onOpenProject={openProject} />
      <UsageStrip />
      <span className="topbar__model mono" title="会话用的模型，设置里可改">{modelLabel || "跟随 Claude Code"}</span>
      <MoreMenu actions={menu} label="Friday 菜单" />
    </nav>
  );

  const head = (title: string, count: React.ReactNode, right?: React.ReactNode) => (
    <header className="q__head q__head--wide" data-tauri-drag-region>
      {nav}
      <div className="q__row q__row--sub" data-tauri-drag-region>
        <div className="q__title" data-tauri-drag-region>
          <h2 data-tauri-drag-region>{title}</h2>
          {count}
        </div>
        {right && <div className="q__tools">{right}</div>}
      </div>
    </header>
  );

  return (
    <div className="chat chat--norail">
      <LinkMenuHost />

      <div className="wb">
        {view === "ask" ? (
          <>
            {head(
              "会话",
              <span className="q__count">主对话</span>,
              <>
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
            <div className="mainconv">
              <div className="ask">
                <Thread
                  ref={threadRef}
                  conversationId={mainId}
                  {...(mainId ? {} : { disabledNote: mainFailed ? "连不上 Friday 的后台，稍后再试" : "正在连接 Friday…" })}
                  onConversation={() => void refreshList()}
                  emptyTitle="说吧"
                  emptyHint="问题直接答；要干的活我先说判断，你点头我再开工。任务有进展、要你拍板时我会在这里主动说。"
                  hint="Enter 发送 · Shift+Enter 换行 · Esc 回工作台"
                  onEscape={() => go("queue")}
                  onOpenTask={(id) => void openTask(id)}
                  autoFocus
                />
              </div>
              <Needs mainId={mainId} onPick={(id) => void openTask(id)} />
            </div>
          </>
        ) : view === "history" ? (
          <>
            {head("会话历史", <span className="q__count">{histConv ? list.find((c) => c.id === histConv)?.title ?? "旧会话" : `${histList.length} 段`}</span>, histConv ? <button className="pill" onClick={() => setHistConv(null)}>返回列表</button> : undefined)}
            {histConv ? (
              <div className="ask">
                <Thread
                  conversationId={histConv}
                  emptyTitle=""
                  emptyHint=""
                  disabledNote="旧会话，只读。有事在主对话里说"
                  onEscape={() => setHistConv(null)}
                  onOpenTask={(id) => void openTask(id)}
                />
              </div>
            ) : (
              <div className="wb__scroll">
                <div className="wb__page">
                  {histList.length === 0 ? (
                    <div className="empty"><strong>还没有旧会话</strong>所有事都在主对话里说。</div>
                  ) : (
                    <div className="list">
                      {histList.map((c) => (
                        <button key={c.id} className="row row--compact" onClick={() => setHistConv(c.id)}>
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
            )}
          </>
        ) : view === "projects" ? (
          <Projects nav={nav} onOpenTask={(id) => void openTask(id)} />
        ) : (
          <Board view={view} nav={nav} runningConvs={runningConvs} request={boardReq} />
        )}
      </div>
      {routine === "weekly" && <WeeklyDialog tasks={routineTasks.weekly} onClose={() => setRoutine(null)} />}
      {routine === "learn" && <LearnDialog tasks={routineTasks.learn} onClose={() => setRoutine(null)} />}
      {routine === "schedule" && (
        <ScheduleDialog
          onClose={() => setRoutine(null)}
          onOpenWeekly={() => setRoutine("weekly")}
          onOpenLearn={() => setRoutine("learn")}
          onOpenTask={(id) => { setRoutine(null); void openTask(id); }}
          onOpenConversation={(id) => { setRoutine(null); openConversation(id); }}
        />
      )}
      {searching && (
        <Search
          onClose={() => setSearching(false)}
          onPickTask={openTask}
          onPickConversation={openConversation}
        />
      )}
    </div>
  );
}
