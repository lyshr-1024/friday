import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { AuditEvent, Task, TaskBoard, TaskStatus, Thread } from "@friday/shared";
import { audit as fetchAudit, auditUndo, createTask, settings, taskApprove, taskBoard, taskReject, taskRetry, taskSet, threadById } from "../lib/core";
import { AttachmentStrip, Linkified, extractUrls, fmtTime } from "./shared";
import { Terminal } from "./Terminal";

export type BoardView = "queue" | "doing" | "all" | "ledger";

const KIND: Record<string, string> = { slack: "Slack", meegle: "Meegle", verbal: "口头", doc: "文档", code: "代码", other: "其他" };
const RISK: Record<string, string> = { read: "只读", reversible: "可撤销", irreversible: "不可逆" };
const STATUS: Record<TaskStatus, string> = { review: "等你决定", blocked: "卡住了", processing: "Friday 在做", understood: "排队中", collected: "刚收到", done: "已完成", ignored: "已忽略" };
const DECIDE: TaskStatus[] = ["review", "blocked"];
const DOING: TaskStatus[] = ["processing"];
const QUEUED: TaskStatus[] = ["understood", "collected"];
const ALL_ORDER: TaskStatus[] = ["review", "blocked", "processing", "understood", "collected", "done", "ignored"];
const PRIORITY: Record<string, number> = { high: 0, normal: 1, low: 2 };

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

function meta(t: Task): string {
  return [KIND[t.kind] ?? t.kind, t.project, waited(t.updatedAt)].filter(Boolean).join(" · ");
}

function sortDecide(a: Task, b: Task): number {
  const pa = a.pending?.length ? 0 : 1;
  const pb = b.pending?.length ? 0 : 1;
  if (pa !== pb) return pa - pb;
  const ra = PRIORITY[a.priority] ?? 1;
  const rb = PRIORITY[b.priority] ?? 1;
  if (ra !== rb) return ra - rb;
  return a.updatedAt.localeCompare(b.updatedAt);
}

function parseNew(text: string): { title: string; url?: string } {
  const m = text.match(/https?:\/\/\S+/);
  if (!m) return { title: text.trim() };
  const title = text.replace(m[0], "").trim() || m[0];
  return { title, url: m[0] };
}

