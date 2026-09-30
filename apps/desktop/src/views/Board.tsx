import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { BACKEND_TAGS, ROLLBACK_LABEL, SESSION_STATE_LABEL, STAGE_GROUP_ORDER, STAGE_LABEL, STAGE_ORDER, isFridayRun, taskCategory, type AuditEvent, type OkrWeeklyDraft, type PendingAction, type Stage, type Task, type TaskBoard, type TaskCategory, type TaskStatus, type SlackConversation } from "@friday/shared";
import { audit as fetchAudit, auditUndo, inbox as fetchInbox, syncMeegle, taskApprove, taskBoard, taskConfirmNode, taskDelete, taskEdit, taskPin, taskResearch, taskRetry, taskRoot, taskSet, taskStart, taskCreate,  taskVerify, taskStage, taskStageHint, detachConversation, linkChannel, unlinkChannel, projectList, taskSetProject, taskMerge, jobReopen } from "../lib/core";
import { AttachmentStrip, Linkified, decodeSlack, extractUrls, fmtTime, Picker } from "./shared";
import { useImeGuard } from "../lib/ime";
import { Icon } from "./Icon";
import { Resources } from "./Resources";
import { OkrWeekly } from "./OkrWeekly";
import { KIND, TaskHeader, shownState, hhmm, stateLabel, waitedFor } from "./TaskHeader";
import { Terminal } from "./Terminal";
import { Thread } from "./Thread";
import { TaskDetails, TaskDialog, type DetailSlots, type DialogAction } from "./TaskDialog";

export type BoardView = "queue" | "all" | "ledger";

const RISK: Record<string, string> = { read: "只读", reversible: "可撤销", irreversible: "不可逆" };
const STATUS: Record<TaskStatus, string> = { review: "等你决定", blocked: "卡住了", processing: "进行中", understood: "待办", collected: "刚收到", done: "已完成", ignored: "已忽略" };
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


function okrSubmittable(a: PendingAction): number {
  const rows = (a.payload as unknown as OkrWeeklyDraft).rows ?? [];
  return rows.filter((r) => r.checked && r.state !== "existing" && r.state !== "submitted" && r.content.trim()).length;
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
    return "合完撤不回，要退得自己 revert。";
  }
  if (a.type === "okr_submit") {
    return `以你的身份提交到 OKR 平台 ${String(a.payload.week ?? "")}，共 ${okrSubmittable(a)} 条；可以在操作记录里撤销（会删掉这几条）。`;
  }
  if (a.type === "reproject") {
    return `删掉的 worktree、分支和里面的改动撤不回。在会话里说「撤掉」执行；说「算了，还是 ${String(a.payload.from ?? "原来的")}」就不改。`;
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

function dueLabel(iso: string): string {
  const days = Math.round((new Date(iso).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000);
  if (days < 0) return `逾期 ${-days} 天`;
  if (days === 0) return "今天到期";
  if (days === 1) return "明天到期";
  return `${days} 天后到期`;
}

const isIssue = (t: Task) => taskCategory(t.source) === "defect";
const isStory = (t: Task) => taskCategory(t.source) === "story";
const isClosed = (t: Task) => t.status === "done" || t.status === "ignored";
const canStart = (t: Task) => !isClosed(t) && Boolean(t.project) && (!t.session?.name || t.session.status === "exited");
/** 还没开工、也不归 Friday 自己做：主区是空态，统筹信息在「详情」弹窗里。周报和手册卡有自己的编辑面，照旧 */
const notStarted = (t: Task) => (t.status === "collected" || t.status === "understood") && !t.session?.name && t.kind !== "okr_weekly" && t.kind !== "handbook";
/** Friday 自主干过活的：改项目要整体回退，不走「关终端、改动留着」那套 */
const reprojectOf = (t: Task) => t.pending?.find((a) => a.type === "reproject");
const fridayWork = (t: Task) => t.source.autonomous === true && !t.source.headless && Boolean(t.source.jobId);
const canResume = (t: Task) => !isClosed(t) && Boolean(t.source.jobId) && t.session?.status === "exited" && Boolean(t.session.worktree || t.session.kind === "query");

function defectsOf(t: Task, all: Task[]): Task[] {
  const ids = new Set([...(t.source.meegleId ? [t.source.meegleId] : []), ...(t.source.mergedMeegleIds ?? [])]);
  return all.filter((x) => x.id !== t.id && !isClosed(x) && (x.source.rootId === t.id || (x.source.linkedStoryId !== undefined && ids.has(x.source.linkedStoryId))));
}

function meegleLine(t: Task): string {
  if (!t.source.meegleId) return "";
  const due = t.source.feDue ?? t.source.beDue;
  return [`Meegle：${t.source.meegleId}`, t.source.nodeName ? `节点 ${t.source.nodeName}` : "", t.priority === "high" ? "高优先级" : "", due ? `排期 ${due.slice(5)}` : ""].filter(Boolean).join(" · ");
}
// 交付报告和验收点是 Friday 自己跑完一轮后写的，只有它自己派出去的任务才有可验之物。
// Meegle 同步来的需求状态在多方节点上流转，本机勾不出结论。
const selfRun = (t: Task) => t.source.autonomous === true;
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
          <span className="k">工单描述</span>
          <div className={`fx__desc ${full ? "" : "fx__desc--clip"}`}><Rich text={desc} /></div>
          <button className="b b--text" onClick={() => setFull((v) => !v)}>{full ? "收起" : "展开全文"}</button>
        </div>
      )}
    </>
  );
}

/**
 * 任务卡的主体。所有任务都渲染同一套结构——项目、并入、排期、文档——
 * 每块按「有没有数据」决定露不露面，而不是按来源。口头交代的事和 Meegle
 * 同步下来的工单长得一样，差别只在它没有工单号、排期这些同步来的字段。
 */
