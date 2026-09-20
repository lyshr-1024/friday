import { Icon } from "./Icon";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import type { Attachment, HotItem, InboxItem, Job, Message, RunResponse, Thread, Todo } from "@friday/shared";
import { attachmentUrl, jobFocus } from "../lib/core";

export function TodoList({ todos }: { todos: Todo[] }) {
  return (
    <ul className="todos">
      {todos.map((t) => (
        <li key={t.id} className={`todo todo--${t.source}`}>
          <span className="todo__source mono">{t.source}</span>
          {t.sourceUrl ? (
            <a href={t.sourceUrl} onClick={(e) => { e.preventDefault(); void openUrl(t.sourceUrl!); }}>
              {t.text}
            </a>
          ) : (
            <span>{t.text}</span>
          )}
          {t.due && <span className="todo__due mono">{t.due}</span>}
        </li>
      ))}
    </ul>
  );
}

export function AssistantBody({ m, jobs }: { m: Message; jobs?: Job[] }) {
  if (m.kind === "error") return <div className="err">{m.content}</div>;
  if (m.kind === "run" && m.payload && (m.payload as { jobId?: string }).jobId) {
    const jobId = (m.payload as { jobId: string }).jobId;
    const job = jobs?.find((j) => j.id === jobId);
    return (
      <>
        <div className="answer">{m.content}</div>
        {job && <JobCard job={job} />}
      </>
    );
  }
  if (m.kind === "run" && m.payload && (m.payload as RunResponse).status === "ambiguous") {
    const res = m.payload as Extract<RunResponse, { status: "ambiguous" }>;
    return (
      <>
        <div className="answer">{m.content}</div>
        <ul className="todos">
          {res.candidates.map((c) => (
            <li key={c.dir} className="todo">
              <span>{c.name}</span>
              <span className="todo__due mono">{c.dir}</span>
            </li>
          ))}
        </ul>
      </>
    );
  }
  return (
    <div className="answer">
      <Linkified text={m.content} />
    </div>
  );
}

const URL_RE = /https?:\/\/[^\s<>"'|）)】\]]+/g;
const SLACK_LINK_RE = /<(https?:\/\/[^|>]+)(?:\|([^>]*))?>/g;

/** Slack mrkdwn 的 <url|label> / <url> 与 &amp; 转义还原成普通文本，链接保留为 url 或 label。 */
export function decodeSlack(text: string): string {
  return text
    .replace(SLACK_LINK_RE, (_m, url: string, label?: string) => (label ? `${label}（${url}）` : url))
    .replace(/<[@!#]([^|>]+)(?:\|([^>]*))?>/g, (_m, id: string, label?: string) => `@${label || (id === "channel" || id === "here" ? id : "…")}`)
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

export function extractUrls(text: string): string[] {
  const out: string[] = [];
  for (const m of decodeSlack(text).matchAll(URL_RE)) if (!out.includes(m[0])) out.push(m[0]);
  return out;
}

/** 把文本里的 URL 变成可点链接（点击用系统浏览器打开）；Slack 的 <url|label> 会先还原。 */
export function Linkified({ text }: { text: string }) {
  const plain = decodeSlack(text);
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of plain.matchAll(URL_RE)) {
    const url = m[0];
    const start = m.index ?? 0;
    if (start > last) parts.push(plain.slice(last, start));
    parts.push(
      <a key={start} href={url} className="link" onClick={(e) => { e.preventDefault(); void openUrl(url); }}>
        {url}
      </a>,
    );
    last = start + url.length;
  }
  if (last < plain.length) parts.push(plain.slice(last));
  return <>{parts}</>;
}

/** 挂在页面根上：任何 <a href> 右键弹「打开链接 / 复制链接」。 */
export function LinkMenuHost() {
  const [menu, setMenu] = useState<{ href: string; x: number; y: number } | null>(null);
  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      const a = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a) return;
      e.preventDefault();
      setMenu({ href: a.href, x: e.clientX, y: e.clientY });
    };
    const close = () => setMenu(null);
    document.addEventListener("contextmenu", onCtx);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("contextmenu", onCtx);
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, []);
  if (!menu) return null;
  return (
    <div className="ctx" style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.stopPropagation()}>
      <button onClick={() => { void openUrl(menu.href); setMenu(null); }}>打开链接</button>
      <button onClick={() => { void navigator.clipboard.writeText(menu.href); setMenu(null); }}>复制链接</button>
    </div>
  );
}

const isImage = (mime: string) => /^image\/(png|jpe?g|gif|webp)$/.test(mime);

