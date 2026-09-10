import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { AuditEvent, Task, TaskBoard, TaskStatus, TerminalState, Thread } from "@friday/shared";
import type { Activity } from "../lib/core";
import { peekFocusJob } from "../lib/focusJob";
import type { FridayEvent } from "../lib/events";
import { audit as fetchAudit, auditUndo, jobActivity, newConversation, settings, syncMeegle, taskApprove, taskBindConversation, taskBoard, taskPin, taskReject, taskRetry, taskSet, taskVerify, threadById } from "../lib/core";
import { AttachmentStrip, Linkified, extractUrls, fmtTime } from "./shared";
import { Thread as ChatThread } from "./Thread";
import { Terminal } from "./Terminal";

export type BoardView = "queue" | "doing" | "all" | "ledger";

const KIND: Record<string, string> = { slack: "Slack", meegle: "Meegle", verbal: "口头", doc: "文档", code: "代码", other: "其他" };
const RISK: Record<string, string> = { read: "只读", reversible: "可撤销", irreversible: "不可逆" };
const STATUS: Record<TaskStatus, string> = { review: "等你决定", blocked: "卡住了", processing: "Friday 在做", understood: "待办", collected: "刚收到", done: "已完成", ignored: "已忽略" };
const DECIDE: TaskStatus[] = ["review", "blocked"];
const DOING: TaskStatus[] = ["processing"];
const QUEUED: TaskStatus[] = ["understood", "collected"];
const ALL_ORDER: TaskStatus[] = ["review", "blocked", "processing", "understood", "collected", "done", "ignored"];
const PRIORITY: Record<string, number> = { high: 0, normal: 1, low: 2 };
const TERM_LABEL: Record<string, string> = { busy: " · 在输出", idle: " · 空闲，等指示", gone: " · 已断，展开可重新打开", external: " · 在外部终端里", unknown: "" };

function waited(iso: string): string {
  const m = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (m < 60) return `等了 ${m} 分钟`;
  if (m < 60 * 24) return `等了 ${Math.round(m / 60)} 小时`;
  return `等了 ${Math.round(m / 60 / 24)} 天`;
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 6) return "夜深了";
  if (h < 12) return "早上好";
  if (h < 14) return "中午好";
  if (h < 18) return "下午好";
  return "晚上好";
}

function needs(t: Task): string {
  if (t.attention === "question") return `马上回：${(t.progress ?? "终端在问你").replace(/^终端在问：/, "")}`;
  const first = t.pending?.[0];
  if (first) return `需要你：${first.label}`;
  if (t.report) return "需要你：看交付报告";
  if (t.plan) return "需要你：定方案";
  if (t.status === "review") return "需要你：过一眼";
  if (t.status === "blocked") return "需要你：介入";
  return "";
}