function TaskBody({ t, all, onAct }: { t: Task; all: Task[]; onAct: (t: Task, fn: () => Promise<unknown>) => Promise<void> }) {
  const [projects, setProjects] = useState<Array<{ name: string; dir: string }>>([]);
  const [merging, setMerging] = useState<Task | null>(null);
  // to 用 null 表示「改成没定」，所以开合得另拿一个字段，不能靠 null 兼职
  const [switching, setSwitching] = useState<{ to: string | null } | null>(null);
  const hasTerm = Boolean(t.session?.name);
  const reproject = reprojectOf(t);
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
              // Friday 自主干过活的不弹框：后端挂一条回退清单，在会话里说「撤掉」才执行
              if (fridayWork(t)) void onAct(t, () => taskSetProject(t.id, v || null));
              // 你自己的终端还开着就先问一句：关掉它意味着里面没提交的改动要自己去收
              else if (hasTerm && (v || null) !== (t.project ?? null)) setSwitching({ to: v || null });
              else void onAct(t, () => taskSetProject(t.id, v || null));
            }}
          />
          {reproject ? (
            <span className="fx__meta-dim">要改到 {String(reproject.payload.to)}，得先撤掉 Friday 在 {t.project} 上做的。清单在任务卡上，在会话里说「撤掉」执行</span>
          ) : !t.project && <span className="fx__meta-dim">{t.autostart && t.source.intake?.project ? `Friday 判的是 ${t.source.intake.project}，开工时写到卡上；不对就在这儿选` : "Friday 不猜项目——选了才能开工"}</span>}
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
  if (selfRun(t) && t.report?.verify.length) bits.push(`${t.report.verify.length} 个验收点`);
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
  if (t.stage) return `${STAGE_LABEL[t.stage]}${t.priority === "high" ? " · 高优先级" : ""}`;
  return `${KIND[t.kind] ?? t.kind}${t.priority === "high" ? " · 高优先级" : ""}`;
}

function dueBits(t: Task): string[] {
  const feDue = t.source.feDue;
  if (!feDue) return [];
  const d = Math.round((new Date(`${feDue}T00:00:00`).getTime() - new Date().setHours(0, 0, 0, 0)) / 86400000);
  return [`排期 ${feDue.slice(5)}`, ...(d < 0 ? [`逾期 ${-d} 天`] : [])];
}

/** 列表行的灰字：你在做的写状态位，Friday 自主的写交付，缺陷写它在哪个会话里改 */
function anchorLine(t: Task, kids = 0): string {
  const s = t.session;
  if (t.status === "done" || t.status === "ignored") return anchorSub(t);
  if (t.autostart) return ["Friday 会自己开工", hhmm(t.autostart.at), t.autostart.behind ? `前面 ${t.autostart.behind} 条在跑` : ""].filter(Boolean).join(" · ");
  if (t.source.rootId || t.source.linkedStoryId) return [`缺陷 #${t.source.meegleId ?? t.id.slice(0, 6)}`, t.stage ? STAGE_LABEL[t.stage] : "", t.source.rootId ? "在需求的会话里改" : ""].filter(Boolean).join(" · ");
  if (s?.state === "asking" && t.progress) return `${SESSION_STATE_LABEL.asking}：${t.progress.replace(/^终端在问：/, "")}`;
  if (s?.state === "deciding") return [SESSION_STATE_LABEL.deciding, t.pending?.[0]?.label ?? "", s.waitingSince ? waitedFor(s.waitingSince) : ""].filter(Boolean).join(" · ");
  if (t.source.autonomous && t.report) {
    const d = s?.delivery;
    return ["交付了", d?.files !== undefined ? `${d.files} 个文件` : "", t.report.testResult.split(/[，。：:;；,\n]/)[0]!.slice(0, 12), d?.costUsd !== undefined ? `$${d.costUsd.toFixed(2)}` : ""].filter(Boolean).join(" · ");
  }
  const label = stateLabel(t);
  const head = label || s?.name ? [label, s?.lastStopAt ? `最近一轮 ${hhmm(s.lastStopAt)}` : ""] : [KIND[t.kind] ?? t.kind, t.priority === "high" ? "高优先级" : ""];
  return [...head, ...(kids > 0 ? [`${kids} 条缺陷`] : dueBits(t))].filter(Boolean).join(" · ") || anchorSub(t);
}

/** 活跃的排前面：终端在干活 / Friday 在回 > 最近更新 */
function byActivity(active: (t: Task) => boolean) {
  return (a: Task, b: Task) => Number(active(b)) - Number(active(a)) || b.updatedAt.localeCompare(a.updatedAt);
}

