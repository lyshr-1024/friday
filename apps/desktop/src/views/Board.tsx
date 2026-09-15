import { Fragment, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { BACKEND_TAGS, TAG_LABELS, TASK_CATEGORY_LABEL, taskCategory, type AuditEvent, type PendingAction, type StateTransition, type Task, type TaskBoard, type TaskCategory, type TaskStatus, type TerminalState, type Thread } from "@friday/shared";
import type { Activity } from "../lib/core";
import { peekFocusJob } from "../lib/focusJob";
import type { FridayEvent } from "../lib/events";
import { audit as fetchAudit, auditUndo, inbox as fetchInbox, jobActivity, learnNow, newConversation, settings, syncMeegle, taskApprove, taskBindConversation, taskBoard, taskConfirmNode, taskNode, taskPin, taskReject, taskResearch, taskRetry, taskSet, taskTransition, taskTransitions, taskVerify, threadById } from "../lib/core";
import { AttachmentStrip, Linkified, extractUrls, fmtTime } from "./shared";
import { Icon } from "./Icon";
import { Thread as ChatThread } from "./Thread";
import { Terminal } from "./Terminal";

export type BoardView = "queue" | "doing" | "all" | "ledger";

const KIND: Record<string, string> = { slack: "Slack", meegle: "Meegle", verbal: "口头", doc: "文档", code: "代码", learn: "自学", other: "其他" };
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


/** 原文够不够支撑判断。够不着就得明说，不能让用户自己去折叠里发现。
    只做能确定的检查，拿不准就不报——误报比不报更伤信任。 */

/** 点下去会发生什么。不可逆的动作必须先说清楚，否则用户不敢按。 */
function consequence(a: PendingAction, thread: Thread | null): string | null {
  if (a.type === "slack_reply") {
    const who = String(a.payload.userName ?? "对方");
    const where = a.payload.threadTs
      ? `回在 ${who} 那条下面${thread?.channelName ? `（${thread.channelName}）` : ""}`
      : `发到与 ${who} 的私聊`;
    return `以你的身份${where}。发出后撤不回，会记进操作记录。`;
  }
  if (a.type === "git_merge") {
    return "把这个分支合进主干。合完可以在操作记录里撤销。";
  }
  return null;
}

function evidenceCheck(thread: Thread | null, draft: string): { tone: "thin" | "mismatch"; text: string } | null {
  const items = thread?.items ?? [];
  if (!items.length) return null;
  const withText = items.filter((i) => i.text.trim());
  const empty = items.length - withText.length;

  // 一条带文字的都没有——Friday 是在对着空消息写草稿
  if (withText.length === 0) {
    return { tone: "thin", text: items.length === 1 ? "唯一这条消息没有文字（图片或表情）。Friday 没有可依据的内容，这条草稿是猜的。" : `${items.length} 条消息都没有文字（图片或表情）。Friday 没有可依据的内容，这条草稿是猜的。` };
  }
  // Friday 说「内容没显示出来」，但其实有别的消息带文字
  if (/没显示出来|内容为空|没有内容|看不到内容/.test(draft) && withText.length > 0) {
    const last = (withText[withText.length - 1]?.text ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
    return { tone: "mismatch", text: `这个线程里有带文字的消息：「${last}」。草稿说内容没显示出来，和原文对不上。` };
  }
  // 只有一条短消息，信息量不足以判断
  if (withText.length === 1 && (withText[0]?.text ?? "").trim().length <= 30) {
    return { tone: "thin", text: empty > 0 ? `全部原文就这一句，另有 ${empty} 条没有文字。` : "全部原文就这一句，信息不多。" };
  }
  return null;
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

function needs(t: Task): string {
  if (t.attention === "question") return `马上回：${(t.progress ?? "终端在问你").replace(/^终端在问：/, "")}`;
  const first = t.pending?.[0];
  if (first) return `需要你：${first.label}`;
  // 只有验收列表（Friday 在会话里写的）不算交付报告，别让左栏说「看交付报告」却没有报告
  if (t.report?.summary?.trim()) return "需要你：看交付报告";
  if (t.report?.verify.length) return `需要你：确认 ${t.report.verify.length} 个验收点`;
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

const isIssue = (t: Task) => taskCategory(t.source) === "defect";
const isStory = (t: Task) => taskCategory(t.source) === "story";
const ISSUE_STATUS: Record<string, string> = { OPEN: "待处理", REOPENED: "重新打开", "IN PROGRESS": "开发中" };
const DOC_LABELS: Array<[keyof NonNullable<Task["source"]["docs"]>, string]> = [["req", "需求文档"], ["tech", "技术文档"], ["design", "设计稿"]];

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

function MeegleChips({ t, extra }: { t: Task; extra?: string }) {
  const tags = (t.source.meegleTags ?? []).map((x) => TAG_LABELS[x] ?? x);
  const chips = [t.priority === "high" ? "高优先级" : "", extra, ...tags].filter(Boolean) as string[];
  return (
    <div className="fx__chips">
      {chips.map((m) => <span key={m} className="fx__chip">{m}</span>)}
      {t.source.reporter && <span className="fx__by">{t.source.reporter} 提的</span>}
      {t.source.url && <OpenLink href={t.source.url}>在 Meegle 打开 ↗</OpenLink>}
    </div>
  );
}

function IssueBody({ t }: { t: Task }) {
  const [full, setFull] = useState(false);
  const desc = t.source.description ?? "";
  return (
    <>
      <MeegleChips t={t} extra={ISSUE_STATUS[t.source.statusKey ?? ""] ?? t.source.statusKey} />
      {desc && (
        <div>
          <span className="k">缺陷描述</span>
          <div className={`fx__desc ${full ? "" : "fx__desc--clip"}`}><Rich text={desc} /></div>
          <button className="b b--text" onClick={() => setFull((v) => !v)}>{full ? "收起" : "展开全文"}</button>
        </div>
      )}
    </>
  );
}

function StoryBody({ t }: { t: Task }) {
  const { feDue, beDue, docs, nodeName } = t.source;
  const links = DOC_LABELS.filter(([k]) => docs?.[k]);
  return (
    <>
      <MeegleChips t={t} extra={nodeName} />
      {(feDue || beDue) && (
        <div>
          <span className="k">排期</span>
          <div className="fx__text">{[feDue && `后台前端 ${feDue}`, beDue && `服务端 ${beDue}`].filter(Boolean).join(" · ")}</div>
        </div>
      )}
      {links.length > 0 && (
        <div>
          <span className="k">资料</span>
          <div className="fx__docs">{links.map(([k, label]) => <OpenLink key={k} href={docs![k]!}>{label} ↗</OpenLink>)}</div>
        </div>
      )}
    </>
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

const ATTENTION_NOTE: Record<string, string> = {
  question: " · 终端在问你，回答前它不会继续",
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
  const [queuedOpen, setQueuedOpen] = useState<Record<TaskCategory, boolean>>({ slack: true, defect: true, story: true, other: true });
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
  const [learning, setLearning] = useState(false);
  const [learnNote, setLearnNote] = useState<string | null>(null);
  async function doLearn() {
    setLearning(true);
    setLearnNote(null);
    try {
      const r = await learnNow();
      if ("skipped" in r) setLearnNote(r.skipped.startsWith("出错") ? "出错了" : "这次没学"), setErr(r.skipped);
      else setLearnNote(`学了：${r.title}`);
      void load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLearning(false);
      window.setTimeout(() => setLearnNote(null), 6000);
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
  const queued = rest.filter((t) => QUEUED.includes(t.status)).sort(byTier);
  // 待办按 Meegle 工单类型拆开：需求一组、缺陷一组，口头/自学/Slack 等没有类型的归「其他」。
  const QUEUE_GROUPS: TaskCategory[] = ["slack", "defect", "story", "other"];
  const queuedBy = (c: TaskCategory) => queued.filter((t) => taskCategory(t.source) === c);
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
    <div key={t.id} className={`li ${t.id === focus?.id ? "li--on" : ""} ${dim ? "li--dim" : ""} ${t.pinned ? "li--pinned" : ""}`} onClick={() => setSelectedId(t.id)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedId(t.id); } }}>
      <span className={`dot dot--${t.attention ?? t.status}`} />
      <span className="li__main">
        <span className="li__title">{t.title}</span>
        <span className="li__sub">{runningConvs?.has(t.source.conversationId ?? "") ? `Friday 在回 · ${line}` : line}</span>
        {(t.terminal === "busy" || runningConvs?.has(t.source.conversationId ?? "")) && <span className="li__bar"><i /></span>}
      </span>
      <button className="li__pin" title={t.pinned ? "取消关注" : "关注"} aria-label={t.pinned ? "取消关注" : "关注"} aria-pressed={!!t.pinned} onClick={(e) => { e.stopPropagation(); void act(null, () => taskPin(t.id, !t.pinned)); }}><Icon name="star" filled={t.pinned} /></button>
    </div>
  );
  const group = (label: string, list: Task[], open: boolean, toggle: () => void, empty: string, line: (t: Task) => string, dim: (t: Task) => boolean, extra?: React.ReactNode) => (
    <section className="grp grp--side">
      <div className="grp__head grp__head--row">
        <button className="grp__head grp__head--inner" onClick={toggle}>
          {label}<span className="mono">{list.length}</span>
          <span className="grp__tog">{open ? "收起" : "展开"}<Icon name={open ? "chevronDown" : "chevronRight"} /></span>
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
                    <div className="grp__head"><span className="li__pin-mark"><Icon name="star" filled /></span>关注<span className="mono">{pinned.length}</span></div>
                    {pinned.map((t) => item(t, t.attention ? doingRight(t) : needs(t) || doingRight(t)))}
                  </section>
                )}
                <section className={`grp grp--side ${pinned.length ? "" : "grp--first"}`}>
                  <div className="grp__head grp__head--row">
                    <div className="grp__head grp__head--inner"><span className="dot dot--decide" />待我决定<span className="mono">{decide.length}</span></div>
                    <button className="grp__act" title="立刻拉一次 Slack（白天每 3 分钟自动）" disabled={slackSyncing} onClick={() => void doSlackSync()}>
                      {slackSyncing ? <span className="side__spin" /> : <Icon name="refresh" />} {slackNote ?? "Slack"}
                    </button>
                  </div>
                  {decide.length ? decide.map((t) => item(t, needs(t))) : <div className="li li--empty">没有等你决定的事，Friday 有事会推到这里</div>}
                </section>
                {group("Friday 在做", doing, doingOpen, () => setDoingOpen((v) => !v), "现在没有在做的事，交代一件就会出现在这里", doingRight, () => false)}
                {QUEUE_GROUPS.map((cat, i) => {
                  const list = queuedBy(cat);
                  // 需求 / 缺陷两组常驻，空了也让人看得见；「其他」没东西就不占位。
                  if (!list.length && (cat === "other" || cat === "slack")) return null;
                  return (
                    <Fragment key={cat}>
                      {group(TASK_CATEGORY_LABEL[cat], list, queuedOpen[cat], () => setQueuedOpen((v) => ({ ...v, [cat]: !v[cat] })),
                        cat === "other" ? "没有其他待办" : cat === "slack" ? "没有 Slack 待办" : `没有${TASK_CATEGORY_LABEL[cat]}，Meegle 分派给你的会汇到这里`,
                        queuedRight, (t) => !t.due && t.priority !== "high",
                        // 学一题 / Meegle 同步挂在第一组的头上，三组共用一套入口
                        i === 0 ? (
                          <>
                            <button className="grp__act" title="让 Friday 现在自学一题：挑一个手头项目的具体问题，研究社区做法给建议（要一两分钟；平时每天早上自动）" disabled={learning} onClick={() => void doLearn()}>
                              {learning ? <span className="side__spin" /> : <Icon name="sparkle" />} {learnNote ?? "学一题"}
                            </button>
                            <button className={`grp__act ${syncing ? "is-busy" : ""}`} title="立刻同步一次 Meegle 工单（平时每 15 分钟自动）" disabled={syncing} onClick={() => void doSync()}>
                              {syncing ? <span className="side__spin" /> : <Icon name="refresh" />} {syncNote ?? "Meegle"}
                            </button>
                          </>
                        ) : undefined)}
                    </Fragment>
                  );
                })}
                {group("最近完成", done, doneOpen, () => setDoneOpen((v) => !v), "还没有完成的，处理完的事会留在这里七天", (t) => fmtTime(t.updatedAt), () => true)}
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
  // 终端默认收起：先看 Friday 怎么说，不放心再展开自己看；「聚焦终端」点过来时直接展开
  const [termOpen, setTermOpen] = useState(() => peekFocusJob() === t.source.jobId);
  const termRef = useRef<HTMLDivElement>(null);
  // 展开后要把终端滚进视野，否则点了「聚焦终端」人还停在卡片上半部分不知道发生了什么
  const [scrollToTerm, setScrollToTerm] = useState(() => peekFocusJob() === t.source.jobId);
  useEffect(() => {
    const onFocusJob = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== t.source.jobId) return;
      setTermOpen(true);
      setScrollToTerm(true);
    };
    window.addEventListener("friday:focus-job", onFocusJob);
    return () => window.removeEventListener("friday:focus-job", onFocusJob);
  }, [t.source.jobId]);
  useEffect(() => {
    if (!scrollToTerm || !termOpen) return;
    // 等 xterm 挂完再滚，否则量到的还是没撑开的高度
    const id = window.requestAnimationFrame(() => {
      termRef.current?.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      setScrollToTerm(false);
    });
    return () => window.cancelAnimationFrame(id);
  }, [scrollToTerm, termOpen]);
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
  const [undoing, setUndoing] = useState(false);
  const gateEvent = events.find((e) => e.action === "slack_reply_prepared" || e.action === "slack_reply_sent");
  const confidence = typeof gateEvent?.evidence.confidence === "number" ? gateEvent.evidence.confidence : undefined;
  const threshold = typeof gateEvent?.evidence.threshold === "number" ? gateEvent.evidence.threshold : undefined;
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
  const situation = t.understanding || t.source.note || "";
  const links = t.kind === "meegle" ? [] : [...new Set([...(thread?.items ?? []).flatMap((i) => extractUrls(i.text)), ...(t.source.url ? [t.source.url] : []), ...extractUrls(t.understanding ?? "")])];
  const open = t.status !== "done" && t.status !== "ignored";
  const rightHas = Boolean(r) || Boolean(t.progress && (situation || advice)) || pending.length > 1 || links.length > 0;

  const prior = thread?.brief?.priorMessages ?? [];
  const first = pending[0];
  const isMessage = first?.type === "slack_reply";
  const evidence = isMessage ? evidenceCheck(thread, String(first.payload.text ?? first.detail ?? "")) : null;
  const primary: { label: string; run: () => Promise<unknown> } | null = isIssue(t) && trs[0]
    ? { label: trs[0].label, run: () => taskTransition(t.id, trs[0]!) }
    : isStory(t) && t.project
    ? { label: "交给 Friday 改", run: () => taskRetry(t.id) }
    : first
    ? isMessage
      ? {
          // 原文和草稿对不上时，默认动作应该是「改」而不是「发」
          label: evidence?.tone === "mismatch" ? "改一下再发…" : pending.length > 1 ? `看一眼再发：${first.label}…` : "看一眼再发…",
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

  return (
    <>
    <article className="fx" ref={ref as React.Ref<HTMLDivElement>}>
      <div className="fx__meta">
        <span className={`dot dot--${t.attention ?? t.status}`} />
        <span className="fx__state">{STATUS[t.status]}{ATTENTION_NOTE[t.attention ?? ""] ?? ""}</span>
        <span className="fx__meta-dim">{meta(t)} · 更新于 {fmtTime(t.updatedAt)}</span>
        <button className={`fx__pin ${t.pinned ? "on" : ""}`} title={t.pinned ? "取消关注" : "关注这条任务"} onClick={() => void onAct(t, () => taskPin(t.id, !t.pinned))}>
          <Icon name="star" filled={t.pinned} />{t.pinned ? "已关注" : "关注"}
        </button>
        {closable && <button className="b b--text" style={{ height: 22 }} onClick={onClose}>收起</button>}
      </div>
      <h2 className="fx__title" title={t.title}>{t.title}</h2>

      {isIssue(t) && <IssueBody t={t} />}
      {isStory(t) && <StoryBody t={t} />}

      {thread && thread.items.length > 0 && (
        <div className="fx__source">
          <div className="fx__source-head">
            <span className="k">对方原话</span>
            <span className="fx__source-where">{thread.channelName || `与 ${thread.userName} 的私聊`}</span>
          </div>
          {/* 找你的那句常常是指代句，说的是什么全在前面这段里——Friday 依据的就是它 */}
          {prior.length > 0 && (
            <details className="fx__prior">
              <summary>
                <span>这之前聊的是什么</span>
                <span className="fx__prior-count">{prior.length} 条</span>
              </summary>
              <ul className="fx__source-list fx__prior-list">
                {prior.map((p) => (
                  <li key={p.ts}>
                    <span className="fx__source-who">{p.userName}</span>
                    <span className="fx__source-text"><Linkified text={p.text} /></span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <ul className="fx__source-list">
            {thread.items.map((i) => (
              <li key={i.id}>
                <span className="fx__source-who">{i.userName}</span>
                {i.text.trim()
                  ? <span className="fx__source-text"><Linkified text={i.text} /></span>
                  : <span className="fx__source-empty">这条没有文字，可能是图片或表情</span>}
                <a
                  href={i.permalink}
                  className="link fx__source-open"
                  title="在 Slack 里打开这条"
                  onClick={(e) => { e.preventDefault(); void openUrl(i.appLink ?? i.permalink); }}
                >在 Slack 打开</a>
              </li>
            ))}
          </ul>
          {evidence && (
            <div className={`fx__evidence fx__evidence--${evidence.tone}`}>
              <Icon name="alert" />
              <span>{evidence.text}</span>
            </div>
          )}
        </div>
      )}

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
              <span className="k">
                {pending[0] ? `Friday 的建议：${pending[0].label}${isMessage ? "（点「看一眼再发」可改）" : ""}` : t.plan ? "Friday 的方案" : "Friday 做了什么"}
                {confidence !== undefined && <span className="fx__conf">置信度 {confidence}{threshold !== undefined ? ` / 阈值 ${threshold}` : ""}</span>}
              </span>
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
              <span className="k">测试结果</span>
              <div className="fx__text">{r.testResult}</div>
            </div>
          )}
          {!r?.testResult?.trim() && t.progress && (situation || advice) && (
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
          compact
          emptyTitle="关于这条任务，直接问"
          emptyHint="Friday 带着情境和原文回答；要动代码会先说判断等你点头。"
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
        <div className="fx__term" ref={termRef}>
          {/* 状态交给左栏那条说，这里只做开合——原来两处都报「已断」，措辞还更吓人 */}
          <button className="fx__term-toggle" onClick={() => setTermOpen((v) => !v)} aria-expanded={termOpen}>
            <span className="k">终端</span>
            <span className="fx__term-act">{termOpen ? "收起" : "展开"}<Icon name={termOpen ? "chevronDown" : "chevronRight"} /></span>
          </button>
          {termOpen && <Terminal id={t.source.jobId} />}
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
        <div className="fx__foot">
          {first && consequence(first, thread) && (
            <div className="fx__consequence">
              <Icon name="alert" />
              <span>{consequence(first, thread)}</span>
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
            {isIssue(t) && trs.slice(1).map((tr) => (
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
            <button className="b b--ghost" onClick={() => setRejecting((v) => !v)}>打回…</button>
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