function dueLabel(iso: string): string {
  const days = Math.round((new Date(iso).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000);
  if (days < 0) return `逾期 ${-days} 天`;
  if (days === 0) return "今天到期";
  if (days === 1) return "明天到期";
  return `${days} 天后到期`;
}

function queuedRight(t: Task): string {
  if (t.due) return dueLabel(t.due);
  if (t.progress) return t.progress.slice(0, 40);
  return `${KIND[t.kind] ?? t.kind}${t.priority === "high" ? " · 高优先级" : ""}`;
}

/** 「Friday 在做」右侧：先说终端的真实状态，再带一句进展 */
function doingRight(t: Task): string {
  const p = t.progress?.slice(0, 40);
  if (t.attention === "question") return `马上回：${(t.progress ?? "").replace(/^终端在问：/, "")}`;
  if (t.attention === "review") return `这轮做完了 · 等你看${t.report ? `：${t.report.summary.slice(0, 30)}` : ""}`;
  if (t.attention === "blocked") return p ?? "卡住了，需要你";
  switch (t.terminal) {
    case "gone":
      return "终端已断 · 点开重新打开";
    case "idle":
      return p ? `等你指示 · ${p}` : "等你指示";
    case "external":
      return p ?? "在外部终端里跑";
    default:
      return p ?? STATUS[t.status];
  }
}

function meta(t: Task): string {
  return [KIND[t.kind] ?? t.kind, t.project, waited(t.updatedAt)].filter(Boolean).join(" · ");
}

/** 活跃的排前面：终端在输出 / Friday 在回 > 最近更新 */
function byActivity(active: (t: Task) => boolean) {
  return (a: Task, b: Task) => Number(active(b)) - Number(active(a)) || b.updatedAt.localeCompare(a.updatedAt);
}

function sortDecide(a: Task, b: Task): number {
  const pa = a.pending?.length ? 0 : 1;
  const pb = b.pending?.length ? 0 : 1;
  if (pa !== pb) return pa - pb;
  return b.updatedAt.localeCompare(a.updatedAt);
}

export function Board({ view, tools, onCounts, onFocusChange, runningConvs }: {
  view: BoardView;
  tools: React.ReactNode;
  /** Friday 正在生成中的会话 id：对应任务条目上显示青条 */
  runningConvs?: Set<string>;
  onCounts?: (c: { decide: number; doing: number }) => void;
  onFocusChange?: (t: Task | null) => void;
}) {
  const [board, setBoard] = useState<TaskBoard | null>(null);
  const [name, setName] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [doingOpen, setDoingOpen] = useState(true);
  const [queuedOpen, setQueuedOpen] = useState(true);
  const [doneOpen, setDoneOpen] = useState(false);
  const [err, setErr] = useState("");
  const [ledger, setLedger] = useState<AuditEvent[]>([]);
  const detailRef = useRef<HTMLElement>(null);

  const failures = useRef(0);
  const load = async () => {
    try {
      const b = await taskBoard();
      setBoard(b);
      setErr("");
      failures.current = 0;
      // 侧栏「Friday 在做」的数字要和页面上那个分组一致：只算 processing，待办另有分组
      onCounts?.({ decide: b.counts.review + b.counts.blocked + b.tasks.filter((t) => t.attention === "question" && t.status === "processing").length, doing: b.counts.processing });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failures.current++;
      // 窗口通常比 sidecar 先起来，启动阶段的连接失败静默重试，连续失败十几秒才提示
      if (!/load failed|fetch/i.test(msg)) setErr(msg);
      else if (failures.current >= 8) setErr("连接 Friday 失败，正在重试");
    }
  };
  useEffect(() => {
    let timer: number | undefined;
    let stopped = false;
    const loop = async () => {
      await load();
      if (stopped) return;
      // 变更由 /events 推过来，这里只兜底
      timer = window.setTimeout(loop, failures.current > 0 ? 1500 : 30000);
    };
    void loop();
    void settings().then((s) => setName(s.name)).catch(() => {});
    // 进展一句一推，攒 200ms 合成一次拉取
    let coalesce = 0;
    const onChanged = () => {
      window.clearTimeout(coalesce);
      coalesce = window.setTimeout(() => void load(), 200);
    };
    window.addEventListener("friday:tasks-changed", onChanged);
    const onEvent = (e: Event) => {
      const ev = (e as CustomEvent<FridayEvent>).detail;
      if (ev.type === "terminal") setTermStates((m) => (m.get(ev.jobId) === ev.state ? m : new Map(m).set(ev.jobId, ev.state)));
    };
    window.addEventListener("friday:event", onEvent);
    const onFocusJob = () => setFocusSignal((n) => n + 1);
    window.addEventListener("friday:focus-job", onFocusJob);
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
      window.removeEventListener("friday:tasks-changed", onChanged);
      window.removeEventListener("friday:focus-job", onFocusJob);
      window.removeEventListener("friday:event", onEvent);
      window.clearTimeout(coalesce);
    };
  }, []);
  // 终端忙闲：实时推送的值优先于任务板快照
  const [termStates, setTermStates] = useState<Map<string, TerminalState>>(new Map());
  // 「聚焦终端」点过来：任务列表到了就选中绑着那个 job 的任务，Terminal 挂上时接管光标
  const [focusSignal, setFocusSignal] = useState(0);
  useEffect(() => {
    const jobId = peekFocusJob();
    if (!jobId) return;
    const t = board?.tasks.find((x) => x.source.jobId === jobId);
    if (t) setSelectedId(t.id);
  }, [board, focusSignal]);
  useEffect(() => {
    if (view === "doing") setDoingOpen(true);
    if (view === "ledger") void fetchAudit(undefined, 300).then(setLedger).catch(() => {});
  }, [view]);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  async function doSync() {
    setSyncing(true);
    setSyncNote(null);
    try {
      const r = await syncMeegle();
      if (r.error) setErr(`Meegle 同步失败：${r.error}`);
      else setSyncNote(r.added || r.closed ? `+${r.added} / 完成 ${r.closed}` : "没有变化");
      void load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
      window.setTimeout(() => setSyncNote(null), 4000);
    }
  }

  async function act(t: Task | null, fn: () => Promise<unknown>) {
    setErr("");
    try {
      await fn();
      const b = await taskBoard();
      setBoard(b);
      const after = t ? b.tasks.find((x) => x.id === t.id) : undefined;
      if (t && (!after || after.status !== t.status)) setSelectedId(null);
      if (view === "ledger") setLedger(await fetchAudit(undefined, 300));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  const tasks = (board?.tasks ?? []).map((t) => (t.source.jobId && termStates.has(t.source.jobId) && t.status === "processing" ? { ...t, terminal: termStates.get(t.source.jobId) } : t));
  const active = (t: Task) => t.terminal === "busy" || Boolean(runningConvs?.has(t.source.conversationId ?? ""));
  // 星标的单独一组放最顶上，其余分组里不再出现
  const pinned = tasks.filter((t) => t.pinned && t.status !== "done" && t.status !== "ignored").sort(byActivity(active));
  const rest = tasks.filter((t) => !pinned.includes(t));
  const asking = (t: Task) => t.attention === "question";
  // 终端在问你 = 阻塞，不管状态都进「待我决定」并排最前
  const decide = rest.filter((t) => DECIDE.includes(t.status) || asking(t)).sort((a, b) => Number(asking(b)) - Number(asking(a)) || sortDecide(a, b));
  const doing = rest.filter((t) => DOING.includes(t.status) && !asking(t)).sort(byActivity(active));
  const queued = rest.filter((t) => QUEUED.includes(t.status)).sort((a, b) => (a.due ?? "9").localeCompare(b.due ?? "9") || (PRIORITY[a.priority] ?? 1) - (PRIORITY[b.priority] ?? 1) || b.updatedAt.localeCompare(a.updatedAt));
  const done = rest.filter((t) => t.status === "done").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8);
  const explicit = selectedId ? tasks.find((t) => t.id === selectedId) ?? null : null;
  const focus = view === "all" || view === "ledger" ? explicit : explicit ?? pinned[0] ?? decide[0] ?? null;
  useEffect(() => {
    onFocusChange?.(focus ?? null);
  }, [focus?.id]);
  // 换了任务：详情栏回到顶部，左边列表把选中项滚进视野
  useEffect(() => {
    detailRef.current?.scrollTo({ top: 0 });
    document.querySelector(".li--on")?.scrollIntoView({ block: "nearest" });
  }, [focus?.id]);
  const title = view === "ledger" ? "操作记录" : view === "all" ? "全部任务" : "待我决定";
  const count = view === "ledger" ? ledger.length : view === "all" ? tasks.length : decide.length;
  const sub =
    view === "ledger" || view === "all"
      ? ""
      : decide.length
        ? `先把这 ${decide.length} 件定了，其他的 Friday 在做。`
        : doing.length + queued.length
          ? `没有等你决定的事，Friday 手上有 ${doing.length} 件，待办 ${queued.length} 件。`
          : "一切清爽，没有等你的事。";

  // 左栏一条：状态点 + 标题（最多两行）+ 一句状态；选哪条右边就换哪条
  const item = (t: Task, line: string, dim = false) => (
    <div key={t.id} className={`li ${t.id === focus?.id ? "li--on" : ""} ${dim ? "li--dim" : ""} ${t.pinned ? "li--pinned" : ""}`} onClick={() => setSelectedId(t.id)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") setSelectedId(t.id); }}>
      <span className={`dot dot--${t.attention ?? t.status}`} />
      <span className="li__main">
        <span className="li__title">{t.title}</span>
        <span className="li__sub">{runningConvs?.has(t.source.conversationId ?? "") ? `Friday 在回 · ${line}` : line}</span>
        {(t.terminal === "busy" || runningConvs?.has(t.source.conversationId ?? "")) && <span className="li__bar"><i /></span>}
      </span>
      <button className="li__pin" title={t.pinned ? "取消关注" : "关注"} onClick={(e) => { e.stopPropagation(); void act(null, () => taskPin(t.id, !t.pinned)); }}>{t.pinned ? "★" : "☆"}</button>
    </div>
  );
  const group = (label: string, list: Task[], open: boolean, toggle: () => void, empty: string, line: (t: Task) => string, dim: (t: Task) => boolean, extra?: React.ReactNode) => (
    <section className="grp grp--side">
      <div className="grp__head grp__head--row">
        <button className="grp__head grp__head--inner" onClick={toggle}>
          {label}<span className="mono">{list.length}</span>
          <span className="grp__tog">{open ? "收起" : "展开 ›"}</span>
        </button>
        {extra}
      </div>
      {open && (list.length ? list.map((t) => item(t, line(t), dim(t))) : <div className="li li--empty">{empty}</div>)}
    </section>
  );

  return (
    <>
      <header className="q__head q__head--wide" data-tauri-drag-region>
        <div className="q__row" data-tauri-drag-region>
          <div className="q__title" data-tauri-drag-region>
            <h1 data-tauri-drag-region>{title}</h1>
            {board ? <span className="q__count">{count} {view === "ledger" ? "条" : "件"}</span> : !err && <span className="q__count">正在连接 Friday…</span>}
          </div>
          <div className="q__tools">{tools}</div>
        </div>
        {sub && board && <p className="q__sub" data-tauri-drag-region>{name ? `Hello ${name}！` : ""}{greeting()}，{sub}</p>}
      </header>
      {view === "ledger" ? (
        <div className="wb__scroll">
          <div className="wb__page">
            {err && <div className="err" style={{ marginBottom: 16 }}>{err}</div>}
            {board && <Ledger events={ledger} onUndo={(id) => void act(null, () => auditUndo(id))} />}
          </div>
        </div>
      ) : (
        <div className="split">
          <aside className="split__list">
            {err && <div className="err" style={{ margin: "8px 0 12px" }}>{err}</div>}
            {!board ? null : view === "all" ? (
              ALL_ORDER.map((st) => {
                const list = tasks.filter((t) => t.status === st);
                if (!list.length) return null;
                return (
                  <section key={st} className="grp grp--side">
                    <div className="grp__head"><span className={`dot dot--${st}`} />{STATUS[st]}<span className="mono">{list.length}</span></div>
                    {list.map((t) => item(t, needs(t) || fmtTime(t.updatedAt), !needs(t)))}
                  </section>
                );
              })
            ) : (
              <>
                {pinned.length > 0 && (
                  <section className="grp grp--side grp--first">
                    <div className="grp__head"><span className="li__pin-mark">★</span>关注<span className="mono">{pinned.length}</span></div>
                    {pinned.map((t) => item(t, t.attention ? doingRight(t) : needs(t) || doingRight(t)))}
                  </section>
                )}
                <section className={`grp grp--side ${pinned.length ? "" : "grp--first"}`}>
                  <div className="grp__head"><span className="dot dot--decide" />待我决定<span className="mono">{decide.length}</span></div>
                  {decide.length ? decide.map((t) => item(t, needs(t))) : <div className="li li--empty">没有等你决定的事</div>}
                </section>
                {group("Friday 在做", doing, doingOpen, () => setDoingOpen((v) => !v), "现在没有在做的事", doingRight, () => false)}
                {group("待办", queued, queuedOpen, () => setQueuedOpen((v) => !v), "没有待办", queuedRight, (t) => !t.due && t.priority !== "high",
                  <button className={`grp__act ${syncing ? "is-busy" : ""}`} title="立刻同步一次 Meegle 工单（平时每 15 分钟自动）" disabled={syncing} onClick={() => void doSync()}>
                    {syncing ? <span className="side__spin" /> : "↻"} {syncNote ?? "Meegle"}
                  </button>)}
                {group("最近完成", done, doneOpen, () => setDoneOpen((v) => !v), "还没有完成的", (t) => fmtTime(t.updatedAt), () => true)}
              </>
            )}
          </aside>
          <section className="split__detail" ref={detailRef}>
            {!board ? null : focus ? (
              <Focus key={focus.id} t={focus} onAct={act} onClose={() => setSelectedId(null)} closable={false} />
            ) : (
              <div className="empty">
                <strong>{view === "all" ? "点左边一条看详情" : "没有等你决定的事"}</strong>
                {view === "all" ? "" : doing.length + queued.length ? `Friday 手上有 ${doing.length} 件，待办 ${queued.length} 件；左边点一条看它做到哪了。` : "⌘N 问 Friday，要干的活它先说判断再开工；或者等 Slack 和 Meegle 来活。"}
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
}

function Focus({ t, onAct, onClose, closable, ref }: {
  t: Task;
  onAct: (t: Task, fn: () => Promise<unknown>) => Promise<void>;
  onClose: () => void;
  closable: boolean;
  ref?: React.Ref<HTMLElement>;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  // 给别人发消息前先给用户看要发什么、可以改，确认才发
  const [confirming, setConfirming] = useState(false);
  const [sendText, setSendText] = useState("");
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [thread, setThread] = useState<Thread | null>(null);
  const [acts, setActs] = useState<Activity[]>([]);
  // 终端状态三层：xterm 输出流（展开时，3 秒内有输出=忙）> 动作流轮询（5 秒）> 任务板（15 秒）
  const [actTerminal, setActTerminal] = useState<TerminalState | null>(null);
  const [liveBusy, setLiveBusy] = useState<boolean | null>(null);
  const liveTimer = useRef(0);
  const onTermOutput = () => {
    setLiveBusy(true);
    window.clearTimeout(liveTimer.current);
    liveTimer.current = window.setTimeout(() => setLiveBusy(false), 3000);
  };
  useEffect(() => () => window.clearTimeout(liveTimer.current), []);
  // 终端默认收起：先看 Friday 怎么说，不放心再展开自己看；「聚焦终端」点过来时直接展开
  const [termOpen, setTermOpen] = useState(() => peekFocusJob() === t.source.jobId);
  useEffect(() => {
    const onFocusJob = (e: Event) => { if ((e as CustomEvent<string>).detail === t.source.jobId) setTermOpen(true); };
    window.addEventListener("friday:focus-job", onFocusJob);
    return () => window.removeEventListener("friday:focus-job", onFocusJob);
  }, [t.source.jobId]);
  // 终端在做什么：进行中每 5 秒拉一次动作流，停了就只拉一次
  useEffect(() => {
    const jobId = t.source.jobId;
    setActs([]);
    if (!jobId) return;
    let stop = false;
    const pull = () => void jobActivity(jobId).then((a) => { if (!stop) { setActs(a.items); setActTerminal(a.terminal); } }).catch(() => {});
    pull();
    if (t.status !== "processing") return () => { stop = true; };
    const timer = window.setInterval(pull, 5000);
    return () => { stop = true; window.clearInterval(timer); };
  }, [t.source.jobId, t.status]);
  useEffect(() => {
    setRejecting(false);
    setReason("");
    setConfirming(false);
    void fetchAudit(t.id, 50).then(setEvents).catch(() => {});
  }, [t.id, t.updatedAt]);
  useEffect(() => {
    setThread(null);
    if (t.source.threadId) void threadById(t.source.threadId).then(setThread).catch(() => {});
  }, [t.source.threadId]);

  const r = t.report;
  // 勾选状态存在任务上；本地先变，后端推送回来再对齐
  const [checked, setChecked] = useState<boolean[]>(() => r?.checked ?? []);
  useEffect(() => { setChecked(r?.checked ?? []); }, [t.id, r?.checked?.join(",")]);
  const checkedCount = checked.filter(Boolean).length;
  function toggleCheck(i: number, v: boolean) {
    setChecked((c) => { const n = [...c]; n[i] = v; return n; });
    void taskVerify(t.id, i, v).catch(() => {});
  }
  const pending = t.pending ?? [];
  const advice = pending[0]?.detail || t.plan || r?.summary || "";
  const situation = t.understanding || t.source.note || "";
  const links = [...new Set([...(thread?.items ?? []).flatMap((i) => extractUrls(i.text)), ...(t.source.url ? [t.source.url] : []), ...extractUrls(t.understanding ?? "")])];
  const open = t.status !== "done" && t.status !== "ignored";
  const rightHas = Boolean(r) || Boolean(t.progress && (situation || advice)) || pending.length > 1 || links.length > 0;

  const first = pending[0];
  const isMessage = first?.type === "slack_reply";
  const primary: { label: string; run: () => Promise<unknown> } | null = first
    ? isMessage
      ? { label: pending.length > 1 ? `看一眼再发：${first.label}` : "看一眼再发", run: async () => { setSendText(String(first.payload.text ?? first.detail)); setConfirming(true); } }
      : { label: pending.length > 1 ? `通过并执行：${first.label}` : "通过并执行", run: () => taskApprove(t.id, first.id) }
    : t.status === "blocked" && t.project
      ? { label: "重新开工", run: () => taskRetry(t.id) }
      : t.status === "review"
        ? { label: "标记完成", run: () => taskSet(t.id, "done") }
        : null;

  useEffect(() => {
    if (!primary) return;
    const run = primary.run;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Enter" || e.metaKey || e.shiftKey || e.altKey) return;
      const el = document.activeElement;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      if (el?.closest(".thread, .xterm, .fx__confirm")) return;
      if (confirming) return;
      e.preventDefault();
      void onAct(t, run);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [t.id, t.updatedAt, primary?.label, confirming]);

  return (
    <>
    <article className="fx" ref={ref as React.Ref<HTMLDivElement>}>
      <div className="fx__meta">
        <span className={`dot dot--${t.attention ?? t.status}`} />
        <span>{STATUS[t.status]}{t.attention === "question" ? " · 终端在问你，回答前它不会继续" : t.attention === "review" ? " · 这轮做完了，等你看" : t.attention === "blocked" ? " · 卡住了，需要你" : ""} · {meta(t)} · 卡片更新于 {fmtTime(t.updatedAt)}</span>
        <button className={`fx__pin ${t.pinned ? "on" : ""}`} title={t.pinned ? "取消关注" : "关注这条任务"} onClick={() => void onAct(t, () => taskPin(t.id, !t.pinned))}>{t.pinned ? "★ 已关注" : "☆ 关注"}</button>
        {closable && <button className="b b--text" style={{ height: 22 }} onClick={onClose}>收起</button>}
      </div>
      <h2 className="fx__title">{t.title}</h2>

      <div className={`fx__grid ${rightHas ? "" : "fx__grid--single"}`}>
        <div className="fx__col">
          {situation && (
            <div>
              <span className="k">情境</span>
              <div className="fx__text"><Linkified text={situation} /></div>
            </div>
          )}
          {advice && (
            <div>
              <span className="k">{pending[0] ? `Friday 的建议：${pending[0].label}${isMessage ? "（点「看一眼再发」可改）" : ""}` : t.plan ? "Friday 的方案" : "Friday 做了什么"}</span>
              <div className="fx__quote"><Linkified text={advice} /></div>
            </div>
          )}
          {!situation && !advice && t.progress && (
            <div>
              <span className="k">进展</span>
              <div className="fx__text">{t.progress}</div>
            </div>
          )}
        </div>
        <div className="fx__col">
          {r && r.verify.length > 0 && (
            <div>
              <span className="k">
                通过前请确认 · {checkedCount}/{r.verify.length}
                {checkedCount === r.verify.length && <span className="fx__check-all">全部确认 ✓{first ? "，点「通过并执行」推进" : t.source.jobId ? "，已让终端继续" : "，可以标记完成"}</span>}
              </span>
              <ul className="fx__check">
                {r.verify.map((c, i) => (
                  <li key={i} className={checked[i] ? "is-checked" : ""}>
                    <label>
                      <input type="checkbox" checked={checked[i] ?? false} onChange={(e) => toggleCheck(i, e.target.checked)} />
                      {c}
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {r && (
            <div>
              <span className="k">测试结果</span>
              <div className="fx__text">{r.testResult}</div>
            </div>
          )}
          {!r && t.progress && (situation || advice) && (
            <div>
              <span className="k">进展</span>
              <div className="fx__text">{t.progress}</div>
            </div>
          )}
          {links.length > 0 && (
            <div>
              <span className="k">对方给的链接</span>
              <ul className="fx__links">
                {links.map((u) => (
                  <li key={u}><a href={u} className="link" onClick={(e) => { e.preventDefault(); void openUrl(u); }}>{u.replace(/^https?:\/\//, "").slice(0, 72)}</a></li>
                ))}
              </ul>
            </div>
          )}
          {pending.length > 1 && (
            <div>
              <span className="k">还有 {pending.length - 1} 个动作排在后面</span>
              <div className="fx__text">{pending.slice(1).map((p) => p.label).join("、")}</div>
            </div>
          )}
        </div>
      </div>

      {r && (r.changes.length > 0 || r.testSteps.length > 0 || r.screenshots.length > 0) && (
        <details className="fx__more">
          <summary>交付报告：改动 {r.changes.length} 处 · 测试 {r.testSteps.length} 步 · 截图 {r.screenshots.length} 张{r.at ? ` · 交于 ${fmtTime(r.at)}` : ""}</summary>
          <div className="fx__more-body">
            {r.changes.length > 0 && <><span className="k">改动</span><ul>{r.changes.map((c, i) => <li key={i}>{c}</li>)}</ul></>}
            {r.testSteps.length > 0 && <><span className="k">测试过程</span><ol>{r.testSteps.map((c, i) => <li key={i}>{c}</li>)}</ol></>}
            {r.screenshots.length > 0 && <><span className="k">截图</span><AttachmentStrip items={r.screenshots} /></>}
          </div>
        </details>
      )}
      {thread && thread.items.length > 0 && (
        <details className="fx__more">
          <summary>Slack 原文 · {thread.items.length} 条 · {thread.channelName || thread.userName}</summary>
          <div className="fx__more-body">
            <ul className="fx__raw">
              {thread.items.map((i) => (
                <li key={i.id}>
                  <span className="fx__raw-who">{i.userName}</span>
                  <span className="mono fx__raw-ts">{fmtTime(i.receivedAt)}</span>
                  <a href={i.permalink} className="link fx__raw-open" onClick={(e) => { e.preventDefault(); void openUrl(i.appLink ?? i.permalink); }}>在 Slack 打开</a>
                  <div><Linkified text={i.text} /></div>
                </li>
              ))}
            </ul>
          </div>
        </details>
      )}
      <div className="fx__talk">
        <span className="k">和 Friday 聊这条任务</span>
        <ChatThread
          conversationId={t.source.conversationId ?? null}
          resolve={async (prompt) => {
            const conv = await newConversation();
            await taskBindConversation(t.id, conv.id).catch(() => {});
            window.dispatchEvent(new Event("friday:tasks-changed"));
            return { id: conv.id, prompt };
          }}
          emptyTitle="关于这条任务，直接问"
          emptyHint="Friday 带着它的情境、链接和原文回答；要动代码会先说判断等你点头。终端里 Claude 的交付和卡住也会出现在这里；不放心再展开下面的终端自己看。"
          placeholder="跟 Friday 说这条任务…"
          hint="Enter 发送 · Shift+Enter 换行"
        />
      </div>
      {t.source.jobId && acts.length > 0 && (
        <div className="fx__doing">
          <span className="k">终端在做</span>
          <ul className="fx__activity">
            {acts.map((a, i) => (
              <li key={`${a.ts}-${i}`} className={`act act--${a.kind}${a.kind === "tool" ? (a.ok === undefined ? " act--busy" : a.ok ? " act--ok" : " act--err") : ""}`}>
                <i />{a.text}
              </li>
            ))}
          </ul>
        </div>
      )}
      {t.source.jobId && (
        <div className="fx__term">
          <button className="fx__term-toggle" onClick={() => setTermOpen((v) => !v)}>
            <span className="k">终端{TERM_LABEL[termOpen && liveBusy !== null && (actTerminal ?? t.terminal) !== "gone" ? (liveBusy ? "busy" : "idle") : (actTerminal ?? t.terminal ?? "unknown")]}</span>
            <span className="grp__tog">{termOpen ? "收起" : "展开 ›"}</span>
          </button>
          {termOpen && <Terminal id={t.source.jobId} onOutput={onTermOutput} />}
        </div>
      )}
      {events.length > 0 && (
        <details className="fx__more">
          <summary>这条任务的账 · {events.length} 条</summary>
          <div className="fx__more-body">
            <ul>{events.map((e) => <li key={e.id}><span className="mono">{fmtTime(e.ts)}</span> {e.action} — {e.why}</li>)}</ul>
          </div>
        </details>
      )}

    </article>
      {open && (
        <div className="fx__foot">
          <div className="fx__acts">
            {primary && <button className="b b--primary" onClick={() => void onAct(t, primary.run)}>{primary.label}<kbd>↵</kbd></button>}
            {/* 有待审动作时也能直接收工：done 会把没发出去的动作一起作废，不会发消息给别人 */}
            {(!primary || first) && (
              <button className="b b--ghost" title={first ? "任务标记完成，待审的动作作废，不会发出去" : undefined} onClick={() => void onAct(t, () => taskSet(t.id, "done"))}>
                {first ? (isMessage ? "完成，不发" : "完成，不执行") : "标记完成"}
              </button>
            )}
            <button className="b b--ghost" onClick={() => setRejecting((v) => !v)}>打回</button>
            <button className="b b--text" onClick={() => void onAct(t, () => taskSet(t.id, "ignore"))}>忽略</button>
          </div>
          {confirming && first && (
            <div className="fx__confirm">
              <div className="fx__confirm-head">
                <span className="k">将以你的身份发给 {String(first.payload.userName ?? "对方")}{first.payload.threadTs ? "（在原线程里回）" : "（私聊）"}</span>
                <span className="fx__confirm-hint mono">⌘↵ 发送 · Esc 取消</span>
              </div>
              <textarea
                className="fx__confirm-text"
                autoFocus
                rows={4}
                value={sendText}
                onChange={(e) => setSendText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setConfirming(false);
                  if (e.key === "Enter" && e.metaKey && sendText.trim()) { e.preventDefault(); void onAct(t, () => taskApprove(t.id, first.id, sendText.trim())); }
                }}
              />
              <div className="fx__confirm-acts">
                <button className="b b--primary" disabled={!sendText.trim()} onClick={() => void onAct(t, () => taskApprove(t.id, first.id, sendText.trim()))}>就这么发<kbd>⌘↵</kbd></button>
                <button className="b b--text" onClick={() => setConfirming(false)}>先不发</button>
              </div>
            </div>
          )}
          {rejecting && (
            <form className="fx__reject" onSubmit={(e) => { e.preventDefault(); void onAct(t, () => taskReject(t.id, reason || undefined)); }}>
              <input autoFocus placeholder="哪里不对？一句话，Friday 会按这个改" value={reason} onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setRejecting(false); }} />
              <button className="b b--ghost" type="submit">打回给 Friday</button>
            </form>
          )}
        </div>
      )}
    </>
  );
}

function Ledger({ events, onUndo }: { events: AuditEvent[]; onUndo: (id: string) => void }) {
  if (!events.length) return <div className="empty"><strong>还没有记录</strong>Friday 做的每一步都会记在这里：为什么、怎么做、证据、能否撤销。</div>;
  return (
    <div className="ledger">
      {events.map((e) => (
        <div key={e.id} className={`levent levent--${e.status}`}>
          <div className="levent__head">
            <span className="mono levent__time">{fmtTime(e.ts)}</span>
            <span className="levent__action">{e.action}</span>
            <span className={`levent__risk levent__risk--${e.risk}`}>{RISK[e.risk]}</span>
            <span className="mono levent__status">{e.status}</span>
            {e.reversible && e.status !== "undone" && <button className="levent__undo" onClick={() => onUndo(e.id)}>撤销</button>}
          </div>
          <div className="levent__why">{e.why}</div>
          <div className="levent__how mono">{e.how}</div>
          {Object.keys(e.evidence).length > 0 && (
            <details className="levent__evidence">
              <summary>证据</summary>
              <pre>{JSON.stringify(e.evidence, null, 2)}</pre>
            </details>
          )}
        </div>
      ))}
    </div>
  );
}