export function Board({ view, nav, tools, go, onQueueCounts, onFocusChange, runningConvs }: {
  view: BoardView;
  /** 顶栏那一行视图切换，由 Chat 给——它知道当前是哪个视图 */
  nav?: React.ReactNode;
  tools: React.ReactNode;
  /** 切到别的视图（卡片上的「操作记录 →」要用） */
  go?: (v: BoardView) => void;
  /** Friday 正在生成中的会话 id：对应任务条目上显示青条 */
  runningConvs?: Set<string>;
  /** 待办四组各有几条，左栏锚点用 */
  onQueueCounts?: (c: Record<TaskCategory, number>) => void;
  onFocusChange?: (t: Task | null) => void;
}) {
  const [board, setBoard] = useState<TaskBoard | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [dialogFor, setDialogFor] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [ledgerFor, setLedgerFor] = useState<string | null>(null);
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
    // 进展一句一推，攒 200ms 合成一次拉取
    let coalesce = 0;
    const onChanged = () => {
      window.clearTimeout(coalesce);
      coalesce = window.setTimeout(() => void load(), 200);
    };
    window.addEventListener("friday:tasks-changed", onChanged);
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
      window.removeEventListener("friday:tasks-changed", onChanged);
      window.clearTimeout(coalesce);
    };
  }, []);
  useEffect(() => {
    if (view === "ledger") void fetchAudit(ledgerFor ?? undefined, 300).then(setLedger).catch(() => {});
    else setLedgerFor(null);
  }, [view, ledgerFor]);
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

  // 同一条任务同时只跑一个动作：连点会把「开始做」开出两个会话、「完成当前节点」流转两次。
  // 锁放 ref 里，state 要等下一次渲染才生效，同一帧的第二次点击拦不住
  const inFlight = useRef(new Set<string>());
  const setBusy = (key: string, on: boolean) => {
    if (on) inFlight.current.add(key);
    else inFlight.current.delete(key);
  };

  async function act(t: Task | null, fn: () => Promise<unknown>) {
    const key = t?.id ?? "ledger";
    if (inFlight.current.has(key)) return;
    setBusy(key, true);
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
      if (view === "ledger") setLedger(await fetchAudit(ledgerFor ?? undefined, 300));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(key, false);
    }
  }

  const openLedger = (taskId: string) => { setLedgerFor(taskId); go?.("ledger"); };
  const dialogTask = dialogFor ? board?.tasks.find((x) => x.id === dialogFor) : undefined;
  function detailSlots(t: Task): DetailSlots {
    const all = board?.tasks ?? [];
    return {
      defects: defectsOf(t, all),
      stage: <StageBar t={t} onAct={act} />,
      meegle: meegleLine(t) ? <div className="ac__meegle">{meegleLine(t)}</div> : null,
      belong: t.kind === "okr_weekly" || t.kind === "handbook" ? null : <TaskBody t={t} all={all} onAct={act} />,
      description: isIssue(t) ? <IssueBody t={t} /> : null,
      resources: <Resources t={t} onAct={act} />,
      slack: <SlackConvs t={t} onAct={act} />,
      onAdopt: (d) => void act(d, () => taskRoot(d.id, true)),
      onReject: (d) => void act(d, () => taskRoot(d.id, false)),
    };
  }

  function dialogActions(t: Task): DialogAction[] {
    const close = () => setDialogFor(null);
    const run = (fn: () => Promise<unknown>) => () => { close(); void act(t, fn); };
    return [
      ...(canStart(t) ? [{ label: "开始做", run: run(() => taskStart(t.id)) }, { label: "交给 Friday 改", run: run(() => taskRetry(t.id)) }] : []),
      ...(canResume(t) ? [{ label: "接着聊", run: run(() => jobReopen(t.source.jobId!)) }] : []),
      ...(!isClosed(t) && isStory(t) && t.source.nodeKey ? [{ label: "完成当前节点", run: run(() => taskConfirmNode(t.id)) }] : []),
      ...(!isClosed(t) ? [{ label: "标记完成", run: run(() => taskSet(t.id, "done")) }, { label: "忽略", run: run(() => taskSet(t.id, "ignore")) }] : []),
      { label: "归到项目…", run: () => { close(); setEditing(t); } },
      { label: "操作记录", run: () => { close(); openLedger(t.id); } },
    ];
  }

  const tasks = board?.tasks ?? [];
  const active = (t: Task) => t.session?.state === "working" || Boolean(runningConvs?.has(t.source.conversationId ?? ""));
  const closed = (t: Task) => t.status === "done" || t.status === "ignored";
  // 星标的单独一组放最顶上，其余分组里不再出现
  const pinned = tasks.filter((t) => t.pinned && !closed(t)).sort(byActivity(active));
  const rest = tasks.filter((t) => !pinned.includes(t));
  const liveIds = new Set(tasks.filter((t) => !closed(t)).map((t) => t.id));
  // 缺陷嵌在它的需求下面缩进一级，不各自占分组里的一行。需求不在（没分派也没我的角色）的缺陷仍然独立显示
  const storyOf = new Map<string, string>();
  for (const t of tasks) if (!closed(t)) for (const m of [...(t.source.meegleId ? [t.source.meegleId] : []), ...(t.source.mergedMeegleIds ?? [])]) storyOf.set(m, t.id);
  const parentOf = (t: Task): string | undefined => {
    const root = t.source.rootId && liveIds.has(t.source.rootId) ? t.source.rootId : t.source.linkedStoryId ? storyOf.get(t.source.linkedStoryId) : undefined;
    return root && root !== t.id ? root : undefined;
  };
  const nested = (t: Task) => Boolean(parentOf(t));
  const childrenOf = (t: Task) => tasks.filter((x) => !closed(x) && parentOf(x) === t.id).sort((a, b) => Number(Boolean(a.source.rootGuess)) - Number(Boolean(b.source.rootGuess)) || byActivity(active)(a, b));
  // 情境卡从 Slack 线程派生出来的待办：线程那条还在时它们说的是同一件事，不再单独占一行，
  // 跟缺陷挂需求一样收进父任务里看。线程已经收工的留着独立显示，那才是真正剩下的事。
  const derived = (t: Task) => Boolean(t.source.fromTaskId && liveIds.has(t.source.fromTaskId));
  // 列表只按五个开发阶段分组。「要不要你拍板」不再单独列一组——状态位已经在每一行上说了。
  const onBoard = rest.filter((t) => !closed(t) && !nested(t) && !derived(t));
  const byStage = (st: Stage) => onBoard.filter((t) => t.stage === st).sort(byActivity(active));
  // 没有阶段的（Slack 回消息这类）单独兜底一组，否则它们会从列表里消失
  const noStage = onBoard.filter((t) => !t.stage).sort(byActivity(active));
  const doneTasks = tasks.filter(closed).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  // 按来源计数给外面用（Slack / 缺陷 / 需求 / 其他）。这里必须复制一份再排，
  // sort 是原地改——直接排 onBoard 会把上面按阶段分好的顺序搅乱
  const queued = [...onBoard].sort(byTier);
  // 待办按来源拆开：Slack 一组、Meegle 的需求与缺陷各一组，口头 / 自学等归「其他」。
  const QUEUE_GROUPS: TaskCategory[] = ["slack", "defect", "story", "other"];
  const queuedBy = (c: TaskCategory) => queued.filter((t) => taskCategory(t.source) === c);
  const queueCounts = Object.fromEntries(QUEUE_GROUPS.map((c) => [c, queuedBy(c).length])) as Record<TaskCategory, number>;
  const queueKey = QUEUE_GROUPS.map((c) => queueCounts[c]).join(",");
  useEffect(() => {
    onQueueCounts?.(queueCounts);
  }, [queueKey]);
  // 一次只显示一条，所以要一个扁平序列；分组只剩右侧列表在用。需求后面紧跟它名下的缺陷。
  const anchorGroups = useMemo(() => {
    const withKids = (items: Task[]) => items.flatMap((t) => [{ t, child: false }, ...childrenOf(t).map((c) => ({ t: c, child: true }))]);
    const raw: Array<{ label: string; items: Array<{ t: Task; child: boolean }> }> =
      view === "all"
        ? ALL_ORDER.flatMap((st) => {
            const items = tasks.filter((t) => t.status === st).map((t) => ({ t, child: false }));
            if (st !== "processing") return [{ label: STATUS[st], items }];
            // 「Friday 在做」只放它全权在跑的；你自己开终端驱动的另起一组
            return [
              { label: "Friday 在做", items: items.filter((x) => isFridayRun(x.t.source)) },
              { label: "你在做", items: items.filter((x) => !isFridayRun(x.t.source)) },
            ];
          })
        : [
            { label: "关注", items: withKids(pinned) },
            ...STAGE_GROUP_ORDER.map((st) => ({ label: STAGE_LABEL[st], items: withKids(byStage(st)) })),
            { label: "没有阶段", items: withKids(noStage) },
            ...(showDone ? [{ label: "已完成", items: doneTasks.map((t) => ({ t, child: false })) }] : []),
          ];
    const k = q.trim().toLowerCase();
    const hit = (t: Task) =>
      !k ||
      [t.title, t.project, t.understanding, t.source.branch, t.session?.branch, t.source.meegleId, t.source.linkedStoryName]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(k));
    return raw.map((g) => ({ ...g, items: g.items.filter((x) => hit(x.t)) })).filter((g) => g.items.length);
  }, [tasks, pinned, onBoard, view, q, showDone]);
  const flat = useMemo(() => anchorGroups.flatMap((g) => g.items.map((x) => x.t)), [anchorGroups]);
  orderRef.current = flat.map((t) => t.id);
  const ids = flat.map((t) => t.id).join(",");
  const explicit = selectedId ? tasks.find((t) => t.id === selectedId) ?? null : null;
  const focus = (explicit && flat.some((t) => t.id === explicit.id) ? explicit : null) ?? flat[0] ?? null;
  useEffect(() => {
    onFocusChange?.(focus ?? null);
    document.querySelector('.an[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
  }, [focus?.id]);
  // ⌘P 搜索、⌘↑↓ 任何时候切任务；不带 ⌘ 的 ↑↓ 只在焦点不在输入框和终端里时切
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const inTerm = Boolean(el?.closest(".xterm"));
      const cmd = e.metaKey || e.ctrlKey;
      if (cmd && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "p" && !inTerm) { e.preventDefault(); qRef.current?.focus(); qRef.current?.select(); return; }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      if (e.shiftKey || e.altKey || (e.ctrlKey && !e.metaKey)) return;
      if (!e.metaKey && (inTerm || (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)))) return;
      const i = flat.findIndex((t) => t.id === focus?.id);
      const next = flat[e.key === "ArrowDown" ? Math.min(i + 1, flat.length - 1) : Math.max(i - 1, 0)];
      if (next && next.id !== focus?.id) { e.preventDefault(); setSelectedId(next.id); }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [ids, focus?.id]);
  const title = view === "ledger" ? "操作记录" : view === "all" ? "全部任务" : "任务";
  const count = view === "ledger" ? ledger.length : view === "all" ? tasks.length : onBoard.length;

  return (
    <>
      <header className="q__head q__head--wide" data-tauri-drag-region>
        {nav}
        <div className="q__row" data-tauri-drag-region>
          <div className="q__title" data-tauri-drag-region>
            <h1 data-tauri-drag-region>{title}</h1>
            {board ? <span className="q__count">{count} {view === "ledger" ? "条" : "件"}</span> : !err && <span className="q__count">正在连接 Friday…</span>}
            {view !== "ledger" && (
              <span className="q__acts">
                <button className="find__act" title="立刻拉一次 Slack（白天每 3 分钟自动）" disabled={slackSyncing} onClick={() => void doSlackSync()}>
                  {slackSyncing ? <span className="side__spin" /> : <Icon name="refresh" />} {slackNote ?? "Slack"}
                </button>
                <button className="find__act" title="立刻同步一次 Meegle 工单（平时每 15 分钟自动）" disabled={syncing} onClick={() => void doSync()}>
                  {syncing ? <span className="side__spin" /> : <Icon name="refresh" />} {syncNote ?? "Meegle"}
                </button>
                <button className="find__act" title="自己记一件事，落到待办里" onClick={() => setCreating(true)}>＋ 新建</button>
              </span>
            )}
          </div>
          <div className="q__tools">{tools}</div>
        </div>
      </header>
      {view === "ledger" ? (
        <div className="wb__scroll">
          <div className="wb__page">
            {err && <div className="err" style={{ marginBottom: 16 }}>{err}</div>}
            {ledgerFor && (
              <div className="ledger__for">
                只看「{tasks.find((t) => t.id === ledgerFor)?.title ?? ledgerFor.slice(0, 8)}」
                <button className="b b--text" onClick={() => setLedgerFor(null)}>看全部</button>
              </div>
            )}
            {board && <Ledger events={ledger} onUndo={(id) => void act(null, () => auditUndo(id))} />}
          </div>
        </div>
      ) : (
        <div className="deck">
          {creating && <NewTask projects={allProjects} onClose={() => setCreating(false)} onDone={() => { setCreating(false); void load(); }} />}
          <div className="deck__one">
            {err && <div className="err" style={{ margin: "0 0 12px" }}>{err}</div>}
            {!board ? null : focus ? (
              <Detail
                key={focus.id}
                t={focus}
                all={board.tasks}
                onAct={act}
                onPick={setSelectedId}
                onStartPack={(items) => void startPack(items)}
                packBusy={packBusy}
                onDetail={() => setDialogFor(focus.id)}
                onLedger={() => openLedger(focus.id)}
                onMenu={(x, y) => setMenu({ t: focus, x, y })}
                slots={detailSlots(focus)}
                actions={dialogActions(focus)}
              />
            ) : (
              <div className="empty">
                <strong>{q ? "没有匹配的任务" : "没有等你决定的事"}</strong>
                {q ? "换个词试试，或者按 Esc 清空。" : "问 Friday，或者等 Slack 和 Meegle 来活。"}
              </div>
            )}
          </div>
          <aside className="side">
            <label className="find">
              <span className="find__k">FIND</span>
              <input
                ref={qRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); setQ(""); qRef.current?.blur(); } }}
                placeholder="搜任务、人、分支、工单号…"
                aria-label="搜任务"
                spellCheck={false}
              />
            </label>
            <nav className="anchors" aria-label="全部任务">
              <div className="anchors__scroll">
                {anchorGroups.map((g) => (
                  <Fragment key={g.label}>
                    <div className="anchors__g">{g.label}</div>
                    {g.items.map(({ t, child }) => {
                      const st = shownState(t);
                      const guess = Boolean(t.source.rootGuess);
                      const kids = child ? 0 : (board?.tasks ?? []).filter((x) => x.source.rootId === t.id && !x.source.rootGuess && !closed(x)).length;
                      return (
                        <div
                          key={t.id}
                          className={`an ${child ? "an--child" : ""} an--${st}`}
                          role="button"
                          tabIndex={0}
                          title={t.title}
                          aria-current={t.id === focus?.id}
                          onClick={() => setSelectedId(t.id)}
                          onContextMenu={(e) => { e.preventDefault(); setSelectedId(t.id); setMenu({ t, x: e.clientX, y: e.clientY }); }}
                          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedId(t.id); } }}
                        >
                          <span className={`sdot sdot--${child ? "none" : st}`} />
                          <span className="an__main">
                            <span className="an__t">{guess && <span className="an__guess">Friday 推断</span>}{t.title}</span>
                            {guess ? (
                              <span className="an__sub">
                                {t.kind === "slack" ? "Slack" : "任务"} · 还没进会话 ·{" "}
                                <button className="an__act" onClick={(e) => { e.stopPropagation(); void act(t, () => taskRoot(t.id, true)); }}>是它，进会话</button>
                                {" · "}
                                <button className="an__act an__act--dim" onClick={(e) => { e.stopPropagation(); void act(t, () => taskRoot(t.id, false)); }}>不是这条</button>
                              </span>
                            ) : (
                              <span className="an__sub">
                                {anchorLine(t, kids)}
                                {!child && canResume(t) && <>{" · "}<button className="an__act" onClick={(e) => { e.stopPropagation(); void act(t, () => jobReopen(t.source.jobId!)); }}>接着聊</button></>}
                              </span>
                            )}
                          </span>
                          {!child && t.session?.branch && <span className="an__br">{t.session.branch}</span>}
                        </div>
                      );
                    })}
                  </Fragment>
                ))}
              </div>
              {view !== "all" && doneTasks.length > 0 && (
                <button className="anchors__done" aria-expanded={showDone} onClick={() => setShowDone((v) => !v)}>
                  {showDone ? `收起已完成 ‹` : `已完成 ${doneTasks.length} ›`}
                </button>
              )}
            </nav>
          </aside>
        </div>
      )}
      {menu && <TaskMenu t={menu.t} at={{ x: menu.x, y: menu.y }} onClose={() => setMenu(null)} onAct={act} onEdit={setEditing} onDelete={setDeleting} />}
      {dialogTask && board && (
        <TaskDialog
          t={dialogTask}
          slots={detailSlots(dialogTask)}
          chat={<TaskChat t={dialogTask} placeholder="标记完成 / 这条不用管了 / 把拂晓那条挂进来…" />}
          actions={dialogActions(dialogTask)}
          onClose={() => setDialogFor(null)}
        />
      )}
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