export function Board({ view, tools, newTaskSignal, onDiscuss, onCounts, onFocusChange }: {
  view: BoardView;
  tools: React.ReactNode;
  newTaskSignal: number;
  onDiscuss?: (t: Task) => void;
  onCounts?: (c: { decide: number; doing: number }) => void;
  onFocusChange?: (t: Task | null) => void;
}) {
  const [board, setBoard] = useState<TaskBoard | null>(null);
  const [name, setName] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [doingOpen, setDoingOpen] = useState(true);
  const [queuedOpen, setQueuedOpen] = useState(true);
  const [doneOpen, setDoneOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const [ledger, setLedger] = useState<AuditEvent[]>([]);
  const newRef = useRef<HTMLInputElement>(null);

  const failures = useRef(0);
  const load = async () => {
    try {
      const b = await taskBoard();
      setBoard(b);
      setErr("");
      failures.current = 0;
      onCounts?.({ decide: b.counts.review + b.counts.blocked, doing: b.counts.processing + b.counts.understood + b.counts.collected });
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
      timer = window.setTimeout(loop, failures.current > 0 ? 1500 : 15000);
    };
    void loop();
    void settings().then((s) => setName(s.name)).catch(() => {});
    const onChanged = () => void load();
    window.addEventListener("friday:tasks-changed", onChanged);
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
      window.removeEventListener("friday:tasks-changed", onChanged);
    };
  }, []);
  useEffect(() => {
    if (view === "doing") setDoingOpen(true);
    if (view === "ledger") void fetchAudit(undefined, 300).then(setLedger).catch(() => {});
  }, [view]);
  useEffect(() => {
    if (newTaskSignal > 0) {
      setAdding(true);
      setTimeout(() => newRef.current?.focus(), 0);
    }
  }, [newTaskSignal]);

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

  function submitNew() {
    const p = parseNew(text);
    if (!p.title) return;
    void act(null, async () => {
      await createTask(p);
      setText("");
      setAdding(false);
    });
  }

  const tasks = board?.tasks ?? [];
  const decide = tasks.filter((t) => DECIDE.includes(t.status)).sort(sortDecide);
  const doing = tasks.filter((t) => DOING.includes(t.status));
  const queued = tasks.filter((t) => QUEUED.includes(t.status)).sort((a, b) => (a.due ?? "9").localeCompare(b.due ?? "9") || (PRIORITY[a.priority] ?? 1) - (PRIORITY[b.priority] ?? 1) || a.createdAt.localeCompare(b.createdAt));
  const done = tasks.filter((t) => t.status === "done").slice(0, 8);
  const explicit = selectedId ? tasks.find((t) => t.id === selectedId) ?? null : null;
  const focus = view === "all" || view === "ledger" ? explicit : explicit ?? decide[0] ?? null;
  useEffect(() => {
    onFocusChange?.(focus ?? null);
  }, [focus?.id]);
  const item = (t: Task, row: React.ReactNode) =>
    t.id === focus?.id ? <Focus key={t.id} t={t} onAct={act} onDiscuss={onDiscuss} onClose={() => setSelectedId(null)} closable={Boolean(explicit)} /> : row;

  const title = view === "ledger" ? "操作记录" : view === "all" ? "全部任务" : "待我决定";
  const count = view === "ledger" ? ledger.length : view === "all" ? tasks.length : decide.length;
  const sub =
    view === "ledger" || view === "all"
      ? ""
      : decide.length
        ? `先把这 ${decide.length} 件定了，其他的 Friday 在做。`
        : doing.length + queued.length
          ? `没有等你决定的事，Friday 手上有 ${doing.length} 件，排队 ${queued.length} 件。`
          : "一切清爽，没有等你的事。";

  return (
    <>
      <header className="q__head" data-tauri-drag-region>
        <div className="q__row" data-tauri-drag-region>
          <div className="q__title" data-tauri-drag-region>
            <h1 data-tauri-drag-region>{title}</h1>
            {board ? <span className="q__count">{count} {view === "ledger" ? "条" : "件"}</span> : !err && <span className="q__count">正在连接 Friday…</span>}
          </div>
          <div className="q__tools">{tools}</div>
        </div>
        {sub && board && <p className="q__sub" data-tauri-drag-region>{name ? `Hello ${name}！` : ""}{greeting()}，{sub}</p>}
      </header>
      <div className="wb__scroll">
        <div className="wb__page">
          {err && <div className="err" style={{ marginBottom: 16 }}>{err}</div>}

          {adding && (
            <form className="q__new" onSubmit={(e) => { e.preventDefault(); submitNew(); }}>
              <input
                ref={newRef}
                value={text}
                placeholder="一句话交代这件事，回车交给 Friday；带上链接也行"
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") { setAdding(false); setText(""); } }}
              />
              <kbd>↵ 交给 Friday · Esc 取消</kbd>
            </form>
          )}

          {!board ? null : view === "ledger" ? (
            <Ledger events={ledger} onUndo={(id) => void act(null, () => auditUndo(id))} />
          ) : (
            <>
              {view === "all" ? (
                ALL_ORDER.map((st) => {
                  const list = tasks.filter((t) => t.status === st);
                  if (!list.length) return null;
                  return (
                    <section key={st} className="grp">
                      <div className="grp__head"><span className={`dot dot--${st}`} />{STATUS[st]}<span className="mono">{list.length}</span></div>
                      <div className="list">{list.map((t) => item(t, <Row key={t.id} t={t} right={needs(t) || fmtTime(t.updatedAt)} dim={!needs(t)} onClick={() => setSelectedId(t.id)} />))}</div>
                    </section>
                  );
                })
              ) : (
                <>
                  {!decide.length && board && (
                    <div className="empty">
                      <strong>没有等你决定的事</strong>
                      {doing.length + queued.length ? `Friday 手上有 ${doing.length} 件，排队 ${queued.length} 件，需要你拍板的会放到这里。` : "⌘N 交代一件事，或者等 Slack 和 Meegle 来活。"}
                    </div>
                  )}
                  <div className="list">
                    {decide.map((t) => item(t, <Row key={t.id} t={t} right={needs(t)} onClick={() => setSelectedId(t.id)} />))}
                  </div>

                  <section className="grp">
                    <button className="grp__head" onClick={() => setDoingOpen((v) => !v)}>
                      Friday 在做<span className="mono">{doing.length}</span>
                      <span className="grp__tog">{doingOpen ? "收起" : "展开 ›"}</span>
                    </button>
                    {doingOpen && (
                      <div className="list">
                        {doing.map((t) => item(t, <Row key={t.id} t={t} compact right={t.progress ? t.progress.slice(0, 40) : STATUS[t.status]} dim bar onClick={() => setSelectedId(t.id)} />))}
                        {!doing.length && <div className="row row--compact"><span className="row__meta">现在没有在做的事</span></div>}
                      </div>
                    )}
                  </section>

                  <section className="grp">
                    <button className="grp__head" onClick={() => setQueuedOpen((v) => !v)}>
                      排队中<span className="mono">{queued.length}</span>
                      <span className="grp__tog">{queuedOpen ? "收起" : "展开 ›"}</span>
                    </button>
                    {queuedOpen && (
                      <div className="list">
                        {queued.map((t) => item(t, <Row key={t.id} t={t} compact right={queuedRight(t)} dim={!t.due && t.priority !== "high"} onClick={() => setSelectedId(t.id)} />))}
                        {!queued.length && <div className="row row--compact"><span className="row__meta">没有排队的事</span></div>}
                      </div>
                    )}
                  </section>
                  <section className="grp">
                    <button className="grp__head" onClick={() => setDoneOpen((v) => !v)}>
                      最近完成<span className="mono">{board?.counts.done ?? 0}</span>
                      <span className="grp__tog">{doneOpen ? "收起" : "展开 ›"}</span>
                    </button>
                    {doneOpen && (
                      <div className="list">
                        {done.map((t) => item(t, <Row key={t.id} t={t} compact right={fmtTime(t.updatedAt)} dim onClick={() => setSelectedId(t.id)} />))}
                      </div>
                    )}
                  </section>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

function Row({ t, right, dim, compact, bar, onClick }: { t: Task; right: string; dim?: boolean; compact?: boolean; bar?: boolean; onClick: () => void }) {
  return (
    <button className={`row ${compact ? "row--compact" : ""}`} onClick={onClick}>
      <span className={`dot dot--${t.status}`} />
      <span className="row__main">
        <div className="row__title">
          {t.title}
          {t.source.jobId && <span className="row__tag">终端</span>}
          {t.source.conversationId && <span className="row__tag">会话</span>}
        </div>
        {!compact && <div className="row__meta">{meta(t)}</div>}
      </span>
      {bar && <span className="row__bar"><i /></span>}
      <span className={`row__right ${dim ? "row__right--dim" : ""}`}>{right}</span>
    </button>
  );
}

function Focus({ t, onAct, onDiscuss, onClose, closable }: {
  t: Task;
  onAct: (t: Task, fn: () => Promise<unknown>) => Promise<void>;
  onDiscuss?: (t: Task) => void;
  onClose: () => void;
  closable: boolean;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [thread, setThread] = useState<Thread | null>(null);
  useEffect(() => {
    setRejecting(false);
    setReason("");
    void fetchAudit(t.id, 50).then(setEvents).catch(() => {});
  }, [t.id, t.updatedAt]);
  useEffect(() => {
    setThread(null);
    if (t.source.threadId) void threadById(t.source.threadId).then(setThread).catch(() => {});
  }, [t.source.threadId]);

  const r = t.report;
  const pending = t.pending ?? [];
  const advice = pending[0]?.detail || t.plan || r?.summary || "";
  const situation = t.understanding || t.source.note || "";
  const links = [...new Set([...(thread?.items ?? []).flatMap((i) => extractUrls(i.text)), ...(t.source.url ? [t.source.url] : []), ...extractUrls(t.understanding ?? "")])];
  const open = t.status !== "done" && t.status !== "ignored";
  const rightHas = Boolean(r) || Boolean(t.progress && (situation || advice)) || pending.length > 1 || links.length > 0;

  const first = pending[0];
  const primary: { label: string; run: () => Promise<unknown> } | null = first
    ? { label: pending.length > 1 ? `通过并执行：${first.label}` : "通过并执行", run: () => taskApprove(t.id, first.id) }
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
      if (el?.closest(".drawer, .xterm")) return;
      e.preventDefault();
      void onAct(t, run);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [t.id, t.updatedAt, primary?.label]);

  return (
    <article className="fx">
      <div className="fx__meta">
        <span className={`dot dot--${t.status}`} />
        <span>{STATUS[t.status]} · {meta(t)}</span>
        {closable && <button className="b b--text" style={{ marginLeft: "auto", height: 22 }} onClick={onClose}>收起</button>}
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
              <span className="k">{pending[0] ? `Friday 的建议：${pending[0].label}` : t.plan ? "Friday 的方案" : "Friday 做了什么"}</span>
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
              <span className="k">通过前请确认</span>
              <ul className="fx__check">{r.verify.map((c, i) => <li key={i}><label><input type="checkbox" />{c}</label></li>)}</ul>
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
          <summary>交付报告：改动 {r.changes.length} 处 · 测试 {r.testSteps.length} 步 · 截图 {r.screenshots.length} 张</summary>
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
      {t.source.jobId && (
        <div className="fx__term">
          <span className="k">终端 · Claude Code 就在这条任务里干活，可以直接打字</span>
          <Terminal id={t.source.jobId} height={360} />
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

      {open && (
        <div className="fx__foot">
          <div className="fx__acts">
            {primary && <button className="b b--primary" onClick={() => void onAct(t, primary.run)}>{primary.label}<kbd>↵</kbd></button>}
            {!primary && <button className="b b--ghost" onClick={() => void onAct(t, () => taskSet(t.id, "done"))}>标记完成</button>}
            <button className="b b--ghost" onClick={() => setRejecting((v) => !v)}>打回</button>
            <button className="b b--text" onClick={() => void onAct(t, () => taskSet(t.id, "ignore"))}>忽略</button>
            <span className="fx__spacer" />
            {onDiscuss && <button className="b b--text" onClick={() => onDiscuss(t)}>{t.source.conversationId ? "继续会话" : "在会话里讨论"}</button>}
          </div>
          {rejecting && (
            <form className="fx__reject" onSubmit={(e) => { e.preventDefault(); void onAct(t, () => taskReject(t.id, reason || undefined)); }}>
              <input autoFocus placeholder="哪里不对？一句话，Friday 会按这个改" value={reason} onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setRejecting(false); }} />
              <button className="b b--ghost" type="submit">打回给 Friday</button>
            </form>
          )}
        </div>
      )}
    </article>
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
