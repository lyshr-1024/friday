import { useEffect, useRef, useState } from "react";
import { TASK_CATEGORY_LABEL, type SearchHit, type SearchResult } from "@friday/shared";
import { searchAll } from "../lib/core";
import { fmtTime } from "./shared";
import { useImeGuard } from "../lib/ime";

const EMPTY: SearchResult = { tasks: [], messages: [] };

/**
 * ⌘F 全局搜索：需求、缺陷、其他任务和对话。
 * 结果按组排，键盘上下走的是拍平后的同一条线，免得用户还要想「现在在哪组」。
 */
export function Search({ onClose, onPickTask, onPickConversation }: {
  onClose: () => void;
  onPickTask: (taskId: string) => void;
  onPickConversation: (conversationId: string) => void;
}) {
  const [q, setQ] = useState("");
  const [result, setResult] = useState<SearchResult>(EMPTY);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const ime = useImeGuard();
  // 快打时前一个请求可能后到，用序号丢掉过期结果
  const seq = useRef(0);

  useEffect(() => inputRef.current?.focus(), []);

  useEffect(() => {
    const text = q.trim();
    if (!text) {
      setResult(EMPTY);
      setBusy(false);
      return;
    }
    setBusy(true);
    const mine = ++seq.current;
    const timer = window.setTimeout(() => {
      void searchAll(text)
        .then((r) => {
          if (mine !== seq.current) return;
          setResult(r);
          setActive(0);
        })
        .catch(() => {
          if (mine === seq.current) setResult(EMPTY);
        })
        .finally(() => {
          if (mine === seq.current) setBusy(false);
        });
    }, 150);
    return () => window.clearTimeout(timer);
  }, [q]);

  const groups: Array<{ label: string; hits: SearchHit[] }> = [
    { label: TASK_CATEGORY_LABEL.story, hits: result.tasks.filter((t) => t.category === "story") },
    { label: TASK_CATEGORY_LABEL.defect, hits: result.tasks.filter((t) => t.category === "defect") },
    { label: "其他任务", hits: result.tasks.filter((t) => t.category !== "story" && t.category !== "defect") },
    { label: "对话", hits: result.messages },
  ].filter((g) => g.hits.length > 0);

  const flat = groups.flatMap((g) => g.hits);
  const pick = (hit: SearchHit) => {
    if (hit.kind === "task") onPickTask(hit.id);
    else onPickConversation(hit.id);
    onClose();
  };

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (flat.length ? (i + 1) % flat.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (flat.length ? (i - 1 + flat.length) % flat.length : 0));
    } else if (e.key === "Enter") {
      if (ime.isImeEnter(e)) return;
      e.preventDefault();
      const hit = flat[active];
      if (hit) pick(hit);
    }
  }

  let seen = -1;
  return (
    <div className="sr__mask" onMouseDown={onClose}>
      <div className="sr" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <div className="sr__bar">
          <input
            ref={inputRef}
            className="sr__input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜需求、缺陷、对话…"
            spellCheck={false}
            {...ime.handlers}
          />
          {busy && <span className="side__spin" />}
          <kbd>Esc</kbd>
        </div>
        <div className="sr__list">
          {!q.trim() ? (
            <div className="sr__empty">输入关键词，找任务标题、缺陷描述、和 Friday 说过的话。</div>
          ) : !flat.length && !busy ? (
            <div className="sr__empty">没找到「{q.trim()}」。</div>
          ) : (
            groups.map((g) => (
              <section key={g.label} className="sr__grp">
                <div className="sr__grp-head">{g.label}<span className="mono">{g.hits.length}</span></div>
                {g.hits.map((hit) => {
                  seen += 1;
                  const i = seen;
                  return (
                    <button
                      key={`${hit.kind}-${hit.messageId ?? hit.id}`}
                      className={`sr__row ${i === active ? "on" : ""}`}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => pick(hit)}
                    >
                      <div className="sr__title">{hit.title}</div>
                      {hit.snippet && <div className="sr__snip">{hit.snippet}</div>}
                      <div className="sr__meta">
                        {[hit.role, hit.project, hit.status].filter(Boolean).join(" · ")}
                        <span className="sr__when">{fmtTime(hit.updatedAt)}</span>
                      </div>
                    </button>
                  );
                })}
              </section>
            ))
          )}
        </div>
        <div className="sr__foot">↑↓ 选择 · Enter 打开 · Esc 关闭</div>
      </div>
    </div>
  );
}