/**
 * 详情区。你在做的（有会话）主体就是终端；Friday 自主的主体是交付卡，右上「看终端」切到同一个会话；
 * 没开工的、挂在需求会话里的缺陷没有自己的终端，走卡片。
 */
function Detail({ t, all, onAct, onPick, onStartPack, packBusy, onDetail, onLedger, onMenu, slots, actions }: {
  t: Task;
  slots: DetailSlots;
  actions: DialogAction[];
  all: Task[];
  onAct: (t: Task | null, fn: () => Promise<unknown>) => Promise<void>;
  onPick: (id: string) => void;
  onStartPack: (items: Task[]) => void;
  packBusy: string;
  onDetail: () => void;
  onLedger: () => void;
  onMenu: (x: number, y: number) => void;
}) {
  const s = t.session;
  const hasTerm = Boolean(s?.name) && s!.state !== "none";
  const autonomous = isFridayRun(t.source);
  const [showTerm, setShowTerm] = useState(false);
  // 会话是主体：详情默认收成一行，要核对时再展开
  const [showDetails, setShowDetails] = useState(false);
  const counts = {
    defects: defectsOf(t, all).length,
    docs: (t.source.docs ?? []).length,
    convs: (t.conversations ?? []).length,
  };
  // Friday 自主的（含排队要自己开工的）：详情直接铺在面板上，交付看会话
  const panel = autonomous || Boolean(t.autostart);
  const termVisible = hasTerm && (!panel || showTerm);
  return (
    <section
      className={`detail ${panel ? "detail--panel" : ""}`}
      onContextMenu={(e) => { if ((e.target as HTMLElement).closest("a[href], input, textarea, .xterm")) return; e.preventDefault(); onMenu(e.clientX, e.clientY); }}
    >
      <TaskHeader
        t={t}
        counts={counts}
        onDetail={onDetail}
        onPin={() => void onAct(t, () => taskPin(t.id, !t.pinned))}
        {...(panel && hasTerm ? { onToggleTerminal: () => setShowTerm((v) => !v), showingTerminal: showTerm } : {})}
        {...(!panel && canResume(t) ? { onResume: () => void onAct(t, () => jobReopen(t.source.jobId!)) } : {})}
        {...(panel ? { actions } : {})}
      />
      {termVisible ? (
        <>
          {panel && canResume(t) && (
            <div className="detail__resume">Claude 已退出<span className="th__sep">·</span><button className="idle__link" onClick={() => void onAct(t, () => jobReopen(t.source.jobId!))}>接着聊</button></div>
          )}
          <div className="detail__term"><Terminal key={t.source.jobId ?? ""} sessionId={t.id} /></div>
        </>
      ) : null}
      {panel && (
        <>
          {!termVisible && (
            <>
              <div className="detail__top"><FridayTop t={t} /></div>
              <button className="dfold" aria-expanded={showDetails} onClick={() => setShowDetails((v) => !v)}>
                <span className="dfold__sum">{foldSummary(t, slots.defects.length)}</span>
                <span className="dfold__act">{showDetails ? "收起详情" : "展开详情"}</span>
              </button>
              {showDetails && (
                <div className="detail__card detail__card--auto fpanel">
                  <TaskDetails t={t} {...slots} single footer={<a className="ac__ledger" href="#" onClick={(e) => { e.preventDefault(); onLedger(); }}>操作记录 →</a>} />
                </div>
              )}
            </>
          )}
          <div className="detail__chat"><TaskChat t={t} placeholder={chatHint(t)} /></div>
        </>
      )}
      {termVisible || panel ? null : notStarted(t) ? (
        <IdleState t={t} onDetail={onDetail} />
      ) : (
        <div className="detail__card">
          <Focus t={t} all={all} onAct={onAct} onPick={onPick} onStartPack={onStartPack} packBusy={packBusy} onLedger={onLedger} />
        </div>
      )}
    </section>
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
  const closed = isClosed(t);
  const run = (fn: () => Promise<unknown>) => { onClose(); void onAct(t, fn); };
  return (
    <div className="ctx" style={{ left: at.x, top: at.y }} onMouseDown={(e) => e.stopPropagation()} role="menu">
      <button role="menuitem" onClick={() => run(() => taskPin(t.id, !t.pinned))}>{t.pinned ? "取消关注" : "关注任务"}</button>
      <button role="menuitem" onClick={() => { onClose(); onEdit(t); }}>编辑任务…</button>
      {canStart(t) && <button role="menuitem" onClick={() => run(() => taskStart(t.id))}>开始做</button>}
      {canStart(t) && <button role="menuitem" onClick={() => run(() => taskRetry(t.id))}>交给 Friday 改</button>}
      {canResume(t) && <button role="menuitem" onClick={() => run(() => jobReopen(t.source.jobId!))}>接着聊</button>}
      {!closed && isStory(t) && t.source.nodeKey && <button role="menuitem" onClick={() => run(() => taskConfirmNode(t.id))}>完成当前节点</button>}
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
  const ime = useImeGuard();
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
          {...ime.handlers}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { if (ime.isImeEnter(e)) return; e.preventDefault(); void submit(); } if (e.key === "Escape") { e.preventDefault(); onClose(); } }}
        />
        <textarea
          value={note}
          placeholder="补充说明（可不填）"
          rows={3}
          onChange={(e) => setNote(e.target.value)}
          {...ime.handlers}
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
  const ime = useImeGuard();
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
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} {...ime.handlers} onKeyDown={(e) => { if (e.key === "Enter") { if (ime.isImeEnter(e)) return; e.preventDefault(); save(); } }} />
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

