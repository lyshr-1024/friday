import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { BACKEND_TAGS, taskCategory, type AuditEvent, type PendingAction, type StateTransition, type Task, type TaskBoard, type TaskCategory, type TaskStatus, type TerminalState, type SlackConversation } from "@friday/shared";
import type { Activity } from "../lib/core";
import type { FridayEvent } from "../lib/events";
import { audit as fetchAudit, auditUndo, inbox as fetchInbox, jobActivity, settings, syncMeegle, taskApprove, taskBoard, taskConfirmNode, taskDelete, taskEdit, taskNode, taskPin, taskResearch, taskRetry, taskSet, taskStart, taskCreate, taskTransition, taskTransitions, taskVerify, detachConversation, jobFocus, jobReopen, projectList, taskSetProject, taskSetDocs, taskMerge } from "../lib/core";
import { AttachmentStrip, Linkified, decodeSlack, extractUrls, fmtTime, Picker } from "./shared";
import { Icon } from "./Icon";

export type BoardView = "queue" | "doing" | "all" | "ledger";

const KIND: Record<string, string> = { slack: "Slack", meegle: "Meegle", verbal: "口头", doc: "文档", code: "代码", learn: "自学", handbook: "手册", other: "其他" };
const RISK: Record<string, string> = { read: "只读", reversible: "可撤销", irreversible: "不可逆" };
const STATUS: Record<TaskStatus, string> = { review: "等你决定", blocked: "卡住了", processing: "Friday 在做", understood: "待办", collected: "刚收到", done: "已完成", ignored: "已忽略" };
const DECIDE: TaskStatus[] = ["review", "blocked"];
const DOING: TaskStatus[] = ["processing"];
const QUEUED: TaskStatus[] = ["understood", "collected"];
const ALL_ORDER: TaskStatus[] = ["review", "blocked", "processing", "understood", "collected", "done", "ignored"];
const PRIORITY: Record<string, number> = { high: 0, normal: 1, low: 2 };

/** 自学任务的完整研究笔记：展开才拉，社区做法和链接都在里面 */
function ResearchNote({ id, file }: { id: string; file: string }) {
  const [note, setNote] = useState<string | null>(null);
  return (
    <details className="fx__more" onToggle={(e) => { if ((e.currentTarget as HTMLDetailsElement).open && note === null) void taskResearch(id).then((r) => setNote(r.content)).catch(() => setNote("")); }}>
      <summary>完整研究笔记 · {file.replace(/^research\//, "")}</summary>
      <div className="fx__more-body">
        {note === null ? <span className="muted">读取中…</span> : note ? <pre className="fx__note"><Linkified text={note} /></pre> : <span className="muted">笔记文件已不在</span>}
      </div>
    </details>
  );
}


/** 点下去会发生什么。不可逆的动作必须先说清楚，否则用户不敢按。 */
function consequence(a: PendingAction, conv?: SlackConversation): string | null {
  if (a.type === "slack_reply") {
    const who = String(a.payload.userName ?? "对方");
    const where = a.payload.threadTs
      ? `回在 ${who} 那条下面${conv?.channelName ? `（${conv.channelName}）` : ""}`
      : `发到与 ${who} 的私聊`;
    return `以你的身份${where}。发出后撤不回，会记进操作记录。`;
  }
  if (a.type === "git_merge") {
    return "把这个分支合进主干。合完可以在操作记录里撤销。";
  }
  if (a.type === "start_job") {
    const p = String(a.payload.project ?? "这个项目");
    const conf = typeof a.payload.confidence === "number" ? `Friday 对这次判断的把握是 ${a.payload.confidence} 分。` : "";
    return `在 ${p} 起一个终端，让 Claude Code 按上面这段去改。它在新分支上动手、不推远端也不合并，改完交报告给你验。${conf}`;
  }
  return null;
}

/** 处理完一条之后接着看哪条：先往下找，没有就往上回退，都没有才不选。 */
function neighbourOf(id: string, order: string[], live: Task[]): string | null {
  const at = order.indexOf(id);
  if (at < 0) return null;
  const alive = new Set(live.map((t) => t.id));
  return [...order.slice(at + 1), ...order.slice(0, at).reverse()].find((x) => x !== id && alive.has(x)) ?? null;
}

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

function dueLabel(iso: string): string {
  const days = Math.round((new Date(iso).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000);
  if (days < 0) return `逾期 ${-days} 天`;
  if (days === 0) return "今天到期";
  if (days === 1) return "明天到期";
  return `${days} 天后到期`;
}

const isIssue = (t: Task) => taskCategory(t.source) === "defect";
const isStory = (t: Task) => taskCategory(t.source) === "story";
const DOC_LABELS: Array<[keyof NonNullable<Task["source"]["docs"]>, string]> = [["req", "需求文档"], ["tech", "技术文档"], ["design", "设计稿"], ["meegle", "Meegle"]];

function OpenLink({ href, children }: { href: string; children: React.ReactNode }) {
  return <a href={href} className="link" onClick={(e) => { e.preventDefault(); void openUrl(href); }}>{children}</a>;
}

/** Meegle 的描述是 Markdown，只用得上加粗和换行，为此引一个库不值当 */
function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split("\n").map((line, i) => (
        <p key={i} className="fx__rline">
          {line.split(/(\*\*[^*]+\*\*)/g).map((part, j) =>
            part.startsWith("**") && part.endsWith("**") ? <strong key={j}>{part.slice(2, -2)}</strong> : <Linkified key={j} text={part} />,
          )}
        </p>
      ))}
    </>
  );
}

function MeegleChips({ t }: { t: Task }) {
  // 只留优先级和回原工单的链接。迭代标签、当前节点、提出人跟「这条要写什么代码」无关
  if (t.priority !== "high" && !t.source.url) return null;
  return (
    <div className="fx__chips">
      {t.priority === "high" && <span className="fx__chip">高优先级</span>}
      {t.source.url && <OpenLink href={t.source.url}>在 Meegle 打开 ↗</OpenLink>}
    </div>
  );
}

function IssueBody({ t }: { t: Task }) {
  const [full, setFull] = useState(false);
  const desc = t.source.description ?? "";
  // 芯片归 TaskBody 统一渲染，这儿只管缺陷描述
  return (
    <>
      {desc && (
        <div>
          <span className="k">DEFECT</span>
          <div className={`fx__desc ${full ? "" : "fx__desc--clip"}`}><Rich text={desc} /></div>
          <button className="b b--text" onClick={() => setFull((v) => !v)}>{full ? "收起" : "展开全文"}</button>
        </div>
      )}
    </>
  );
}

/** 四个链接栏，存下来就是一篇文档的地址。Meegle 那栏跟同步无关，只是个链接。 */
function DocsEditor({ t, onAct, onDone }: { t: Task; onAct: (t: Task, fn: () => Promise<unknown>) => Promise<void>; onDone: () => void }) {
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(DOC_LABELS.map(([k]) => [k, t.source.docs?.[k] ?? ""])),
  );
  const [err, setErr] = useState("");
  const save = async () => {
    const bad = DOC_LABELS.find(([k]) => draft[k] && !/^https?:\/\//i.test(draft[k]!.trim()));
    if (bad) { setErr(`${bad[1]} 得是 http/https 开头的完整链接`); return; }
    setErr("");
    await onAct(t, () => taskSetDocs(t.id, Object.fromEntries(DOC_LABELS.map(([k]) => [k, draft[k]?.trim() ?? ""]))));
    onDone();
  };
  return (
    <div className="fx__docs-edit">
      {DOC_LABELS.map(([k, label]) => (
        <label key={k} className="fx__docs-row">
          <span className="fx__docs-label">{label}</span>
          <input
            className="fx__docs-input"
            type="url"
            inputMode="url"
            placeholder="贴链接，留空就是没有"
            value={draft[k] ?? ""}
            onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void save(); } if (e.key === "Escape") { e.preventDefault(); onDone(); } }}
          />
        </label>
      ))}
      {err && <span className="fx__docs-err">{err}</span>}
      <div className="fx__docs-acts">
        <button className="b b--primary" onClick={() => void save()}>保存</button>
        <button className="b b--text" onClick={onDone}>取消</button>
      </div>
    </div>
  );
}

