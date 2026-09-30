import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Task } from "@friday/shared";
import { STAGE_LABEL } from "@friday/shared";

export interface DialogAction { label: string; run: () => void }

const FOCUSABLE = "button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex='-1'])";

function defectMeta(d: Task): string {
  const tail = d.stage === "testing" ? "已提测" : d.source.rootId ? "已在这个终端里改" : "";
  return [`#${d.source.meegleId ?? d.id.slice(0, 6)}`, d.stage ? STAGE_LABEL[d.stage] : "", tail].filter(Boolean).join(" · ");
}

export function TaskDialog({ t, defects, stage, meegle, belong, description, resources, slack, chat, actions, onClose, onAdopt, onReject }: {
  t: Task;
  defects: Task[];
  stage: ReactNode;
  meegle: ReactNode;
  /** 项目与并入：没开工的任务只能在这儿选项目 */
  belong: ReactNode;
  /** 缺陷的工单描述 */
  description: ReactNode;
  resources: ReactNode;
  slack: ReactNode;
  chat: ReactNode;
  actions: DialogAction[];
  onClose: () => void;
  onAdopt: (d: Task) => void;
  onReject: (d: Task) => void;
}) {
  const [menu, setMenu] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(document.activeElement);

  useEffect(() => {
    const el = opener.current;
    box.current?.focus();
    return () => { if (el instanceof HTMLElement) el.focus(); };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (e.isComposing || e.keyCode === 229) return;
        const el = e.target as HTMLElement;
        if (box.current?.contains(el) && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (menu) { setMenu(false); menuBtn.current?.focus(); } else onClose();
        return;
      }
      if (e.key !== "Tab" || !box.current) return;
      const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null);
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const at = document.activeElement;
      if (!box.current.contains(at) || at === box.current) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
      else if (e.shiftKey && at === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [menu, onClose]);

  useEffect(() => {
    if (menu) menuRef.current?.querySelector<HTMLElement>("button")?.focus();
  }, [menu]);

  const onMenuKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>("button") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  };

  return createPortal(
    <div className="tdlg__veil" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="tdlg" role="dialog" aria-modal="true" aria-label="任务详情" tabIndex={-1} ref={box}>
        <div className="tdlg__head">
          <span className="tdlg__title">{t.title}</span>
          <span className="tdlg__sub">详情</span>
          <span className="th__sp" />
          <div className="tdlg__menuwrap">
            <button ref={menuBtn} className="tdlg__icon" aria-label="更多操作" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)}>···</button>
            {menu && (
              <div className="tdlg__menu" role="menu" ref={menuRef} onKeyDown={onMenuKey}>
                {actions.map((a) => <button key={a.label} role="menuitem" onClick={() => { setMenu(false); a.run(); }}>{a.label}</button>)}
              </div>
            )}
          </div>
          <button className="tdlg__icon" aria-label="关闭" onClick={onClose}>×</button>
        </div>
        <div className="tdlg__cols">
          <div className="tdlg__left">
            <div className="tdlg__sec">
              {stage}
              {meegle}
            </div>
            {belong && <div className="tdlg__sec tdlg__belong">{belong}</div>}
            {defects.length > 0 && (
              <section className="tdlg__sec">
                <div className="tdlg__k">名下的缺陷</div>
                <div className="tdlg__defects">
                  {[...defects].sort((a, b) => Number(Boolean(a.source.rootGuess)) - Number(Boolean(b.source.rootGuess))).map((d) => {
                    const guess = Boolean(d.source.rootGuess);
                    return (
                      <div key={d.id} className={`tdlg__defect ${guess ? "is-guess" : ""}`}>
                        <span className={`tdlg__dot tdlg__dot--${guess ? "guess" : d.stage === "testing" ? "test" : d.stage === "dev" ? "prog" : "idle"}`} />
                        <span className="tdlg__dt">{guess && <span className="tdlg__guess">Friday 推断</span>}{d.title}</span>
                        {guess ? (
                          <>
                            <button className="tdlg__link" onClick={() => onAdopt(d)}>是它，进会话</button>
                            <button className="tdlg__link tdlg__link--dim" onClick={() => onReject(d)}>不是这条</button>
                          </>
                        ) : (
                          <span className="tdlg__dm">{defectMeta(d)}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            )}
            {t.understanding && (
              <section className="tdlg__sec">
                <div className="tdlg__k">理解</div>
                <div className="tdlg__text">{t.understanding}</div>
              </section>
            )}
            {description && <section className="tdlg__sec">{description}</section>}
          </div>
          <div className="tdlg__right">
            {resources}
            {slack}
          </div>
        </div>
        <div className="tdlg__chat">{chat}</div>
      </div>
    </div>,
    document.body,
  );
}