/**
 * 阶段条：五档从左到右，当前那档高亮。
 * 点任意一档直接拨过去；往回拨会先问是「Friday 推错了」还是「确实被打回了」——
 * 这两个的区别是学习闭环的关键，推错了要学，被打回了不能学（学了会越来越不敢推）。
 */
function StageBar({ t, onAct }: { t: Task; onAct: (t: Task, run: () => Promise<unknown>) => Promise<void> }) {
  const [back, setBack] = useState<Stage | null>(null);
  const [note, setNote] = useState("");
  if (!t.stage) return null;
  const at = STAGE_ORDER.indexOf(t.stage);

  const go = (to: Stage) => {
    if (to === t.stage) return;
    if (STAGE_ORDER.indexOf(to) < at) {
      setBack(to);
      setNote("");
      return;
    }
    void onAct(t, () => taskStage(t.id, to));
  };

  return (
    <div className="stage">
      <div className="stage__row" role="group" aria-label="开发阶段">
        {STAGE_ORDER.map((s, i) => (
          <button
            key={s}
            className={`stage__step${i === at ? " is-on" : ""}${i < at ? " is-past" : ""}`}
            aria-current={i === at ? "step" : undefined}
            title={i === at ? `现在在「${STAGE_LABEL[s]}」` : i < at ? `拨回「${STAGE_LABEL[s]}」` : `推到「${STAGE_LABEL[s]}」`}
            onClick={() => go(s)}
          >
            {STAGE_LABEL[s]}
          </button>
        ))}
      </div>
      {t.stageBy === "auto" && (
        <span className="stage__by">Friday 推的{t.stagePrev ? ` · 原来在「${STAGE_LABEL[t.stagePrev]}」` : ""}</span>
      )}

      {/* Friday 想推进但信号不够硬，问一句。答什么都算一次经验，攒够了以后这类就不问了 */}
      {t.stageHint && (
        <div className="stage__hint">
          <Icon name="alert" />
          <span className="stage__hint-q">{t.stageHint.ask}</span>
          <button className="b b--primary" onClick={() => void onAct(t, () => taskStageHint(t.id, true))}>
            是，转「{STAGE_LABEL[t.stageHint.to]}」
          </button>
          <button className="b b--ghost" onClick={() => void onAct(t, () => taskStageHint(t.id, false))}>不是</button>
        </div>
      )}

      {/* 往回拨：分清推错了还是被打回了。这不是走流程，是决定 Friday 学不学这一次 */}
      {back && (
        <div className="stage__back">
          <span className="k">拨回「{STAGE_LABEL[back]}」是因为</span>
          <input
            className="stage__note"
            placeholder="怎么回事？（选填，会记进进展和账本）"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            autoFocus
          />
          <div className="stage__back-acts">
            <button
              className="b b--ghost"
              title="Friday 之前判错了，它会记下这次教训，下次别再这么判"
              onClick={() => void onAct(t, () => taskStage(t.id, back, "misjudged", note.trim() || undefined)).then(() => setBack(null))}
            >
              {ROLLBACK_LABEL.misjudged}
            </button>
            <button
              className="b b--primary"
              title="确实被打回了，是客观事实，Friday 不会因此变保守"
              onClick={() => void onAct(t, () => taskStage(t.id, back, "bounced", note.trim() || undefined)).then(() => setBack(null))}
            >
              {ROLLBACK_LABEL.bounced}
            </button>
            <button className="b b--text" onClick={() => setBack(null)}>算了</button>
          </div>
        </div>
      )}
    </div>
  );
}