export function AttachmentStrip({ items, onRemove }: { items: Attachment[]; onRemove?: (id: string) => void }) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    void Promise.all(items.map(async (a) => [a.id, await attachmentUrl(a.id)] as const)).then((pairs) => setUrls(Object.fromEntries(pairs)));
  }, [items.map((a) => a.id).join(",")]);
  if (!items.length) return null;
  return (
    <div className="attach">
      {items.map((a) => (
        <div key={a.id} className="attach__item" title={a.name}>
          {isImage(a.mime) && urls[a.id] ? (
            <a href={urls[a.id]} onClick={(e) => { e.preventDefault(); void openUrl(urls[a.id]!); }}>
              <img className="attach__img" src={urls[a.id]} alt={a.name} />
            </a>
          ) : (
            <span className="attach__file mono">{a.name}</span>
          )}
          {onRemove && <button className="attach__x" onClick={() => onRemove(a.id)} aria-label="移除"><Icon name="cross" /></button>}
        </div>
      ))}
    </div>
  );
}

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

const SOURCE_LABEL: Record<HotItem["source"], string> = { hn: "HN", hf: "Papers", openai: "OpenAI", simonw: "Simon W", qbitai: "量子位" };

export function HotList({ items }: { items: HotItem[] }) {
  return (
    <ol className="hot">
      {items.map((it) => (
        <li key={it.url} className="hot__item">
          <a href={it.url} className="hot__title" onClick={(e) => { e.preventDefault(); void openUrl(it.url); }}>
            {it.title}
          </a>
          <div className="hot__summary">{it.summary}</div>
          <div className="hot__meta mono">
            {SOURCE_LABEL[it.source]} · {fmtTime(it.publishedAt)}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function InboxList({
  items,
  onDone,
  onOpen,
}: {
  items: InboxItem[];
  onDone?: (id: string) => void;
  /** 在会话窗里带着这条消息开新对话 */
  onOpen?: (item: InboxItem) => void;
}) {
  if (!items.length) return <div className="empty">没有待处理的 Slack 消息，有人找你时会出现在这里</div>;
  return (
    <ul className="inbox">
      {items.map((it) => (
        <li key={it.id} className={`inbox__item inbox__item--${it.triage?.urgency ?? "normal"}`}>
          <div className="inbox__head">
            <span className="inbox__who">{it.userName}</span>
            <span className="inbox__where mono">{it.channelName}</span>
            {it.triage?.needsReply && <span className="inbox__tag">待回复</span>}
            {it.triage?.project && <span className="inbox__project mono">{it.triage.project}</span>}
            <span className="inbox__time mono">{fmtTime(new Date(Number(it.ts) * 1000).toISOString())}</span>
          </div>
          <div className="inbox__summary">{it.triage?.summary ?? it.text}</div>
          {it.triage?.summary && it.text && <div className="inbox__text">{it.text.length > 240 ? `${it.text.slice(0, 240)}…` : it.text}</div>}
          <div className="inbox__actions">
            {onOpen && (
              <button className="inbox__go" onClick={() => onOpen(it)}>
                在会话里处理
              </button>
            )}
            {(it.appLink || it.permalink) && (
              <a href={it.permalink} onClick={(e) => { e.preventDefault(); void openUrl(it.appLink ?? it.permalink); }}>
                在 Slack 打开
              </a>
            )}
            {onDone && <button onClick={() => onDone(it.id)}>已处理</button>}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function elapsed(job: Job, now = Date.now()): string {
  const end = job.finishedAt ? new Date(job.finishedAt).getTime() : now;
  const s = Math.max(0, Math.floor((end - new Date(job.startedAt).getTime()) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${s % 60}s` : `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

/**
 * 终端最后一轮说的话取头一句。
 * 上面 Friday 已经讲过一遍了，这里只要够认出「它说到哪儿了」，看全文点「聚焦终端」。
 */
export function gist(text: string, max = 80): string {
  const line = text
    .split("\n")
    .map((l) => l.replace(/^#{1,6}\s*/, "").replace(/^[-*]\s+/, "").trim())
    .find((l) => l && !/^[-*_=]{3,}$/.test(l));
  if (!line) return "";
  const plain = line.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`(.+?)`/g, "$1");
  return plain.length > max ? `${plain.slice(0, max)}…` : plain;
}

export function JobCard({ job, onLog }: { job: Job; onLog?: (job: Job) => void }) {
  const label = job.status === "running" ? "运行中" : job.status === "done" ? "已完成" : `失败 · 退出码 ${job.exitCode ?? "?"}`;
  const last = job.lastMessage ? gist(job.lastMessage) : "";
  return (
    <div className={`job job--${job.status}`}>
      <div className="job__head">
        <span className={`job__dot ${job.status === "running" ? "job__dot--live" : ""}`} />
        <span className="job__project">{job.project}</span>
        <span className="job__status mono">{label}</span>
        <span className="job__time mono">{elapsed(job)}</span>
      </div>
      {/* job.task 是发给终端的整段提示词，上面 Friday 已经说过要干什么了，不再重复一遍 */}
      {last && <div className="job__last">{last}</div>}
      <div className="job__actions">
        <button onClick={() => void jobFocus(job.id)}>聚焦终端</button>
        {onLog && <button onClick={() => onLog(job)}>看日志</button>}
      </div>
    </div>
  );
}

const URG: Record<string, string> = { high: "紧急", normal: "一般", low: "不急" };

/** 一个人找你的一组消息 + Friday 做好的功课 */
export function ThreadCard({ t, onOpen, onDone, onIgnore }: { t: Thread; onOpen?: (t: Thread) => void; onDone?: (id: string) => void; onIgnore?: (id: string) => void }) {
  const b = t.brief;
  const [showRaw, setShowRaw] = useState(false);
  return (
    <div className={`thread thread--${b?.urgency ?? "normal"}`}>
      <div className="thread__head">
        <span className="thread__who">{t.userName}</span>
        <span className="thread__where mono">{t.kind === "dm" ? "私聊" : t.channelName} · {t.items.length} 条</span>
        {b?.needsReply && <span className="inbox__tag">等你回</span>}
        {t.project && <span className="inbox__project mono">{t.project}</span>}
        <span className="thread__time mono">{URG[b?.urgency ?? "normal"]} · {fmtTime(new Date(Number(t.lastTs) * 1000).toISOString())}</span>
      </div>
      {b ? (
        <>
          <div className="thread__situation">{b.situation}</div>
          <div className="thread__needs"><span className="k mono">需要你</span>{b.needs}</div>
          {b.context.length > 0 && (
            <ul className="thread__ctx">
              {b.context.map((c, i) => <li key={i}>{c}</li>)}
            </ul>
          )}
        </>
      ) : (
        <div className="thread__situation muted">Friday 还在做功课…</div>
      )}
      <button className="thread__raw-toggle" onClick={() => setShowRaw((v) => !v)}>{showRaw ? "收起原文" : "看原文"}</button>
      {showRaw && (
        <ul className="thread__raw">
          {t.items.map((i) => (
            <li key={i.id}>
              <Linkified text={i.text} />
              {(i.appLink || i.permalink) && (
                <a href={i.permalink} className="link" onClick={(e) => { e.preventDefault(); void openUrl(i.appLink ?? i.permalink); }}> 在 Slack 打开</a>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="inbox__actions">
        {onOpen && <button className="inbox__go" onClick={() => onOpen(t)}>在会话里处理</button>}
        {onDone && <button onClick={() => onDone(t.id)}>已处理</button>}
        {onIgnore && <button onClick={() => onIgnore(t.id)}>忽略</button>}
      </div>
    </div>
  );
}

/** 工作台首屏：问候 + 现在先做什么 + 素材 */

/**
 * 下拉选择。原生 <select> 的弹出层由系统画，在深色 HUD 里是一块白底，
 * 跟界面完全两套语言——自己画一个。
 */
export function Picker({ value, options, placeholder, onPick, label, resetAfterPick }: {
  value?: string;
  options: Array<{ value: string; label: string; hint?: string }>;
  placeholder: string;
  onPick: (value: string) => void;
  label: string;
  /** 选完就把显示恢复成 placeholder（用于「选一条并进来」这类一次性动作） */
  resetAfterPick?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc, true);
    return () => { window.removeEventListener("mousedown", away); window.removeEventListener("keydown", esc, true); };
  }, [open]);
  const current = resetAfterPick ? undefined : options.find((o) => o.value === value);
  return (
    <div className="pick" ref={box}>
      <button
        type="button"
        className={`pick__btn ${open ? "pick__btn--open" : ""}`}
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={current ? "" : "pick__ph"}>{current?.label ?? placeholder}</span>
        <Icon name="chevronDown" />
      </button>
      {open && (
        <div className="pick__menu" role="listbox">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className={`pick__item ${o.value === value ? "pick__item--on" : ""}`}
              onClick={() => { setOpen(false); onPick(o.value); }}
            >
              <span className="pick__label">{o.label}</span>
              {o.hint && <span className="pick__hint">{o.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