/**
 * 任务卡的主体。所有任务都渲染同一套结构——项目、并入、排期、文档——
 * 每块按「有没有数据」决定露不露面，而不是按来源。口头交代的事和 Meegle
 * 同步下来的工单长得一样，差别只在它没有工单号、排期这些同步来的字段。
 */
function TaskBody({ t, all, onAct }: { t: Task; all: Task[]; onAct: (t: Task, fn: () => Promise<unknown>) => Promise<void> }) {
  const { feDue, beDue, docs } = t.source;
  const links = DOC_LABELS.filter(([k]) => docs?.[k]);
  // 合并进来的需求各自带着文档：一期二期的资料都要在这儿点得到
  const mergedDocs = (t.source.merged ?? [])
    .map((m) => ({ ...m, docs: m.docs ?? {}, links: DOC_LABELS.filter(([k]) => m.docs?.[k]) }))
    .filter((m) => m.links.length > 0);
  const [projects, setProjects] = useState<Array<{ name: string; dir: string }>>([]);
  const [merging, setMerging] = useState<Task | null>(null);
  const [editDocs, setEditDocs] = useState(false);
  // to 用 null 表示「改成没定」，所以开合得另拿一个字段，不能靠 null 兼职
  const [switching, setSwitching] = useState<{ to: string | null } | null>(null);
  const hasTerm = Boolean(t.source.jobId) && t.terminal !== "gone" && t.status === "processing";
  useEffect(() => { void projectList().then(setProjects).catch(() => {}); }, []);
  // 能并进来的：别的任务，不看项目也不看状态。Slack 线程除外——那是一段对话，
  // 并进来没有意义。项目多数还没定，要合的那条也可能已经收工了，都不拦。
  const bases = all.filter((x) => x.id !== t.id && taskCategory(x.source) !== "slack" && x.status !== "done" && x.status !== "ignored");
  return (
    <div className="fx__story">
      <MeegleChips t={t} />
      <div>
        <span className="k">项目</span>
        <div className="fx__base">
          <Picker
            label="这条工单改哪个仓库"
            placeholder="没定（选了才能开工）"
            value={t.project ?? ""}
            options={[{ value: "", label: "没定" }, ...projects.map((p) => ({ value: p.name, label: p.name, hint: p.dir.replace(/^\/Users\/[^/]+/, "~") }))]}
            onPick={(v) => {
              // 终端还开着就先问一句：关掉它意味着里面没提交的改动要自己去收
              if (hasTerm && (v || null) !== (t.project ?? null)) setSwitching({ to: v || null });
              else void onAct(t, () => taskSetProject(t.id, v || null));
            }}
          />
          {!t.project && <span className="fx__meta-dim">Friday 不猜项目——选了才能开工</span>}
        </div>
      </div>
      {bases.length > 0 && (
        <div>
          <span className="k">并入这条</span>
          <div className="fx__base">
            <Picker
              label="把另一条需求并进这条"
              placeholder="选一条并进来…"
              resetAfterPick
              options={bases.map((x) => ({ value: x.id, label: x.title.slice(0, 34), ...(x.source.meegleId ? { hint: `#${x.source.meegleId}` } : {}) }))}
              onPick={(v) => { const from = bases.find((x) => x.id === v); if (from) setMerging(from); }}
            />
            {(t.source.merged ?? []).length > 0 && (
              <span className="fx__merged">
                已并入
                {(t.source.merged ?? []).map((m) =>
                  m.url ? (
                    <OpenLink key={m.meegleId} href={m.url}>#{m.meegleId} {m.title.slice(0, 22)}</OpenLink>
                  ) : (
                    <span key={m.meegleId}>#{m.meegleId} {m.title.slice(0, 22)}</span>
                  ),
                )}
              </span>
            )}
          </div>
        </div>
      )}
      {(feDue || beDue) && (
        <div>
          <span className="k">SCHEDULE</span>
          <div className="fx__text">{[feDue && `后台前端 ${feDue}`, beDue && `服务端 ${beDue}`].filter(Boolean).join(" · ")}</div>
        </div>
      )}
      {switching && (
        <div className="modal" onMouseDown={() => setSwitching(null)}>
          <div className="modal__box modal__box--ask" onMouseDown={(e) => e.stopPropagation()} role="alertdialog" aria-label="切换项目">
            <strong className="modal__title">改到 {switching.to ?? "没定"}？现在这个终端会关掉</strong>
            <p className="modal__note">终端开在 {t.project} 的目录里，换了项目它就用不上了。里面没提交的改动要自己去收——关掉之后 Friday 接不回来。任务会退回待办，等你点「开始做」在新项目上重开。</p>
            <div className="modal__foot">
              <button className="b b--primary" autoFocus onClick={() => { const v = switching.to; setSwitching(null); void onAct(t, () => taskSetProject(t.id, v)); }}>关掉终端，改项目</button>
              <button className="b b--text" onClick={() => setSwitching(null)}>取消</button>
            </div>
          </div>
        </div>
      )}
      {merging && (
        <div className="modal" onMouseDown={() => setMerging(null)}>
          <div className="modal__box modal__box--ask" onMouseDown={(e) => e.stopPropagation()} role="alertdialog" aria-label="合并需求">
            <strong className="modal__title">把「{merging.title.slice(0, 30)}」并进这条？</strong>
            <p className="modal__note">它会从任务板上消失，工单号记在这条名下，同步不会再把它拉回来。可以在操作记录里撤销。</p>
            <div className="modal__foot">
              <button className="b b--primary" autoFocus onClick={() => { const f = merging; setMerging(null); void onAct(t, () => taskMerge(t.id, f.id)); }}>合并</button>
              <button className="b b--text" onClick={() => setMerging(null)}>取消</button>
            </div>
          </div>
        </div>
      )}
      <div>
        <div className="fx__docs-head">
          <span className="k">DOCS</span>
          <button className="b b--text" aria-expanded={editDocs} onClick={() => setEditDocs((v) => !v)}>
            {editDocs ? "收起" : links.length ? "改链接" : "贴链接"}
          </button>
        </div>
        {links.length > 0 && !editDocs && (
          <div className="fx__docs">{links.map(([k, label]) => <OpenLink key={k} href={docs![k]!}>{label} ↗</OpenLink>)}</div>
        )}
        {!links.length && !editDocs && <span className="fx__meta-dim">还没有链接</span>}
        {editDocs && <DocsEditor t={t} onAct={onAct} onDone={() => setEditDocs(false)} />}
        {/* 并进来那些需求的文档也要点得到，标明是谁的 */}
        {mergedDocs.map((m) => (
          <div key={m.meegleId} className="fx__docs fx__docs--merged">
            <span className="fx__meta-dim">#{m.meegleId} {m.title.slice(0, 16)}</span>
            {m.links.map(([k, label]) => <OpenLink key={k} href={m.docs[k]!}>{label} ↗</OpenLink>)}
          </div>
        ))}
      </div>
    </div>
  );
}

/** 0 后台前端已排期 · 1 仅服务端已排期 · 2 标签含后台迭代/纳入 · 3 其余 */
function todoTier(t: Task): number {
  if (t.source.feDue) return 0;
  if (t.source.beDue) return 1;
  if (t.source.meegleTags?.some((x) => BACKEND_TAGS.includes(x))) return 2;
  return 3;
}

/** 先按排期档位，档内按排期日近→远，再按优先级、截止日 */
function byTier(a: Task, b: Task): number {
  const tier = todoTier(a);
  if (tier !== todoTier(b)) return tier - todoTier(b);
  const due = (t: Task) => (tier === 0 ? t.source.feDue : tier === 1 ? t.source.beDue : "") ?? "";
  return (
    due(a).localeCompare(due(b)) ||
    (PRIORITY[a.priority] ?? 1) - (PRIORITY[b.priority] ?? 1) ||
    (a.due ?? "9").localeCompare(b.due ?? "9") ||
    b.updatedAt.localeCompare(a.updatedAt)
  );
}

/**
 * 锚点上那行小字：只说客观事实——数得出来的（几条缺陷、几个验收点）、
 * 日期算出来的（逾期几天）、别处已经写好的（工单优先级）。
 * 不放 Friday 自己的判断（「这轮做完了」「等你看」「卡住了」这类）：
 * 那是它的结论不是事实，真要看结论展开卡片自己读。
 */