function actionNote(a: PendingAction, conv?: SlackConversation): string {
  const detail = a.detail.trim() ? a.detail.trim().replace(/[。.]?$/, "。") : "";
  return [detail, consequence(a, conv) ?? ""].join(detail.includes("\n") ? "\n" : "");
}

/** 没开工的任务：原来放终端的地方写清还差什么、怎么开工。开工一律在会话里说，这里不放按钮 */
function IdleState({ t, onDetail }: { t: Task; onDetail: () => void }) {
  const asked = t.attention === "intake" && t.progress ? t.progress : "";
  const pending = t.pending?.[0];
  const ready = Boolean(t.project) && !asked;
  return (
    <div className="idle">
      <div className="idle__box">
        <div className="idle__head"><Icon name="terminal" /><span>{ready ? "可以开工了" : "还没开工，差一步"}</span></div>
        <div className="idle__steps">
          {t.project ? (
            <div className="idle__step"><span className="idle__ok">✓</span><span>项目 {t.project}</span></div>
          ) : (
            <div className="idle__step"><span className="idle__todo" /><span>项目没定</span><button className="idle__link" onClick={onDetail}>选项目…</button></div>
          )}
          {asked && <div className="idle__step"><span className="idle__todo" /><span>Friday 要问你：{asked}</span><button className="idle__link" onClick={onDetail}>去回答…</button></div>}
          {pending && <div className="idle__step"><span className="idle__todo" /><span>等你点头：{pending.label}</span><button className="idle__link" onClick={onDetail}>去看…</button></div>}
          {t.source.description && <div className="idle__step"><span className="idle__ok">✓</span><span>工单描述已拉到</span><span className="idle__dim">{["Meegle", t.priority === "high" ? "高优先级" : ""].filter(Boolean).join(" · ")}</span></div>}
        </div>
        <div className="idle__hint">
          {!t.project
            ? "Friday 不猜项目。选好以后，在详情的会话里说「开始做」或「交给 Friday 改」。"
            : t.source.rootId
              ? "在详情的会话里说「开始做」，会进所属需求的会话里改，不另开终端。"
              : "在详情的会话里说「开始做」，就在这里开终端。说「交给 Friday 改」，它自己修完交给你审。"}
        </div>
      </div>
    </div>
  );
}

