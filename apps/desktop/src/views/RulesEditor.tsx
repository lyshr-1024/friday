import { useEffect, useRef, useState } from "react";
import { RULE_SECTIONS, type Rule } from "@friday/shared";
import { listRules, patchRule } from "../lib/core";
import { Icon } from "./Icon";

const STALE_MS = 8 * 7 * 86_400_000;
const ORIGIN: Record<Rule["origin"], string> = { history: "", manual: "你改过", outcome: "从交付结果学的" };

/** 一份项目手册的规则，逐条改或退役。markdown 由 core 按这张表重新生成，不再手改文件 */
export function RulesEditor({ project, onBack }: { project: string; onBack: () => void }) {
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [err, setErr] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [retiring, setRetiring] = useState<{ id: string; why: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    listRules(project).then(setRules).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [project]);
  useEffect(() => input.current?.focus(), [editing?.id, retiring?.id]);

  async function save(id: string, patch: { text: string } | { retire: string }) {
    setBusy(true);
    setErr("");
    try {
      const next = await patchRule(id, patch);
      setRules((list) => (list ?? []).flatMap((r) => (r.id !== id ? [r] : next.status === "active" ? [next] : [])));
      setEditing(null);
      setRetiring(null);
    } catch (e) {
      // 保存失败保留你写的内容，别让它随报错一起没了
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const keys = (e: React.KeyboardEvent, submit: () => void, cancel: () => void) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  };

  const now = Date.now();
  return (
    <div className="editor">
      <header className="editor__head">
        <button className="editor__back" onClick={onBack}><Icon name="chevronRight" className="icon--flip" />设置</button>
        <span className="editor__title">{project === "_global" ? "通用习惯" : project}</span>
        <span className="editor__status mono">{err || (rules ? `${rules.length} 条在用` : "读取中…")}</span>
      </header>
      <div className="rules">
        {rules?.length === 0 && <div className="rules__empty">这份手册还没有规则。</div>}
        {RULE_SECTIONS.map((section) => {
          const list = (rules ?? []).filter((r) => r.section === section);
          if (!list.length) return null;
          return (
            <section key={section} className="rules__section">
              <h3 className="k">{section}</h3>
              <ul>
                {list.map((r) => {
                  const stale = now - Date.parse(r.lastConfirmedAt) > STALE_MS;
                  return (
                    <li key={r.id} className="rules__item">
                      {editing?.id === r.id ? (
                        <input
                          ref={input}
                          className="rules__input"
                          value={editing.text}
                          maxLength={120}
                          disabled={busy}
                          onChange={(e) => setEditing({ id: r.id, text: e.target.value })}
                          onKeyDown={(e) => keys(e, () => editing.text.trim() && void save(r.id, { text: editing.text.trim() }), () => setEditing(null))}
                          aria-label="改规则，回车保存，Esc 取消"
                        />
                      ) : (
                        <button className="rules__text" onClick={() => { setRetiring(null); setEditing({ id: r.id, text: r.text }); }} title="点一下改，回车保存">
                          {r.text}
                        </button>
                      )}
                      <div className="rules__meta mono">
                        <span className={stale ? "rules__stale" : ""}>{stale ? "久未确认 · " : ""}最近 {r.lastConfirmedAt.slice(0, 10)}</span>
                        {ORIGIN[r.origin] && <span> · {ORIGIN[r.origin]}</span>}
                        <button className="rules__link" aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)}>
                          {r.evidence.length} 条出处
                        </button>
                        {retiring?.id !== r.id && (
                          <button className="rules__link" onClick={() => { setEditing(null); setRetiring({ id: r.id, why: "" }); }}>退役…</button>
                        )}
                      </div>
                      {retiring?.id === r.id && (
                        <div className="rules__retire">
                          <input
                            ref={input}
                            className="rules__input"
                            placeholder="为什么不算了？比如「临时口径」「已经推翻」"
                            value={retiring.why}
                            maxLength={200}
                            disabled={busy}
                            onChange={(e) => setRetiring({ id: r.id, why: e.target.value })}
                            onKeyDown={(e) => keys(e, () => retiring.why.trim() && void save(r.id, { retire: retiring.why.trim() }), () => setRetiring(null))}
                          />
                          <button className="b" disabled={busy || !retiring.why.trim()} onClick={() => void save(r.id, { retire: retiring.why.trim() })}>退役这条</button>
                          <button className="b b--ghost" onClick={() => setRetiring(null)}>取消</button>
                        </div>
                      )}
                      {open === r.id && (
                        <ul className="rules__evidence">
                          {r.evidence.map((e, i) => (
                            <li key={i}>
                              <span className="mono">{e.at.slice(0, 10)}</span> {e.kind === "outcome" ? "【交付结果】" : ""}{e.quote}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
