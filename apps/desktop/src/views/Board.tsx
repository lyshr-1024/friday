import { useEffect, useState } from "react";
import type { AuditEvent, Desk, Task, TaskBoard, TaskStatus } from "@friday/shared";
import { audit as fetchAudit, auditUndo, createTask, desk as fetchDesk, taskApprove, taskBoard, taskReject, taskRetry, taskSet } from "../lib/core";
import { AttachmentStrip, DeskView, Linkified, fmtTime } from "./shared";
import { Terminal } from "./Terminal";

const SECTIONS: Array<{ key: string; statuses: TaskStatus[]; label: string; hint: string; collapsedByDefault?: boolean }> = [
  { key: "review", statuses: ["review"], label: "等你审核", hint: "Friday 做完了，看报告决定" },
  { key: "blocked", statuses: ["blocked"], label: "卡住", hint: "需要你介入或重新开工" },
  { key: "processing", statuses: ["processing"], label: "处理中", hint: "Friday 或 Claude Code 正在做" },
  { key: "queue", statuses: ["understood", "collected"], label: "排队中", hint: "看懂了在等时机，或还没做功课" },
  { key: "done", statuses: ["done"], label: "已完成", hint: "", collapsedByDefault: true },
];

const KIND: Record<string, string> = { slack: "Slack", meegle: "Meegle", verbal: "口头", doc: "文档", code: "代码", other: "其他" };
const RISK: Record<string, string> = { read: "只读", reversible: "可撤销", irreversible: "不可逆" };