/** 详情收起时那一行：阶段、项目、有几样东西，够判断要不要展开 */
function foldSummary(t: Task, defects: number): string {
  const docs = (t.source.docs ?? []).length;
  const convs = (t.conversations ?? []).length;
  return [
    t.stage ? STAGE_LABEL[t.stage] : "",
    t.project ?? t.source.intake?.project ?? "项目没定",
    defects ? `${defects} 条缺陷` : "",
    docs ? `${docs} 份资料` : "没有资料",
    convs ? `${convs} 段 Slack 讨论` : "",
  ].filter(Boolean).join(" · ");
}

/** 会话里说哪句话执行：跟 tools.ts 的 APPROVAL 对齐，给最短的那句 */
const SAY: Partial<Record<PendingAction["type"], string>> = { slack_reply: "发", git_merge: "合并吧", okr_submit: "提交", start_job: "开工", handbook_apply: "通过" };

function chatHint(t: Task): string {
  if (reprojectOf(t)) return `撤掉 / 算了，还是 ${t.project ?? "原来的"}`;
  if (t.autostart) return "先别做 / 这条我来 / 项目不对，是 …";
  if (t.source.headless) return "发吧 / 草稿改成… / 不用回了";
  return "合并吧 / 打回，中途关页面进度接不上 / 完成，不执行";
}

/**
 * Friday 自主任务面板最上面那块：要你拍板的事（待审动作）、或者排队中「什么时候开、凭什么判的」。
 * 交付内容不在这儿——在会话里 Friday 的那条交付消息。
 */
