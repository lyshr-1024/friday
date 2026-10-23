import { useEffect, useRef, useState } from "react";
import type { HandbookDraftItem, HandbookDraftView, Task } from "@friday/shared";
import { handbookDraft, saveHandbookSkip, taskApprove, taskSet } from "../lib/core";
import { Icon } from "./Icon";

const KINDS: Array<{ kind: HandbookDraftItem["kind"]; label: string; mark: string }> = [
  { kind: "add", label: "新增", mark: "+" },
  { kind: "revise", label: "改写", mark: "~" },
  { kind: "retire", label: "退役", mark: "−" },
  { kind: "confirm", label: "确认", mark: "✓" },
  { kind: "decision", label: "决策", mark: "·" },
  { kind: "person", label: "人物", mark: "·" },
  { kind: "alias", label: "别名", mark: "·" },
];
const NOTE_MARK = { conflict: "!", stale: "?", dropped: "×" };

function Item({ it, on, onToggle }: { it: HandbookDraftItem; on: boolean; onToggle: () => void }) {
  const mark = KINDS.find((k) => k.kind === it.kind)!.mark;
  return (
    <label className={`hbr__item hbr__item--${it.kind} ${on ? "" : "is-off"}`}>
      <input type="checkbox" checked={on} onChange={onToggle} />
      <span className="hbr__mark mono" aria-hidden>{mark}</span>
      <div className="hbr__body">
        {it.kind === "revise" ? (
          <>
            <div className="hbr__from">{it.from}</div>
            <div>{it.text}</div>
          </>
        ) : it.kind === "retire" ? (
          <div><span className="hbr__from">{it.text}</span>{it.why && <span className="hbr__why"> · {it.why}</span>}</div>
        ) : (
          <div>{it.text}{it.why && it.kind === "decision" && <span className="hbr__why"> · {it.why}</span>}</div>
        )}
        {it.kind === "revise" && it.why && <div className="hbr__why">{it.why}</div>}
        {it.quotes.length > 0 && (
          <ul className="rules__evidence">
            {it.quotes.map((q, j) => <li key={j}>{q}</li>)}
          </ul>
        )}
      </div>
    </label>
  );
}

/** 从 Claude Code 历史学到的手册改动：逐条勾选，勾掉的不写；不是工作任务，在「学习」弹窗里过目 */
export function HandbookReview({ task, onBack }: { task: Task; onBack: () => void }) {
  const [view, setView] = useState<HandbookDraftView | null>(null);
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const saving = useRef<Promise<void>>(Promise.resolve());
  const action = (task.pending ?? []).find((p) => p.type === "handbook_apply");

  useEffect(() => {
    handbookDraft(task.id)
      .then((v) => { setView(v); setSkip(new Set(v.skip)); })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [task.id]);

  function toggle(key: string) {
    const next = new Set(skip);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSkip(next);
    // 存下来，会话里说「通过」也按这份勾选走；按顺序排队，后一次覆盖前一次
    saving.current = saving.current.catch(() => {}).then(() => saveHandbookSkip(task.id, [...next]));
    saving.current.then(() => setErr(""), (e) => setErr(`勾选没存上：${e instanceof Error ? e.message : String(e)}`));
  }

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setErr("");
    try {
      await fn();
      onBack();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const items = view?.groups.flatMap((g) => g.items) ?? [];
  const picked = items.filter((i) => !skip.has(i.key)).length;

  return (
    <div className="editor">
      <header className="editor__head">
        <button className="editor__back" onClick={onBack}><Icon name="chevronRight" className="icon--flip" />学习</button>
        <span className="editor__title">手册改动待过目</span>
        <span className="editor__status mono">{task.createdAt.slice(0, 10)}</span>
      </header>
      <div className="rules hbr">
        <p className="hbr__intro">{task.understanding}</p>
        {view?.groups.map((g, gi) => (
          <section key={gi}>
            <h3 className="hbr__head">{g.name}（依据 {g.sources} 条）</h3>
            {KINDS.map(({ kind, label }) => {
              const list = g.items.filter((i) => i.kind === kind);
              if (!list.length) return null;
              return (
                <div key={kind}>
                  <div className="k hbr__label">{label} {list.length}</div>
                  {list.map((it) => <Item key={it.key} it={it} on={!skip.has(it.key)} onToggle={() => toggle(it.key)} />)}
                </div>
              );
            })}
            {g.notes.map((n, i) => (
              <div key={i} className={`hbr__item hbr__item--${n.kind} hbr__item--note`}>
                <span className="hbr__mark mono" aria-hidden>{NOTE_MARK[n.kind]}</span>
                <div className="hbr__body hbr__meta">{n.kind === "conflict" ? `冲突：${n.text}` : n.text}</div>
              </div>
            ))}
          </section>
        ))}
      </div>
      <footer className="hbr__foot">
        <span className={`hbr__conseq ${err ? "hbr__conseq--err" : ""}`}>
          {err || `勾上的 ${picked} 条写进规则表并重新生成 handbooks/，派去终端的 Claude 下次开工就读到；没勾的不写。可在操作记录里整体撤销。`}
        </span>
        <button className="b b--ghost" disabled={busy} onClick={() => void run(() => taskSet(task.id, "ignore"))}>这批不要</button>
        <button
          className="b b--primary"
          disabled={busy || !action || !view || picked === 0}
          onClick={() => action && void run(async () => { await saving.current; await taskApprove(task.id, action.id); })}
        >
          {picked === items.length ? "通过，写进手册" : `写进勾上的 ${picked} 条`}
        </button>
      </footer>
    </div>
  );
}
