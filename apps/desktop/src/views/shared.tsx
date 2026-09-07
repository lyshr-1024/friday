import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import type { Attachment, HotItem, InboxItem, Job, Message, RunResponse, Todo } from "@friday/shared";
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

const URL_RE = /https?:\/\/[^\s<>"'）)】\]]+/g;

/** 把文本里的 URL 变成可点的链接：点击 / ⌘点击 用系统浏览器打开，右键出菜单。 */
export function Linkified({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0];
    const start = m.index ?? 0;
    if (start > last) parts.push(text.slice(last, start));
    parts.push(
      <a key={start} href={url} className="link" onClick={(e) => { e.preventDefault(); void openUrl(url); }}>
        {url}
      </a>,
    );
    last = start + url.length;
  }
  if (last < text.length) parts.push(text.slice(last));
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
          {onRemove && <button className="attach__x" onClick={() => onRemove(a.id)} aria-label="移除">×</button>}
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
  if (!items.length) return <div className="muted">没有待处理的 Slack 消息</div>;
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

export function JobCard({ job, onLog }: { job: Job; onLog?: (job: Job) => void }) {
  const label = job.status === "running" ? "运行中" : job.status === "done" ? "已完成" : `失败 · 退出码 ${job.exitCode ?? "?"}`;
  return (
    <div className={`job job--${job.status}`}>
      <div className="job__head">
        <span className={`job__dot ${job.status === "running" ? "job__dot--live" : ""}`} />
        <span className="job__project">{job.project}</span>
        <span className="job__status mono">{label}</span>
        <span className="job__time mono">{elapsed(job)}</span>
      </div>
      {job.task && <div className="job__task">{job.task}</div>}
      {job.lastMessage && (
        <div className="job__last">
          <span className="job__last-k mono">终端里的 Claude</span>
          {job.lastMessage.length > 400 ? `${job.lastMessage.slice(0, 400)}…` : job.lastMessage}
        </div>
      )}
      <div className="job__actions">
        <button onClick={() => void jobFocus(job.id)}>聚焦终端</button>
        {onLog && <button onClick={() => onLog(job)}>看日志</button>}
      </div>
    </div>
  );
}