function FridayTop({ t }: { t: Task }) {
  const pending = t.pending ?? [];
  const v = t.source.intake;
  const a = t.autostart;
  if (!pending.length && !a) return null;
  return (
    <div className="ftop">
      {pending.map((p) => (
        <div key={p.id} className="ac__pend">
          <div className="ftop__row"><span className="ac__k">等你点头</span><span className="ac__pend-t">{p.label}</span></div>
          <div className="ac__pend-d">{actionNote(p, t.conversations?.[0])}{SAY[p.type] ? `${actionNote(p, t.conversations?.[0]).includes("\n") ? "\n" : ""}在会话里说「${SAY[p.type]}」执行。` : ""}</div>
        </div>
      ))}
      {a && (
        <div className="ftop__queued">
          <div className="ftop__row"><span className="ac__k">什么时候开</span>
            <span className="ac__text">
              {Date.parse(a.at) > Date.now() ? `描述刚进来时常被改，等 15 分钟稳定后 ${hhmm(a.at)} 开工。` : "已经过了稳定期，轮到就开。"}
              {a.behind ? `前面有 ${a.behind} 条自主任务在跑，一次只跑一条。` : ""}
            </span>
          </div>
          {v && (
            <div className="qc__rows">
              <div className="qc__row"><span className="qc__k">为什么</span><span className="qc__v"><Linkified text={v.why} />{v.confidence !== undefined && <span className="qc__dim">把握 {v.confidence}</span>}</span></div>
              {(t.project ?? v.project) && <div className="qc__row"><span className="qc__k">项目</span><span className="qc__v">{t.project ?? v.project}<span className="qc__dim">{t.project && t.source.projectBy === "user" ? "你定的" : t.project ? "卡上的" : "Friday 判的，开工时写到卡上 · 不对就在会话里说"}</span></span></div>}
              {v.detail && <div className="qc__row"><span className="qc__k">打算</span><span className="qc__v"><Linkified text={v.detail} /></span></div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TaskChat({ t, placeholder }: { t: Task; placeholder: string }) {
  return (
    <div className="taskchat">
      <div className="taskchat__k">和 Friday 聊这条任务</div>
      <Thread
        conversationId={t.source.conversationId ?? null}
        emptyTitle=""
        emptyHint=""
        placeholder={placeholder}
        compact
        mentionsFor={t.id}
        noJobCards
        {...(t.status === "done" || t.status === "ignored" ? { disabledNote: "任务已收工，重新打开后可以继续聊" } : {})}
      />
    </div>
  );
}

/** 「Slack 里的讨论」：挂在这条任务上的对话，推断出来的标明依据，可以「不是这条」 */
function SlackConvs({ t, onAct }: { t: Task; onAct: (t: Task, fn: () => Promise<unknown>) => Promise<void> }) {
  const convs = t.conversations ?? [];
  if (!convs.length) return null;
  return (
    <div className="fx__slack">
      <div className="fx__slack-head">Slack 里的讨论</div>
      {convs.map((c) => (
        <div key={c.conv} className="fx__conv">
          <div className="fx__conv-meta">
            <span className="fx__conv-who">{c.kind === "dm" ? c.channelName || `与 ${c.userName} 的私聊` : c.userName}</span>
            {c.kind !== "dm" && c.channelName && <span className="fx__conv-where mono">{c.channelName}</span>}
            {/* 推断出来的要标明白，凭什么这么判也得写上，否则用户没法核对 */}
            {c.source === "guess" && <span className="k k--guess">Friday 推断</span>}
            {c.why && <span className={`fx__conv-basis${c.source === "guess" ? " fx__conv-basis--guess" : ""}`} title={c.why}>{c.source === "guess" ? c.why : `· ${c.why}`}</span>}
            {/* 按需求建的群：频道名约等于需求名，整个挂过去，后面的消息不用再逐条判 */}
            {c.kind === "mention" && c.channelName && (
              c.channelLinked
                ? <button className="fx__conv-chan is-on" title="点掉就不再把这个频道归到本条需求" onClick={() => void onAct(t, () => unlinkChannel(c.channelName, t.id))}>频道已对应本需求</button>
                : <button className="fx__conv-chan" onClick={() => void onAct(t, () => linkChannel(c.channelName, t.id))}>把 #{c.channelName.replace(/^#/, "")} 都归到这条</button>
            )}
            <button className="fx__conv-drop" onClick={() => void onAct(t, () => detachConversation(c.conv, t.id))}>不是这条</button>
          </div>
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
              <span className="fx__conv-name">{m.userName}：</span>
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
  );
}

function Focus({ t, all, onAct, onPick, onStartPack, packBusy, onLedger }: {
  t: Task;
  /** 全部任务，用来找这条的关联需求 / 它名下的缺陷 */
  all: Task[];
  onAct: (t: Task, fn: () => Promise<unknown>) => Promise<void>;
  onPick?: (id: string) => void;
  /** 名下这几条一次全开工：同一个需求下的缺陷要走同一个会话同一个分支，各开各的必冲突 */
  onStartPack?: (items: Task[]) => void;
  packBusy?: string;
  onLedger: () => void;
}) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  useEffect(() => {
    void fetchAudit(t.id, 50).then(setEvents).catch(() => {});
  }, [t.id, t.updatedAt]);
  // 非自主任务的 report 不往卡上放：那几条验收点本机确认不了，摊在这儿只会逼你勾一个假结论
  const r = selfRun(t) ? t.report : undefined;
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

  const pending = t.pending ?? [];
  const advice = pending[0]?.detail || t.plan || r?.summary || "";
  // 需求卡的 understanding 是「节点/状态/优先级/排期/截止」的复述，StoryBody 已经逐项列过
  const situation = isStory(t) ? "" : t.understanding || t.source.note || "";
  const convs = t.conversations ?? [];
  const convMsgs = convs.flatMap((c) => c.items);
  const links = t.kind === "meegle" ? [] : [...new Set([...convMsgs.flatMap((i) => extractUrls(i.text)), ...(t.source.url ? [t.source.url] : []), ...extractUrls(t.understanding ?? "")])];
  // Friday 自己问的那句单独占一块，别再当成「进展」重复一遍
  const asked = t.attention === "intake" && Boolean(t.progress);
  const rightHas = Boolean(r) || pending.length > 1 || links.length > 0;

  // Meegle 的关联需求：缺陷往上找它的需求，需求往下找名下的缺陷
  const parentStory = t.source.linkedStoryId ? all.find((x) => x.source.meegleId === t.source.linkedStoryId) : undefined;
  const ownIds = new Set([...(t.source.meegleId ? [t.source.meegleId] : []), ...(t.source.mergedMeegleIds ?? [])]);
  const childIssues = ownIds.size ? all.filter((x) => x.source.linkedStoryId && ownIds.has(x.source.linkedStoryId)) : [];
  const openChildren = childIssues.filter((c) => c.status !== "done" && c.status !== "ignored").length;
  const startable = childIssues.filter((c) => c.pending?.some((a) => a.type === "start_job"));
  // Friday 从这条线程的情境卡里记下的待办：列表里不单独占行，在这儿看
  const derivedTodos = all.filter((x) => x.source.fromTaskId === t.id);
  const openTodos = derivedTodos.filter((c) => c.status !== "done" && c.status !== "ignored").length;

  return (
    <>
    <article className="fx">
      {t.kind !== "okr_weekly" && t.kind !== "handbook" && <StageBar t={t} onAct={onAct} />}
      {/* Meegle 那边的状态只作参考：它依赖别人及时更新，不参与 Friday 的阶段判断 */}
      {t.source.statusKey && (
        <div className="fx__meegle-state">
          Meegle: {t.source.statusKey}
          {t.source.nodeName ? ` · 节点 ${t.source.nodeName}` : ""}
          <span className="fx__meegle-note">仅供参考，不影响上面的阶段</span>
        </div>
      )}

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
                {/* 名下的缺陷收在需求里、自己不占一张卡，选中它跳不过去，直接开 Meegle */}
                {c.source.url ? <OpenLink href={c.source.url}>{c.title}</OpenLink> : <button className="link" onClick={() => onPick?.(c.id)}>{c.title}</button>}
              </li>
            ))}
          </ul>
        </details>
      )}

      {isIssue(t) && <IssueBody t={t} />}
      <SlackConvs t={t} onAct={onAct} />

      {t.kind !== "okr_weekly" && <TaskBody t={t} all={all} onAct={onAct} />}

      {t.kind === "okr_weekly" ? <OkrWeekly t={t} /> : (
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
                {pending[0] ? `Friday 的建议：${pending[0].label}` : t.plan ? "Friday 的方案" : "Friday 做了什么"}
              </span>
              <div className="fx__quote"><Linkified text={advice} /></div>
            </div>
          )}
        </div>
        <div className="fx__col">
          {r && r.verify.length > 0 && (
            <div>
              <span className="k">
                通过前请确认 · {checkedCount}/{r.verify.length}
                {checkedCount === r.verify.length && <span className="fx__check-all"><Icon name="check" />全部确认{pending[0] ? "，待审动作在右键菜单里" : t.source.jobId ? "，已让终端继续" : "，可以标记完成"}</span>}
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
      )}

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
      <a className="fx__ledger" href="#" onClick={(e) => { e.preventDefault(); onLedger(); }}>操作记录 · 这条任务 {events.length} 条 →</a>
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