function anchorSub(t: Task, nested = 0, derived = 0): string {
  const kids = nested > 0 ? `${nested} 条缺陷要改` : derived > 0 ? `${derived} 条待办要跟进` : "";
  if (t.status === "done" || t.status === "ignored") return fmtTime(t.updatedAt);
  const fact = factRight(t);
  return [kids, fact].filter(Boolean).join(" · ") || queuedRight(t);
}

/** 数得出来、算得出来的那些；一条都没有就返回空，交给 queuedRight 兜底 */
function factRight(t: Task): string {
  const bits: string[] = [];
  if (t.pending?.length) bits.push(`${t.pending.length} 个动作等你点头`);
  if (t.report?.verify.length) bits.push(`${t.report.verify.length} 个验收点`);
  const { feDue, beDue } = t.source;
  const due = feDue ?? beDue ?? t.due;
  if (due) bits.push(dueLabel(due.length === 10 ? `${due}T00:00:00` : due));
  return bits.join(" · ");
}

function queuedRight(t: Task): string {
  const { feDue, beDue } = t.source;
  if (feDue) {
    const d = Math.round((new Date(`${feDue}T00:00:00`).getTime() - new Date().setHours(0, 0, 0, 0)) / 86400000);
    return d < 0 ? `逾期 ${-d} 天` : d === 0 ? "今天到期" : `排期 ${feDue.slice(5)}`;
  }
  if (beDue) return `服务端 ${beDue.slice(5)}`;
  if (t.due) return dueLabel(t.due);
  if (t.progress) return t.progress.slice(0, 40);
  return `${KIND[t.kind] ?? t.kind}${t.priority === "high" ? " · 高优先级" : ""}`;
}

const ATTENTION_NOTE: Record<string, string> = {
  question: " · 终端在问你，回答前它不会继续",
  intake: " · Friday 有个问题要问你",
  review: " · 这轮做完了，等你看",
  blocked: " · 卡住了，需要你",
};

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