export function Board({ onDiscuss, onOpenThread }: { onDiscuss?: (t: Task) => void; onOpenThread?: (id: string) => void }) {
  const [board, setBoard] = useState<TaskBoard | null>(null);
  const [deskData, setDeskData] = useState<Desk | null>(null);
  const [deskOpen, setDeskOpen] = useState(true);
  const [active, setActive] = useState<Task | null>(null);
  const [tab, setTab] = useState<"board" | "ledger">("board");
  const [ledger, setLedger] = useState<AuditEvent[]>([]);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ title: "", note: "", url: "" });
  const [err, setErr] = useState("");
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set(["done"]));

  const load = async () => {
    try {
      const b = await taskBoard();
      setBoard(b);
      setErr("");
      if (active) setActive(b.tasks.find((t) => t.id === active.id) ?? null);
    } catch (e) {
      // WebKit 的网络错误文案是 "Load failed"，对用户没意义
      const msg = e instanceof Error ? e.message : String(e);
      setErr(/load failed|fetch/i.test(msg) ? "连接 Friday 失败，15 秒后自动重试" : msg);
    }
  };
  useEffect(() => {
    void load();
    void fetchDesk().then(setDeskData).catch(() => {});
    const t = setInterval(() => void load(), 15000);
    const d = setInterval(() => void fetchDesk().then(setDeskData).catch(() => {}), 10 * 60_000);
    return () => {
      clearInterval(t);
      clearInterval(d);
    };
  }, []);
  useEffect(() => {
    if (tab === "ledger") void fetchAudit(active?.id, 300).then(setLedger).catch(() => {});
  }, [tab, active?.id]);

  async function act(fn: () => Promise<unknown>) {
    setErr("");
    try {
      await fn();
      await load();
      if (tab === "ledger") setLedger(await fetchAudit(active?.id, 300));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  const reviewCount = board?.counts.review ?? 0;

  return (
    <div className="board">
      <header className="board__head">
        <div className="board__tabs">
          <button className={tab === "board" ? "on" : ""} onClick={() => setTab("board")}>任务板{reviewCount ? <span className="board__badge">{reviewCount}</span> : null}</button>
          <button className={tab === "ledger" ? "on" : ""} onClick={() => setTab("ledger")} title="Friday 做过的每一步：为什么、怎么做、证据、能否撤销">操作记录</button>
        </div>
        <div className="board__actions">
          <button className="btn" onClick={() => setAdding((v) => !v)}>＋ 交代一件事</button>
          <button className="btn" onClick={() => void load()}>刷新</button>
        </div>
      </header>
      {err && <div className="err" style={{ margin: "8px 20px" }}>{err}</div>}

      {adding && (
        <form
          className="board__new"
          onSubmit={(e) => {
            e.preventDefault();
            if (!draft.title.trim()) return;
            void act(async () => {
              await createTask({ title: draft.title.trim(), ...(draft.note.trim() ? { note: draft.note.trim() } : {}), ...(draft.url.trim() ? { url: draft.url.trim() } : {}) });
              setDraft({ title: "", note: "", url: "" });
              setAdding(false);
            });
          }}
        >
          <input className="side__edit" placeholder="一句话：这件事是什么" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} autoFocus />
          <input className="side__edit" placeholder="补充说明（可选）" value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
          <input className="side__edit" placeholder="相关文档 / 工单链接（可选）" value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} />
          <button className="editor__save" type="submit">交给 Friday</button>
        </form>
      )}

      {tab === "board" && deskData && (
        <div className={`board__desk ${deskOpen ? "" : "board__desk--closed"}`}>
          <button className="board__desk-toggle" onClick={() => setDeskOpen((v) => !v)}>{deskOpen ? "收起" : `Hello ${deskData.name}！${deskData.greeting} · 展开今天的局面`}</button>
          {deskOpen && <DeskView d={deskData} onOpenThread={onOpenThread} />}
        </div>
      )}
      {tab === "board" && board && (
        <div className="board__body">
          <div className="board__list">
            {SECTIONS.map((sec) => {
              const list = board.tasks.filter((t) => sec.statuses.includes(t.status));
              const count = sec.statuses.reduce((n, st) => n + board.counts[st], 0);
              const collapsed = collapsedSections.has(sec.key);
              return (
                <section key={sec.key} className={`sec sec--${sec.key}`}>
                  <button className="sec__head" onClick={() => setCollapsedSections((c) => { const n = new Set(c); if (n.has(sec.key)) n.delete(sec.key); else n.add(sec.key); return n; })}>
                    <span className="sec__chev">{collapsed ? "›" : "⌄"}</span>
                    <span>{sec.label}</span>
                    <span className="col__count mono">{count}</span>
                    {!list.length && <span className="sec__hint">{sec.hint}</span>}
                  </button>
                  {!collapsed &&
                    (sec.key === "done" ? list.slice(0, 8) : list).map((t) => (
                      <button key={t.id} className={`tcard tcard--${t.priority} ${active?.id === t.id ? "tcard--active" : ""}`} onClick={() => setActive(t)}>
                        <div className="tcard__row">
                          <span className="tcard__meta mono">{KIND[t.kind] ?? t.kind}{t.project ? ` · ${t.project}` : ""}</span>
                          <span className="tcard__meta mono">{fmtTime(t.updatedAt)}</span>
                        </div>
                        <div className="tcard__title">{t.title}</div>
                        <div className="tcard__row">
                          {t.pending?.length ? <span className="tcard__pending">{t.pending.length} 个动作等你点</span> : null}
                          {t.progress && t.status !== "done" && <span className="tcard__progress">{t.progress.slice(0, 80)}</span>}
                        </div>
                      </button>
                    ))}
                </section>
              );
            })}
          </div>
          {active && (
            <aside className="tdetail">
              <TaskDetail t={active} onClose={() => setActive(null)} onAct={act} onDiscuss={onDiscuss} />
            </aside>
          )}
        </div>
      )}

      {tab === "ledger" && (
        <div className="ledger">
          <div className="ledger__filter mono">{active ? `只看任务：${active.title}` : "全部动作"}{active && <button onClick={() => setActive(null)}>清除筛选</button>}</div>
          {ledger.length === 0 && <div className="col__empty">还没有记录</div>}
          {ledger.map((e) => (
            <div key={e.id} className={`levent levent--${e.status}`}>
              <div className="levent__head">
                <span className="mono levent__time">{fmtTime(e.ts)}</span>
                <span className="levent__action">{e.action}</span>
                <span className={`levent__risk levent__risk--${e.risk}`}>{RISK[e.risk]}</span>
                <span className="mono levent__status">{e.status}</span>
                {e.reversible && e.status !== "undone" && <button className="levent__undo" onClick={() => void act(() => auditUndo(e.id))}>撤销</button>}
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
      )}
    </div>
  );
}

function TaskDetail({ t, onClose, onAct, onDiscuss }: { t: Task; onClose: () => void; onAct: (fn: () => Promise<unknown>) => Promise<void>; onDiscuss?: (t: Task) => void }) {
  const [reason, setReason] = useState("");
  const [events, setEvents] = useState<AuditEvent[]>([]);
  useEffect(() => {
    void fetchAudit(t.id, 50).then(setEvents).catch(() => {});
  }, [t.id, t.updatedAt]);
  const r = t.report;
  return (
    <>
      <header className="tdetail__head">
        <span className="tdetail__kind mono">{KIND[t.kind] ?? t.kind}{t.project ? ` · ${t.project}` : ""} · {t.status}</span>
        <button className="editor__back" onClick={onClose}>关闭</button>
      </header>
      <h2 className="tdetail__title">{t.title}</h2>
      {t.understanding && <Block k="Friday 的理解"><Linkified text={t.understanding} /></Block>}
      {t.plan && <Block k="方案">{t.plan.split("\n").map((l, i) => <div key={i}>{l}</div>)}</Block>}
      {t.progress && <Block k="进展">{t.progress}</Block>}
      {t.source.jobId && (
        <div className="tblock">
          <div className="k mono">终端 · 就在这里和 Claude Code 对话</div>
          <Terminal id={t.source.jobId} height={380} />
        </div>
      )}
      {t.source.note && <Block k="你交代的">{t.source.note}</Block>}
      {t.source.url && <Block k="链接"><Linkified text={t.source.url} /></Block>}

      {r && (
        <div className="report">
          <div className="report__title">交付报告</div>
          <Block k="概要">{r.summary}</Block>
          {r.changes.length > 0 && <Block k="改动"><ul>{r.changes.map((c, i) => <li key={i}>{c}</li>)}</ul></Block>}
          {r.testSteps.length > 0 && <Block k="测试过程"><ol>{r.testSteps.map((c, i) => <li key={i}>{c}</li>)}</ol></Block>}
          <Block k="测试结果">{r.testResult}</Block>
          {r.screenshots.length > 0 && <Block k="截图"><AttachmentStrip items={r.screenshots} /></Block>}
          {r.verify.length > 0 && (
            <Block k="请你验证">
              <ul className="report__verify">{r.verify.map((c, i) => <li key={i}><label><input type="checkbox" /> {c}</label></li>)}</ul>
            </Block>
          )}
        </div>
      )}

      {t.pending && t.pending.length > 0 && (
        <div className="pending">
          <div className="report__title">等你点头的动作</div>
          {t.pending.map((a) => (
            <div key={a.id} className="pending__item">
              <div className="pending__label">{a.label}</div>
              <div className="pending__detail">{a.detail}</div>
              <div className="inbox__actions">
                <button className="inbox__go" onClick={() => void onAct(() => taskApprove(t.id, a.id))}>通过并执行</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="tdetail__ops">
        <input className="side__edit" placeholder="打回原因（可选）" value={reason} onChange={(e) => setReason(e.target.value)} />
        <div className="inbox__actions">
          {(t.status === "blocked" || t.status === "processing") && t.project && <button className="inbox__go" onClick={() => void onAct(() => taskRetry(t.id))}>重新开工</button>}
          {t.status !== "done" && <button onClick={() => void onAct(() => taskReject(t.id, reason || undefined))}>打回</button>}
          {t.status !== "done" && <button onClick={() => void onAct(() => taskSet(t.id, "done"))}>标记完成</button>}
          {t.status !== "ignored" && <button onClick={() => void onAct(() => taskSet(t.id, "ignore"))}>忽略</button>}
          {onDiscuss && <button className="inbox__go" onClick={() => onDiscuss(t)}>在会话里讨论</button>}
        </div>
      </div>

      {events.length > 0 && (
        <Block k="这条任务的账">
          <ul className="tdetail__events">
            {events.map((e) => <li key={e.id}><span className="mono">{fmtTime(e.ts)}</span> {e.action} — {e.why}</li>)}
          </ul>
        </Block>
      )}
    </>
  );
}

function Block({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="tblock">
      <div className="k mono">{k}</div>
      <div className="tblock__body">{children}</div>
    </div>
  );
}
