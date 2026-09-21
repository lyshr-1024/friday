import { Icon } from "./Icon";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import type { Attachment, HotItem, Job, Message, RunResponse } from "@friday/shared";
import { attachmentUrl, jobFocus } from "../lib/core";

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