export function Board({ view, nav, tools, onCounts, onQueueCounts, onFocusChange, runningConvs }: {
  view: BoardView;
  /** 顶栏那一行视图切换，由 Chat 给——它知道当前是哪个视图 */
  nav?: React.ReactNode;
  tools: React.ReactNode;
  /** Friday 正在生成中的会话 id：对应任务条目上显示青条 */
  runningConvs?: Set<string>;
  onCounts?: (c: { decide: number; doing: number }) => void;
  /** 待办四组各有几条，左栏锚点用 */
  onQueueCounts?: (c: Record<TaskCategory, number>) => void;
  onFocusChange?: (t: Task | null) => void;
}) {
  const [board, setBoard] = useState<TaskBoard | null>(null);
  const [name, setName] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const deckRef = useRef<HTMLDivElement | null>(null);
  const qRef = useRef<HTMLInputElement | null>(null);
  // ⌘F 搜索结果里点了一条任务：选中它（视图已由 Chat 切到「全部任务」）
  useEffect(() => {
    const onOpen = (e: Event) => setSelectedId((e as CustomEvent<string>).detail);
    window.addEventListener("friday:open-task", onOpen);
    return () => window.removeEventListener("friday:open-task", onOpen);
  }, []);
  // 左栏点了待办分组的锚点：展开那组再滚过去。滚动放在 effect 里，等展开渲染完才有正确位置
  const [jumpTo, setJumpTo] = useState<TaskCategory | null>(null);
  useEffect(() => {
    const onJump = (e: Event) => {
      const cat = (e as CustomEvent<TaskCategory>).detail;
      setJumpTo(cat);
    };
    window.addEventListener("friday:jump-group", onJump);
    return () => window.removeEventListener("friday:jump-group", onJump);
  }, []);
  useEffect(() => {
    if (!jumpTo) return;
    document.querySelector(`[data-group="${jumpTo}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
    setJumpTo(null);
  }, [jumpTo]);
  // 列表此刻从上到下的可见顺序，处理完一条要靠它找到相邻的下一条
  const orderRef = useRef<string[]>([]);
  const [packBusy, setPackBusy] = useState("");
  const [err, setErr] = useState("");
  const [ledger, setLedger] = useState<AuditEvent[]>([]);

  const failures = useRef(0);
  const load = async () => {
    try {
      const b = await taskBoard();
      setBoard(b);
      setErr("");
      failures.current = 0;
      // 侧栏「Friday 在做」的数字要和页面上那个分组一致：只算 processing，待办另有分组
      // 在等你回答的（终端问的 / Friday 问的）不管什么状态都算进「待我决定」，和列表分组保持一致；
      // review / blocked 已经在 counts 里，别重复计一遍
      const waiting = b.tasks.filter((t) => (t.attention === "question" || t.attention === "intake") && t.status !== "review" && t.status !== "blocked").length;
      onCounts?.({ decide: b.counts.review + b.counts.blocked + waiting, doing: b.counts.processing });
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
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
      window.removeEventListener("friday:tasks-changed", onChanged);
      window.removeEventListener("friday:event", onEvent);
      window.clearTimeout(coalesce);
    };
  }, []);
  // 终端忙闲：实时推送的值优先于任务板快照
  const [termStates, setTermStates] = useState<Map<string, TerminalState>>(new Map());
  useEffect(() => {
    if (view === "ledger") void fetchAudit(undefined, 300).then(setLedger).catch(() => {});
  }, [view]);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [allProjects, setAllProjects] = useState<Array<{ name: string; dir: string }>>([]);
  useEffect(() => { void projectList().then(setAllProjects).catch(() => {}); }, []);
  const [slackSyncing, setSlackSyncing] = useState(false);
  const [slackNote, setSlackNote] = useState<string | null>(null);
  async function doSlackSync() {
    setSlackSyncing(true);
    setSlackNote(null);
    try {
      const r = (await fetchInbox(true)) as Awaited<ReturnType<typeof fetchInbox>> & { added?: number };
      if (!r.configured) setErr("Slack 没接入：跑一下 scripts/slack-auth.sh");
      else if (r.lastError) setErr(`Slack 同步失败：${r.lastError}`);
      else setSlackNote(r.added ? `+${r.added} 条` : "没有新消息");
      void load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSlackSyncing(false);
      window.setTimeout(() => setSlackNote(null), 4000);
    }
  }
  async function doSync() {
    setSyncing(true);
    setSyncNote(null);
    try {
      const r = await syncMeegle();
      if (r.error) setErr(`Meegle 同步失败：${r.error}`);
      else setSyncNote(r.added || r.closed || r.reopened ? [r.added ? `+${r.added}` : "", r.reopened ? `重开 ${r.reopened}` : "", r.closed ? `完成 ${r.closed}` : ""].filter(Boolean).join(" / ") : "没有变化");
      void load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
      window.setTimeout(() => setSyncNote(null), 4000);
    }
  }

  /**
   * 一包缺陷一起开工：逐条执行各自的开工动作。有一条失败就停下来把错误摆出来，
   * 后面几条留在原地——闷头跑完只会让人不知道哪几条真的开起来了。
   */
  async function startPack(items: Task[]) {
    const key = items[0]?.source.linkedStoryId ?? "";
    setPackBusy(key);
    try {
      for (const t of items) {
        const a = t.pending?.find((x) => x.type === "start_job");
        if (a) await taskApprove(t.id, a.id);
      }
      setErr("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPackBusy("");
      setBoard(await taskBoard().catch(() => board!));
    }
  }

  const [menu, setMenu] = useState<{ t: Task; x: number; y: number } | null>(null);
  const [editing, setEditing] = useState<Task | null>(null);
  const [deleting, setDeleting] = useState<Task | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  async function act(t: Task | null, fn: () => Promise<unknown>) {
    setErr("");
    // 操作前的顺序才包含被操作的那条，拿它去找相邻项
    const order = orderRef.current;
    try {
      await fn();
      const b = await taskBoard();
      setBoard(b);
      const after = t ? b.tasks.find((x) => x.id === t.id) : undefined;
      // 处理完接着看相邻的那条。清空选中会让焦点回落到 pinned[0] / decide[0]，
      // 而刚操作的那条常常根本不在顶上那个分组里，看着就是整个列表跳走了。
      if (t && (!after || after.status !== t.status)) setSelectedId(neighbourOf(t.id, order, b.tasks));
      if (view === "ledger") setLedger(await fetchAudit(undefined, 300));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  const tasks = (board?.tasks ?? []).map((t) => (t.source.jobId && termStates.has(t.source.jobId) && t.status === "processing" ? { ...t, terminal: termStates.get(t.source.jobId) } : t));
  const active = (t: Task) => (t.status === "processing" && Boolean(t.source.jobId) && t.terminal !== "gone") || Boolean(runningConvs?.has(t.source.conversationId ?? ""));
  // 星标的单独一组放最顶上，其余分组里不再出现
  const pinned = tasks.filter((t) => t.pinned && t.status !== "done" && t.status !== "ignored").sort(byActivity(active));
  const rest = tasks.filter((t) => !pinned.includes(t));
  const asking = (t: Task) => t.attention === "question" || t.attention === "intake";
  // 需求那条在列表里时，它名下的缺陷不再各自占一行——点开需求就能看到它们。
  // 需求不在（没分派也没我的角色）的缺陷仍然独立显示，否则就没地方看了。
  const storyIds = new Set(
    tasks.flatMap((t) => [...(t.source.meegleId ? [t.source.meegleId] : []), ...(t.source.mergedMeegleIds ?? [])]),
  );
  const nested = (t: Task) => Boolean(t.source.linkedStoryId && storyIds.has(t.source.linkedStoryId));
  // 有人在等你回答（终端问的，或 Friday 自己问的）= 阻塞，不管状态都进「待我决定」并排最前
  const decide = rest.filter((t) => (DECIDE.includes(t.status) || asking(t)) && !nested(t)).sort((a, b) => Number(asking(b)) - Number(asking(a)) || sortDecide(a, b));
  // 在做的分两组，不能混：「Friday 在做」是全权代理（claude -p，无人值守，
  // 跑完自己进 review），「我在做」是我点「开始做」自己在终端里干的活。
  // 两者的下一步完全不同——前者等它交付，后者等我自己收工。
  const doing = rest.filter((t) => DOING.includes(t.status) && t.source.autonomous && !asking(t) && !nested(t)).sort(byActivity(active));
  const mine = rest.filter((t) => DOING.includes(t.status) && !t.source.autonomous && !asking(t) && !nested(t)).sort(byActivity(active));
  /** 这条需求名下还有几条没完的缺陷，列表右侧要显示 */
  const nestedCount = (t: Task) => {
    const mine = new Set([...(t.source.meegleId ? [t.source.meegleId] : []), ...(t.source.mergedMeegleIds ?? [])]);
    if (!mine.size) return 0;
    return tasks.filter((x) => x.source.linkedStoryId && mine.has(x.source.linkedStoryId) && x.status !== "done" && x.status !== "ignored").length;
  };
  // 情境卡从 Slack 线程派生出来的待办：线程那条还在时它们说的是同一件事，不再单独占一行，
  // 跟缺陷挂需求一样收进父任务里看。线程已经收工的留着独立显示，那才是真正剩下的事。
  const liveIds = new Set(tasks.filter((t) => t.status !== "done" && t.status !== "ignored").map((t) => t.id));
  const derived = (t: Task) => Boolean(t.source.fromTaskId && liveIds.has(t.source.fromTaskId));
  const derivedCount = (t: Task) => tasks.filter((x) => x.source.fromTaskId === t.id && x.status !== "done" && x.status !== "ignored").length;
  const queued = rest.filter((t) => QUEUED.includes(t.status) && !nested(t) && !derived(t)).sort(byTier);
  // 待办按来源拆开：Slack 一组、Meegle 的需求与缺陷各一组，口头 / 自学等归「其他」。
  const QUEUE_GROUPS: TaskCategory[] = ["slack", "defect", "story", "other"];
  const queuedBy = (c: TaskCategory) => queued.filter((t) => taskCategory(t.source) === c);
  const queueCounts = Object.fromEntries(QUEUE_GROUPS.map((c) => [c, queuedBy(c).length])) as Record<TaskCategory, number>;
  const queueKey = QUEUE_GROUPS.map((c) => queueCounts[c]).join(",");
  useEffect(() => {
    onQueueCounts?.(queueCounts);
  }, [queueKey]);
  // 轮播一次只显示一条，所以要一个扁平序列；分组只剩右侧锚点在用。
  const anchorGroups = useMemo(() => {
    const raw: Array<{ label: string; items: Task[] }> =
      view === "all"
        ? ALL_ORDER.map((st) => ({ label: STATUS[st], items: tasks.filter((t) => t.status === st) }))
        : [
            { label: "待我决定", items: decide },
            { label: "关注", items: pinned.filter((t) => !DECIDE.includes(t.status)) },
            { label: "我在做", items: mine },
            { label: "Friday 在做", items: doing },
            { label: "待办", items: queued },
          ];
    const k = q.trim().toLowerCase();
    const hit = (t: Task) =>
      !k ||
      [t.title, t.project, t.understanding, t.source.branch, t.source.meegleId, t.source.linkedStoryName]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(k));
    return raw.map((g) => ({ ...g, items: g.items.filter(hit) })).filter((g) => g.items.length);
  }, [tasks, decide, pinned, mine, doing, queued, view, q]);
  const flat = useMemo(() => anchorGroups.flatMap((g) => g.items), [anchorGroups]);
  // 处理完一条自动跳到相邻那条，顺序就是轮播的顺序
  orderRef.current = flat.map((t) => t.id);
  const ids = flat.map((t) => t.id).join(",");
  const explicit = selectedId ? tasks.find((t) => t.id === selectedId) ?? null : null;
  const focus = (explicit && flat.some((t) => t.id === explicit.id) ? explicit : null) ?? flat[0] ?? null;
  useEffect(() => {
    onFocusChange?.(focus ?? null);
  }, [focus?.id]);
  // 自己发起的滚动期间不让观察者接管：平滑滚动会经过中间那些卡，
  // 观察者一接管就把选中改成途经的那张，滚动被半路劫持，跳不到点的那条
  const settlingRef = useRef(0);
  // 选中变了 → 把那张卡滚进视野，右侧锚点跟着走
  useEffect(() => {
    if (!focus) return;
    const card = deckRef.current?.querySelector(`[data-id="${focus.id}"]`);
    if (card) {
      settlingRef.current = Date.now();
      card.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
    }
    document.querySelector('.an[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
  }, [focus?.id]);
  // 滚到哪张就选哪张。只在用户真的自己滚过之后才接管，否则首帧会把默认选中顶掉。
  useEffect(() => {
    const root = deckRef.current;
    if (!root || flat.length < 2) return;
    let scrolled = false;
    const onScroll = () => { scrolled = true; };
    root.addEventListener("scroll", onScroll, { passive: true });
    const io = new IntersectionObserver(
      (es) => {
        if (!scrolled) return;
        // 平滑滚动最多几百毫秒，这期间的经过不算用户在翻页
        if (Date.now() - settlingRef.current < 700) return;
        const best = es.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        const id = (best?.target as HTMLElement | undefined)?.dataset.id;
        if (id) setSelectedId(id);
      },
      { root, threshold: [0.55, 0.9] },
    );
    root.querySelectorAll(".deck__card").forEach((el) => io.observe(el));
    return () => { io.disconnect(); root.removeEventListener("scroll", onScroll); };
  }, [ids]);
  // ↑↓ 翻页、⌘K 搜索。焦点在输入框或终端里时不抢。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); qRef.current?.focus(); qRef.current?.select(); return; }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable || el.closest(".xterm"))) return;
      const i = flat.findIndex((t) => t.id === focus?.id);
      const next = flat[e.key === "ArrowDown" ? Math.min(i + 1, flat.length - 1) : Math.max(i - 1, 0)];
      if (next && next.id !== focus?.id) { e.preventDefault(); setSelectedId(next.id); }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [ids, focus?.id]);
  const title = view === "ledger" ? "操作记录" : view === "all" ? "全部任务" : "待我决定";
  const count = view === "ledger" ? ledger.length : view === "all" ? tasks.length : decide.length;
  const liveTerminals = tasks.filter((t) => t.terminal === "busy" || (t.status === "processing" && t.source.jobId)).length;
  const blockedCount = tasks.filter((t) => t.status === "blocked" || t.attention === "blocked" || t.attention === "question").length;

  // 左栏一条：状态点 + 标题（最多两行）+ 一句状态；选哪条右边就换哪条
  /** 一组里的行：同一个需求下的缺陷先收成一包，剩下的照常一条一行 */

  return (
    <>
      <header className="q__head q__head--wide" data-tauri-drag-region>
        {nav}
        <div className="q__row" data-tauri-drag-region>
          <div className="q__title" data-tauri-drag-region>
            <h1 data-tauri-drag-region>{title}</h1>
            {board ? <span className="q__count">{count} {view === "ledger" ? "条" : "件"}</span> : !err && <span className="q__count">正在连接 Friday…</span>}
          </div>
          <div className="q__tools">{tools}</div>
        </div>
        {/* 读数条把「几件在等你」说得更清楚，这里只留一句问候 */}
        {board && name && <p className="q__sub" data-tauri-drag-region>{`Hello ${name}！`}{greeting()}。</p>}
      </header>
      {board && view !== "ledger" && (
        <div className="gauges">
          <Gauge k="AWAITING YOU" v={decide.length} u="TASKS" tone={decide.length ? "warn" : ""} max={8} />
          <Gauge k="TERMINALS" v={liveTerminals} u="ACTIVE" tone={liveTerminals ? "hot" : ""} max={4} />
          <Gauge k="BLOCKED" v={blockedCount} u="TASK" tone={blockedCount ? "bad" : ""} max={4} />
          {/* 在做的两组加一起：读数条只报总量，谁在做由页面上那两个分组说清 */}
          <Gauge k="IN PROGRESS" v={doing.length + mine.length} u="ITEMS" tone="" max={8} />
          <Gauge k="QUEUED" v={queued.length} u="ITEMS" tone="" max={20} />
        </div>
      )}
      {view === "ledger" ? (
        <div className="wb__scroll">
          <div className="wb__page">
            {err && <div className="err" style={{ marginBottom: 16 }}>{err}</div>}
            {board && <Ledger events={ledger} onUndo={(id) => void act(null, () => auditUndo(id))} />}
          </div>
        </div>
      ) : (
        <div className="deck">
          {creating && <NewTask projects={allProjects} onClose={() => setCreating(false)} onDone={() => { setCreating(false); void load(); }} />}
          <div className="deck__stage">
            {err && <div className="err" style={{ margin: "0 0 12px" }}>{err}</div>}
            <label className="find">
              <span className="find__k mono">FIND</span>
              <input
                ref={qRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); setQ(""); qRef.current?.blur(); } }}
                placeholder="搜任务、人、分支、工单号…"
                aria-label="搜任务"
                spellCheck={false}
              />
              <span className="find__n mono">{q ? `${flat.length} 命中` : `${flat.length} 件`}</span>
              <button className="find__act" title="立刻拉一次 Slack（白天每 3 分钟自动）" disabled={slackSyncing} onClick={(e) => { e.preventDefault(); void doSlackSync(); }}>
                {slackSyncing ? <span className="side__spin" /> : <Icon name="refresh" />} {slackNote ?? "Slack"}
              </button>
              <button className="find__act" title="立刻同步一次 Meegle 工单（平时每 15 分钟自动）" disabled={syncing} onClick={(e) => { e.preventDefault(); void doSync(); }}>
                {syncing ? <span className="side__spin" /> : <Icon name="refresh" />} {syncNote ?? "Meegle"}
              </button>
              <button className="find__act" title="自己记一件事，落到待办里" onClick={(e) => { e.preventDefault(); setCreating(true); }}>
                ＋ 新建
              </button>
            </label>
            <div className="deck__scroll" ref={deckRef}>
              {!board ? null : flat.length ? (
                flat.map((t) => (
                  <section key={t.id} className="deck__card" data-id={t.id} onContextMenu={(e) => { if ((e.target as HTMLElement).closest("a[href], input, textarea, .xterm")) return; e.preventDefault(); setMenu({ t, x: e.clientX, y: e.clientY }); }}>
                    <Focus t={t} all={board.tasks} onAct={act} onClose={() => setSelectedId(null)} onPick={setSelectedId} onStartPack={(items) => void startPack(items)} packBusy={packBusy} closable={false} />
                  </section>
                ))
              ) : (
                <div className="empty">
                  <strong>{q ? "没有匹配的任务" : "没有等你决定的事"}</strong>
                  {q ? "换个词试试，或者按 Esc 清空。" : "⌘N 问 Friday，要干的活它先说判断再开工；或者等 Slack 和 Meegle 来活。"}
                </div>
              )}
            </div>
            <div className="deck__cmd mono">
              <span><kbd>↑↓</kbd> 翻页</span>
              <span><kbd>⌘K</kbd> 搜索</span>
              <span className="deck__sp" />
              <span className="deck__pos">{flat.length ? `${String(Math.max(0, flat.findIndex((t) => t.id === focus?.id)) + 1).padStart(2, "0")} / ${String(flat.length).padStart(2, "0")}` : "—"}</span>
            </div>
          </div>
          {flat.length > 1 && (
            <nav className="anchors" aria-label="全部任务">
              <div className="anchors__scroll">
                {anchorGroups.map((g) => (
                  <Fragment key={g.label}>
                    <div className="anchors__g mono">{g.label}</div>
                    {g.items.map((t) => (
                      <div
                        key={t.id}
                        className="an"
                        role="button"
                        tabIndex={0}
                        title={t.title}
                        aria-current={t.id === focus?.id}
                        onClick={() => setSelectedId(t.id)}
                        onContextMenu={(e) => { e.preventDefault(); setSelectedId(t.id); setMenu({ t, x: e.clientX, y: e.clientY }); }}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedId(t.id); } }}
                      >
                        <span className={`dot dot--${t.attention ?? t.status}`} />
                        <span className="an__main">
                          <span className="an__t">{t.title}</span>
                          <span className="an__sub">{anchorSub(t, nestedCount(t), derivedCount(t))}</span>
                        </span>
                      </div>
                    ))}
                  </Fragment>
                ))}
              </div>
            </nav>
          )}
        </div>
      )}
      {menu && <TaskMenu t={menu.t} at={{ x: menu.x, y: menu.y }} onClose={() => setMenu(null)} onAct={act} onEdit={setEditing} onDelete={setDeleting} />}
      {editing && <TaskEditor t={editing} onClose={() => setEditing(null)} onSaved={(fn) => void act(editing, fn)} />}
      {deleting && (
        <DeleteConfirm
          t={deleting}
          onClose={() => setDeleting(null)}
          onConfirm={() => { const t = deleting; setDeleting(null); void act(t, () => taskDelete(t.id)); }}
        />
      )}
    </>
  );
}

/** 任务右键菜单。关注 / 完成 / 忽略复用现有动作，编辑和删除走新接口。 */
function TaskMenu({ t, at, onClose, onAct, onEdit, onDelete }: {
  t: Task;
  at: { x: number; y: number };
  onClose: () => void;
  onAct: (t: Task, fn: () => Promise<unknown>) => Promise<void>;
  onEdit: (t: Task) => void;
  onDelete: (t: Task) => void;
}) {
  const closed = t.status === "done" || t.status === "ignored";
  const run = (fn: () => Promise<unknown>) => { onClose(); void onAct(t, fn); };
  return (
    <div className="ctx" style={{ left: at.x, top: at.y }} onMouseDown={(e) => e.stopPropagation()} role="menu">
      <button role="menuitem" onClick={() => run(() => taskPin(t.id, !t.pinned))}>{t.pinned ? "取消关注" : "关注任务"}</button>
      <button role="menuitem" onClick={() => { onClose(); onEdit(t); }}>编辑任务…</button>
      {!closed && <button role="menuitem" onClick={() => run(() => taskSet(t.id, "done"))}>标记完成</button>}
      {!closed && <button role="menuitem" onClick={() => run(() => taskSet(t.id, "ignore"))}>忽略</button>}
      <button
        role="menuitem"
        className="ctx__danger"
        onClick={() => { onClose(); onDelete(t); }}
      >
        删除任务…
      </button>
    </div>
  );
}

/** 手动记一件事。Meegle 和 Slack 拉不到的（口头交代、自己想起来的）走这儿。 */
function NewTask({ projects, onClose, onDone }: { projects: Array<{ name: string; dir: string }>; onClose: () => void; onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [project, setProject] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function submit() {
    if (!title.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await taskCreate({ title: title.trim(), ...(note.trim() ? { note: note.trim() } : {}), ...(project ? { project } : {}) });
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }
  return (
    <div className="modal" onMouseDown={onClose}>
      <div className="modal__box" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="记一件事">
        <strong className="modal__title">记一件事</strong>
        <div className="modal__row">
        <input
          autoFocus
          value={title}
          placeholder="要做什么"
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(); } if (e.key === "Escape") { e.preventDefault(); onClose(); } }}
        />
        <textarea
          value={note}
          placeholder="补充说明（可不填）"
          rows={3}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); } if (e.key === "Escape") { e.preventDefault(); onClose(); } }}
        />
        </div>
        <Picker
          value={project}
          options={projects.map((p) => ({ value: p.name, label: p.name, hint: p.dir }))}
          placeholder="关联项目（可不填）"
          label="关联项目"
          onPick={setProject}
        />
        {err && <p className="modal__note modal__note--bad">{err}</p>}
        <div className="modal__foot">
          <button className="b b--primary" disabled={!title.trim() || busy} onClick={() => void submit()}>记下{!busy && <kbd>↵</kbd>}</button>
          <button className="b b--text" onClick={onClose}>取消</button>
        </div>
      </div>
    </div>
  );
}

/** 删除确认。WebView 里 window.confirm 不弹，只能自己画。 */
function DeleteConfirm({ t, onClose, onConfirm }: { t: Task; onClose: () => void; onConfirm: () => void }) {
  return (
    <div className="modal" onMouseDown={onClose}>
      <div className="modal__box modal__box--ask" onMouseDown={(e) => e.stopPropagation()} role="alertdialog" aria-label="删除任务">
        <strong className="modal__title">删除「{t.title}」？</strong>
        <p className="modal__note">还开着的终端会一起关掉。可以在操作记录里撤销。</p>
        <div className="modal__foot">
          <button className="b b--primary" autoFocus onClick={onConfirm}>删除</button>
          <button className="b b--text" onClick={onClose}>取消</button>
        </div>
      </div>
    </div>
  );
}

/** 改标题和理解。两个字段都可空着不动，提交时只发改过的那个。 */
function TaskEditor({ t, onClose, onSaved }: { t: Task; onClose: () => void; onSaved: (fn: () => Promise<unknown>) => void }) {
  const [title, setTitle] = useState(t.title);
  const [understanding, setUnderstanding] = useState(t.understanding ?? "");
  const dirty = title.trim() !== t.title || understanding !== (t.understanding ?? "");
  const save = () => {
    if (!title.trim() || !dirty) return;
    const patch: { title?: string; understanding?: string } = {};
    if (title.trim() !== t.title) patch.title = title.trim();
    if (understanding !== (t.understanding ?? "")) patch.understanding = understanding;
    onClose();
    onSaved(() => taskEdit(t.id, patch));
  };
  return (
    <div className="modal" onMouseDown={onClose}>
      <div className="modal__box" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="编辑任务">
        <label className="modal__row">
          <span className="k">标题</span>
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); save(); } }} />
        </label>
        <label className="modal__row">
          <span className="k">理解</span>
          <textarea rows={6} value={understanding} onChange={(e) => setUnderstanding(e.target.value)} placeholder="这条任务到底是什么事" />
        </label>
        <div className="modal__foot">
          <button className="b b--primary" disabled={!title.trim() || !dirty} onClick={save}>保存<kbd>↵</kbd></button>
          <button className="b b--text" onClick={onClose}>取消</button>
        </div>
      </div>
    </div>
  );
}

/** 顶部读数：一个数字 + 单位 + 一条刻度。满格按 max 算，只为看出「多不多」 */
function Gauge({ k, v, u, tone, max }: { k: string; v: number; u: string; tone: string; max: number }) {
  return (
    <div className={`g ${tone ? `g--${tone}` : ""}`}>
      <div className="g__k">{k}</div>
      <div className="g__v">{v}<span className="u">{u}</span></div>
      <div className="g__bar"><i style={{ width: `${Math.min(100, (v / max) * 100)}%` }} /></div>
    </div>
  );
}

function Focus({ t, all, onAct, onClose, onPick, onStartPack, packBusy, closable, ref }: {
  t: Task;
  /** 全部任务，用来找这条的关联需求 / 它名下的缺陷 */
  all: Task[];
  onAct: (t: Task, fn: () => Promise<unknown>) => Promise<void>;
  onClose: () => void;
  onPick?: (id: string) => void;
  /** 名下这几条一次全开工：同一个需求下的缺陷要走同一个终端同一个分支，各开各的必冲突 */
  onStartPack?: (items: Task[]) => void;
  packBusy?: string;
  closable: boolean;
  ref?: React.Ref<HTMLElement>;
}) {
  // 给别人发消息前先给用户看要发什么、可以改，确认才发
  const [confirming, setConfirming] = useState(false);
  const [sendText, setSendText] = useState("");
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [acts, setActs] = useState<Activity[]>([]);
  // 终端还开着，边框上就一直有光绕着跑；终端没了才灭
  const live = t.status === "processing" && Boolean(t.source.jobId) && t.terminal !== "gone";
  // 终端在做什么：进行中每 5 秒拉一次动作流，停了就只拉一次
  useEffect(() => {
    const jobId = t.source.jobId;
    setActs([]);
    if (!jobId) return;
    let stop = false;
    const pull = () => void jobActivity(jobId).then((a) => { if (!stop) setActs(a.items); }).catch(() => {});
    pull();
    if (t.status !== "processing") return () => { stop = true; };
    const timer = window.setInterval(pull, 5000);
    return () => { stop = true; window.clearInterval(timer); };
  }, [t.source.jobId, t.status]);
  useEffect(() => {
    setConfirming(false);
    void fetchAudit(t.id, 50).then(setEvents).catch(() => {});
  }, [t.id, t.updatedAt]);
  const r = t.report;
  // 勾选状态存在任务上；本地先变，后端推送回来再对齐
  const [checked, setChecked] = useState<boolean[]>(() => r?.checked ?? []);
  useEffect(() => { setChecked(r?.checked ?? []); }, [t.id, r?.checked?.join(",")]);
  const checkedCount = checked.filter(Boolean).length;
  function toggleCheck(i: number, v: boolean) {
    setChecked((c) => { const n = [...c]; n[i] = v; return n; });
    void taskVerify(t.id, i, v).catch(() => {});
  }
  const [undoing, setUndoing] = useState(false);
  // evidence.auto 是 pipeline.ts 自动发送分支打的标记（撤销路由也靠它区分）；
  // 人工审核通过走 executePending，记的同样是 slack_reply_sent 但没有这个标记，两者文案不能混为一谈。
  const sentEvent = events.find((e) => e.action === "slack_reply_sent" && e.reversible && e.status !== "undone");
  const autoSent = sentEvent?.evidence.auto === true;

  const [trs, setTrs] = useState<StateTransition[]>([]);
  const [node, setNode] = useState<{ canConfirm: boolean; missing: string[] } | null>(null);
  useEffect(() => {
    setTrs([]);
    setNode(null);
    if (isIssue(t)) void taskTransitions(t.id).then(setTrs).catch(() => {});
    else if (isStory(t) && t.source.nodeKey) void taskNode(t.id).then(setNode).catch(() => {});
  }, [t.id, t.source.statusKey, t.source.nodeKey]);

  const pending = t.pending ?? [];
  const advice = pending[0]?.detail || t.plan || r?.summary || "";
  // 需求卡的 understanding 是「节点/状态/优先级/排期/截止」的复述，StoryBody 已经逐项列过
  const situation = isStory(t) ? "" : t.understanding || t.source.note || "";
  const convs = t.conversations ?? [];
  const convMsgs = convs.flatMap((c) => c.items);
  const links = t.kind === "meegle" ? [] : [...new Set([...convMsgs.flatMap((i) => extractUrls(i.text)), ...(t.source.url ? [t.source.url] : []), ...extractUrls(t.understanding ?? "")])];
  const open = t.status !== "done" && t.status !== "ignored";
  // Friday 自己问的那句单独占一块，别再当成「进展」重复一遍
  const asked = t.attention === "intake" && Boolean(t.progress);
  const rightHas = Boolean(r) || Boolean(!asked && t.progress && (situation || advice)) || pending.length > 1 || links.length > 0;

  // Meegle 的关联需求：缺陷往上找它的需求，需求往下找名下的缺陷
  const parentStory = t.source.linkedStoryId ? all.find((x) => x.source.meegleId === t.source.linkedStoryId) : undefined;
  const ownIds = new Set([...(t.source.meegleId ? [t.source.meegleId] : []), ...(t.source.mergedMeegleIds ?? [])]);
  const childIssues = ownIds.size ? all.filter((x) => x.source.linkedStoryId && ownIds.has(x.source.linkedStoryId)) : [];
  const openChildren = childIssues.filter((c) => c.status !== "done" && c.status !== "ignored").length;
  const startable = childIssues.filter((c) => c.pending?.some((a) => a.type === "start_job"));
  // Friday 从这条线程的情境卡里记下的待办：列表里不单独占行，在这儿看
  const derivedTodos = all.filter((x) => x.source.fromTaskId === t.id);
  const openTodos = derivedTodos.filter((c) => c.status !== "done" && c.status !== "ignored").length;

  const first = pending[0];
  const isMessage = first?.type === "slack_reply";
  // 开工提案优先于 Meegle 状态流转当主按钮：Friday 提的是「让我去改」，
  // 缺陷卡上又恰好有流转可选，原来 trs 一非空就把开工挤得没有任何按钮可点。
  const startJob = pending.find((p) => p.type === "start_job");
  const primary: { label: string; run: () => Promise<unknown> } | null = startJob
    ? { label: `开工：${String(startJob.payload.project ?? "")}`.trim(), run: () => taskApprove(t.id, startJob.id) }
    : isIssue(t) && trs[0]
    ? { label: trs[0].label, run: () => taskTransition(t.id, trs[0]!) }
    : t.project && !t.source.jobId
    ? { label: "开始做", run: () => taskStart(t.id) }
    : first
    ? isMessage
      ? {
          // 原文和草稿对不上时，默认动作应该是「改」而不是「发」
          label: pending.length > 1 ? `看一眼再发：${first.label}…` : "看一眼再发…",
          run: async () => { setSendText(String(first.payload.text ?? first.detail)); setConfirming(true); },
        }
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
      // 焦点已经在某个按钮或可聚焦控件上时，Enter 应该触发那个控件，
      // 而不是抢过来执行主操作——主操作可能是不可逆的（发消息、合并分支）。
      if (el && el !== document.body && (el.tagName === "BUTTON" || el.tagName === "A" || el.hasAttribute("tabindex"))) return;
      if (confirming) return;
      e.preventDefault();
      void onAct(t, run);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [t.id, t.updatedAt, primary?.label, confirming]);

  // 绕框那道光要跟 .fx 那个有边框的盒子严丝合缝，而卡片底下还有块操作栏
  // （高度会变：后果提示、按钮换行，没展开时整个不存在）。直接量卡片底到
  // .fx 底的距离写进 --foot——不管有没有操作栏都是对的，比拿它的高度再加个
  // 猜出来的间距可靠。
  const footRef = useRef<HTMLDivElement>(null);
  const fxRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const fx = fxRef.current;
    const card = fx?.closest(".deck__card") as HTMLElement | null;
    if (!fx || !card) return;
    const sync = () => {
      const foot = footRef.current;
      if (!foot) { card.style.setProperty("--foot", "0px"); return; }
      const cs = getComputedStyle(foot);
      const gap = foot.offsetHeight + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom);
      card.style.setProperty("--foot", `${gap}px`);
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(card);
    if (footRef.current) ro.observe(footRef.current);
    return () => { ro.disconnect(); card.style.removeProperty("--foot"); };
  }, [open]);

  return (
    <>
    <article
      className={`fx ${live ? "fx--live" : ""}`}
      ref={(el) => {
        fxRef.current = el;
        if (typeof ref === "function") ref(el);
        else if (ref) (ref as React.RefObject<HTMLElement | null>).current = el;
      }}
    >
      <div className="fx__meta">
        <span className={`dot dot--${t.attention ?? t.status}`} />
        {/* 状态文字去掉了：在不在跑由顶部那条流线说，要看细节有圆点和下面的进展 */}
        {ATTENTION_NOTE[t.attention ?? ""] && <span className="fx__state">{ATTENTION_NOTE[t.attention ?? ""]!.replace(/^ · /, "")}</span>}
        <span className="fx__meta-dim">{meta(t)} · 更新于 {fmtTime(t.updatedAt)}</span>
        {t.pinned && <span className="fx__pinned" title="已关注（右键可取消）"><Icon name="star" filled />已关注</span>}
        {closable && <button className="b b--text" style={{ height: 22 }} onClick={onClose}>收起</button>}
      </div>
      <h2 className="fx__title" title={t.title}>{t.title}</h2>

      {asked && (
        <div className="fx__ask">
          <span className="k">Friday 要问你</span>
          <div className="fx__ask-q">{t.progress}</div>
          <div className="fx__ask-how">在下面「和 Friday 聊这条任务」里回一句就行，它记下就继续。</div>
        </div>
      )}

      {/* 缺陷挂在哪个需求下 / 需求名下有哪些缺陷。Meegle 里填好的关联，点一下就能跳过去 */}
      {t.source.linkedStoryId && (
        <div className="fx__rel">
          <span className="k">MEEGLE</span>
          {/* 需求没分派给用户时任务板里没有它，只显示名字（或工单号）不给跳转 */}
          {parentStory ? (
            <button className="link" onClick={() => onPick?.(parentStory.id)}>{parentStory.title}</button>
          ) : (
            <span className="fx__rel-plain">
              {t.source.linkedStoryName ?? `Meegle #${t.source.linkedStoryId}`}
              <span className="fx__rel-note">（没分派给你，不在任务板里）</span>
            </span>
          )}
        </div>
      )}
      {derivedTodos.length > 0 && (
        <details className="fx__rel-list" open={openTodos > 0}>
          <summary>
            <span>Friday 记下的待办</span>
            <span className="fx__rel-count">{derivedTodos.length} 条{openTodos > 0 ? `，${openTodos} 条没做` : "，都收工了"}</span>
          </summary>
          <ul>
            {derivedTodos.map((c) => (
              <li key={c.id}>
                <span className={`dot dot--${c.status === "done" || c.status === "ignored" ? "done" : "decide"}`} />
                <button className="link" onClick={() => onPick?.(c.id)}>{c.title}</button>
                {c.due && <span className="fx__rel-note">{dueLabel(c.due)}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
      {childIssues.length > 0 && (
        <details className="fx__rel-list">
          <summary>
            {/* 名下挂着的可能是缺陷，也可能是 Slack 上聊这件事的线程 */}
            <span>{childIssues.every((c) => c.kind === "slack") ? "相关的 Slack 讨论" : childIssues.some((c) => c.kind === "slack") ? "相关的缺陷与讨论" : "名下的缺陷"}</span>
            <span className="fx__rel-count">{childIssues.length} 条{openChildren > 0 ? `，${openChildren} 条未完` : "，都收工了"}</span>
          </summary>
          {onStartPack && startable.length > 0 && (
            <button
              className="b fx__pack-start"
              disabled={packBusy === (t.source.meegleId ?? t.id)}
              onClick={() => onStartPack(startable)}
              title="同一个需求下的缺陷走同一个终端、同一个分支，各开各的必冲突"
            >
              {packBusy === (t.source.meegleId ?? t.id) ? "开工中…" : `一起开工（${startable.length} 条）`}
            </button>
          )}
          <ul>
            {childIssues.map((c) => (
              <li key={c.id}>
                <span className={`dot dot--${c.status === "done" || c.status === "ignored" ? "done" : "decide"}`} />
                <button className="link" onClick={() => onPick?.(c.id)}>{c.title}</button>
              </li>
            ))}
          </ul>
        </details>
      )}

      {isIssue(t) && <IssueBody t={t} />}
      {convs.length > 0 && (
        <div className="fx__slack">
          <div className="fx__slack-head">Slack 里的讨论</div>
          {convs.map((c) => (
            <div key={c.conv} className="fx__conv">
              <div className="fx__conv-meta">
                <span className="fx__conv-who">{c.userName}</span>
                <span className="fx__conv-where mono">{c.channelName || "私聊"}</span>
                {/* 推断出来的要标明白，凭什么这么判也得写上，否则用户没法核对 */}
                {c.source === "guess" && <span className="k k--guess" title={c.why}>Friday 推断</span>}
                <button className="fx__conv-drop" onClick={() => void onAct(t, () => detachConversation(c.conv, t.id))}>不是这条</button>
              </div>
              {c.source === "guess" && c.why && <div className="fx__conv-why">{c.why}</div>}
              {/* 找你的那句常常是指代句，说的是什么全在前面这段里——Friday 依据的就是它 */}
              {c.prior.length > 0 && (
                <details className="fx__prior">
                  <summary>
                    <span>这之前聊的是什么</span>
                    <span className="fx__prior-count">{c.prior.length} 条</span>
                  </summary>
                  {c.prior.map((p, i) => <div key={i} className="fx__prior-line">{p}</div>)}
                </details>
              )}
              {c.items.map((m) => (
                <div key={m.ts} className="fx__conv-msg">
                  {m.text.trim()
                    ? <Linkified text={decodeSlack(m.text)} />
                    : <span className="fx__source-empty">这条没有文字，可能是图片或表情</span>}
                  <a
                    href={m.appLink ?? m.permalink}
                    className="link"
                    title="在 Slack 里打开这条"
                    onClick={(e) => { e.preventDefault(); void openUrl(m.appLink ?? m.permalink); }}
                  >在 Slack 打开</a>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      <TaskBody t={t} all={all} onAct={onAct} />

      <div className={`fx__grid ${rightHas ? "" : "fx__grid--single"}`}>
        <div className="fx__col">
          {situation && (
            <div>
              <span className="k">CONTEXT</span>
              <div className="fx__text"><Linkified text={situation} /></div>
            </div>
          )}
          {advice && (
            <div>
              <span className="k">
                {pending[0] ? `Friday 的建议：${pending[0].label}${isMessage ? "（点「看一眼再发」可改）" : ""}` : t.plan ? "Friday 的方案" : "Friday 做了什么"}
              </span>
              <div className="fx__quote"><Linkified text={advice} /></div>
            </div>
          )}
          {!situation && !advice && !asked && t.progress && (
            <div>
              <span className="k">PROGRESS</span>
              <div className="fx__text">{t.progress}</div>
            </div>
          )}
        </div>
        <div className="fx__col">
          {r && r.verify.length > 0 && (
            <div>
              <span className="k">
                通过前请确认 · {checkedCount}/{r.verify.length}
                {checkedCount === r.verify.length && <span className="fx__check-all"><Icon name="check" />全部确认{first ? "，点「通过并执行」推进" : t.source.jobId ? "，已让终端继续" : "，可以标记完成"}</span>}
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
          {/* Friday 在会话里只重写 verify 时，报告的其余字段是空的——别渲染出一个空标签 */}
          {r?.testResult?.trim() && (
            <div>
              <span className="k">RESULT</span>
              <div className="fx__text">{r.testResult}</div>
            </div>
          )}
          {!r?.testResult?.trim() && !asked && t.progress && (situation || advice) && (
            <div>
              <span className="k">PROGRESS</span>
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

      {t.source.researchFile && <ResearchNote id={t.id} file={t.source.researchFile} />}
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
      {events.length > 0 && (
        <details className="fx__more">
          <summary>这条任务的账 · {events.length} 条</summary>
          <div className="fx__more-body">
            <ul>{events.map((e) => <li key={e.id}><span className="mono">{fmtTime(e.ts)}</span> {e.action} — {e.why}</li>)}</ul>
          </div>
        </details>
      )}

    </article>
      {sentEvent && (
        <div className="fx__undo">
          <span className="k">{autoSent ? "Friday 自动回复了" : "已发出（你批准的）"}</span>
          <button
            className="b b--ghost"
            disabled={undoing}
            onClick={() => {
              setUndoing(true);
              void onAct(t, () => auditUndo(sentEvent.id))
                .then(() => fetchAudit(t.id, 50).then(setEvents).catch(() => {}))
                .finally(() => setUndoing(false));
            }}
          >
            撤回
          </button>
        </div>
      )}

      {open && (
        <div className="fx__foot" ref={footRef}>
          {first && consequence(first, convs[0]) && (
            <div className="fx__consequence">
              <Icon name="alert" />
              <span>{consequence(first, convs[0])}</span>
            </div>
          )}
          <div className="fx__acts">
            {primary && <button className="b b--primary" onClick={() => void onAct(t, primary.run)}>{primary.label}<kbd>↵</kbd></button>}
            {/* 有待审动作时也能直接收工：done 会把没发出去的动作一起作废，不会发消息给别人 */}
            {(!primary || first) && (
              <button className="b b--ghost" title={first ? "任务标记完成，待审的动作作废，不会发出去" : undefined} onClick={() => void onAct(t, () => taskSet(t.id, "done"))}>
                {first ? (isMessage ? "完成，不发" : "完成，不执行") : "标记完成"}
              </button>
            )}
            {/* 全权代理是重的一档：开 worktree、无人值守、跑完自己进 review。
                日常是「开始做」自己动手，所以这条摆在次按钮里 */}
            {t.project && !t.source.jobId && (
              <button className="b b--ghost" title="Friday 独立在 worktree 里改完再交你验收，中途不问你" onClick={() => void onAct(t, () => taskRetry(t.id))}>
                交给 Friday 改
              </button>
            )}
            {isIssue(t) && (startJob ? trs : trs.slice(1)).map((tr) => (
              <button key={tr.id} className="b b--ghost" onClick={() => void onAct(t, () => taskTransition(t.id, tr))}>{tr.label}</button>
            ))}
            {isStory(t) && t.source.nodeKey && (
              <button
                className="b b--ghost"
                disabled={!node?.canConfirm}
                title={node ? (node.canConfirm ? `流转节点「${t.source.nodeName ?? ""}」` : `还差：${node.missing.join("、")}`) : "正在问 Meegle…"}
                onClick={() => void onAct(t, () => taskConfirmNode(t.id))}
              >
                完成当前节点
              </button>
            )}
            {/* 终端是外部 Ghostty 窗口了，「拉到前台」是常用操作，得摆在动手的这一排。
                窗口关掉之后不是就完了——重开一个 --resume 接回原来那个 Claude 会话 */}
            {t.source.jobId && (
              // 后台跑的查询任务压根没开窗口，聚焦无从谈起，只能重开一个 --resume 接回去看
              t.source.headless || t.terminal === "gone" ? (
                <button className="b b--ghost" title={t.source.headless ? "它在后台跑，没有窗口；开一个接回同一个会话，能看到它做了什么" : "窗口已经关了，重开一个并接回原来的会话"} onClick={() => void onAct(t, () => jobReopen(t.source.jobId!))}>
                  <Icon name="terminal" />{t.source.headless ? "打开终端看" : "重开终端"}
                </button>
              ) : (
                <button className="b b--ghost" title="把这条任务的终端窗口拉到前台；窗口没了就重开一个接回原会话" onClick={() => void onAct(t, () => jobFocus(t.source.jobId!))}>
                  <Icon name="terminal" />打开终端
                </button>
              )
            )}
            <button className="b b--text" onClick={() => void onAct(t, () => taskSet(t.id, "ignore"))}>忽略</button>
            {isStory(t) && node && !node.canConfirm && <span className="fx__miss">还差：{node.missing.join("、")}</span>}
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
