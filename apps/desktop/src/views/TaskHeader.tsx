import type { Task } from "@friday/shared";
import { SESSION_STATE_LABEL, STAGE_LABEL } from "@friday/shared";
import { Icon } from "./Icon";

export const KIND: Record<string, string> = { slack: "Slack", meegle: "Meegle", verbal: "口头", doc: "文档", code: "代码", learn: "自学", handbook: "手册", okr_weekly: "OKR 周报", other: "其他" };
export const hhmm = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }) : "");
const mmdd = (d?: string) => (d ? d.slice(5) : "");

export function waitedFor(iso: string): string {
  const m = Math.max(1, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return m < 60 ? `等了 ${m} 分钟` : m < 1440 ? `等了 ${Math.round(m / 60)} 小时` : `等了 ${Math.round(m / 1440)} 天`;
}

/** 列表点和头部状态共用：Friday 排着队要自己开工的，没有会话时显示成「排队中」 */
export function shownState(t: Task): string {
  const st = t.session?.state ?? "none";
  return t.autostart && st === "none" ? "queued" : st;
}

export function stateLabel(t: Task): string {
  const s = t.session;
  if (t.autostart && (s?.state ?? "none") === "none") return `排队中 · ${hhmm(t.autostart.at)} 开工`;
  if (!s) return "";
  const label = SESSION_STATE_LABEL[s.state];
  return s.state === "deciding" && s.waitingSince ? `${label} · ${waitedFor(s.waitingSince)}` : label;
}

export function TaskHeader({ t, counts, onDetail, onToggleTerminal, showingTerminal, onPin, onResume }: {
  t: Task;
  counts: { defects: number; docs: number; convs: number };
  onDetail: () => void;
  onToggleTerminal?: () => void;
  showingTerminal?: boolean;
  onPin: () => void;
  onResume?: () => void;
}) {
  const s = t.session;
  const state = shownState(t);
  const label = stateLabel(t);
  const waiting = !s?.name && (t.status === "collected" || t.status === "understood");
  const project = t.project ?? (t.autostart ? t.source.intake?.project : undefined);
  const noProject = waiting && !project && t.kind !== "okr_weekly" && t.kind !== "handbook";
  const meta = [t.stage ? STAGE_LABEL[t.stage] : "", KIND[t.kind] ?? t.kind, project ?? (noProject ? "项目没定" : ""), t.source.feDue ? `排期 ${mmdd(t.source.feDue)}` : "", s?.lastStopAt ? `最近一轮 ${hhmm(s.lastStopAt)}` : ""].filter(Boolean);
  const hint = [counts.defects ? `${counts.defects} 条缺陷` : "", counts.docs ? `${counts.docs} 份资料` : "", counts.convs ? `${counts.convs} 段 Slack 讨论` : ""].filter(Boolean).join(" · ");
  const d = s?.delivery;
  const branchLine = waiting && !s?.worktree && t.kind !== "okr_weekly" && t.kind !== "handbook"
    ? ["还没有 worktree · 开工时按项目规则建", t.autostart ? "模型 opus" : ""].filter(Boolean).join(" · ")
    : [s?.worktree ? `../${s.worktree.replace(/\/+$/, "").split("/").pop()}` : "", s?.branch, t.source.autonomous ? "Friday 自主" : t.source.headless ? "Friday 查代码" : "", d?.model, d?.costUsd !== undefined ? `$${d.costUsd.toFixed(2)}` : "", d?.minutes ? `${d.minutes} 分钟` : ""].filter(Boolean).join(" · ");
  return (
    <div className="th">
      <div className="th__meta">
        {label && <span className={`th__state th__state--${state}`}><span className={`sdot sdot--${state}`} />{label}</span>}
        {meta.map((m, i) => <span key={i} className={`th__m ${noProject && m === "项目没定" ? "th__m--warn" : ""}`}>{(label || i > 0) && <span className="th__sep">·</span>}{m}</span>)}
        <span className="th__sp" />
        <button className={`th__pin ${t.pinned ? "is-on" : ""}`} onClick={onPin}>{t.pinned ? "★ 已关注" : "☆ 关注"}</button>
      </div>
      <div className="th__title">
        <h2 title={t.title}>{t.title}</h2>
        <button className="th__detail" onClick={onDetail}><Icon name="panel" />详情</button>
        {hint && <span className="th__hint">{hint}</span>}
      </div>
      {(branchLine || onToggleTerminal || onResume) && (
        <div className="th__branch">
          <span>{branchLine}</span>
          <span className="th__sp" />
          {onResume && <button className="th__btn" onClick={onResume}>接着聊</button>}
          {onToggleTerminal && <button className="th__btn" onClick={onToggleTerminal}>{showingTerminal ? (t.source.headless ? "看结果" : "看交付") : "看终端"}</button>}
        </div>
      )}
    </div>
  );
}
