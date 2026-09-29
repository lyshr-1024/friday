import { useState } from "react";
import type { Task } from "@friday/shared";
import { openUrl } from "@tauri-apps/plugin-opener";
import { taskDocAdd, taskDocRemove } from "../lib/core";
import { useImeGuard } from "../lib/ime";

const SOURCE: Array<[RegExp, string]> = [[/meegle|project\.feishu/i, "Meegle"], [/feishu\.cn|larksuite|larkoffice/i, "飞书"], [/figma\.com/i, "Figma"], [/github/i, "GitHub"], [/gitlab/i, "GitLab"]];
const sourceOf = (url: string) => SOURCE.find(([re]) => re.test(url))?.[1] ?? "";
const fallback = (url: string) => {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    return `${u.hostname.replace(/^www\./, "")}${last ? ` / ${decodeURIComponent(last)}` : ""}`;
  } catch {
    return url;
  }
};

export function Resources({ t, onAct }: { t: Task; onAct: (t: Task, fn: () => Promise<unknown>) => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [err, setErr] = useState("");
  const ime = useImeGuard();
  const docs = t.source.docs ?? [];
  const submit = () => {
    const v = url.trim();
    if (!/^https?:\/\//i.test(v)) { setErr("得是 http/https 开头的完整链接"); return; }
    setErr("");
    setUrl("");
    setAdding(false);
    void onAct(t, () => taskDocAdd(t.id, v));
  };
  return (
    <section className="ac__sec">
      <div className="ac__k ac__k--row">资料<span className="th__sp" /><button className="ac__add" aria-expanded={adding} onClick={() => { setAdding((v) => !v); setErr(""); }}>{adding ? "收起" : "＋ 贴一个链接"}</button></div>
      {adding && (
        <>
          <input
            className="res__input"
            autoFocus
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            {...ime.handlers}
            onKeyDown={(e) => {
              if (e.key === "Enter") { if (ime.isImeEnter(e)) return; e.preventDefault(); submit(); }
              if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setAdding(false); }
            }}
            placeholder="粘贴链接，回车加上"
            aria-label="资料链接"
          />
          {err && <span className="res__err">{err}</span>}
        </>
      )}
      {docs.length > 0 ? (
        <div className="ac__docs">
          {docs.map((d) => (
            <div key={d.url} className="res__row">
              <span className="ac__src res__src">{sourceOf(d.url)}</span>
              <a href={d.url} title={d.url} className="res__t" onClick={(e) => { e.preventDefault(); void openUrl(d.url); }}>{d.title ?? fallback(d.url)}</a>
              <button className="res__del" aria-label={`删除 ${d.title ?? d.url}`} onClick={() => void onAct(t, () => taskDocRemove(t.id, d.url))}>×</button>
            </div>
          ))}
        </div>
      ) : !adding && <div className="ac__text ac__text--dim">还没有</div>}
    </section>
  );
}
