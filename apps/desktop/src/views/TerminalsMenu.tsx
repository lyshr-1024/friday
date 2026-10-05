import { useEffect, useRef, useState } from "react";
import { SESSION_STATE_LABEL, type OpenTerminal } from "@friday/shared";
import { closeTerminals, openTerminals } from "../lib/core";

const WHERE: Record<OpenTerminal["where"], string> = { task: "任务", query: "后台查询", project: "项目", shell: "项目" };

/** 顶栏「N 个终端」：点开列出每个开着的会话，单个关或全部关；点标题跳过去 */
export function TerminalsMenu({ onOpenTask, onOpenProject }: { onOpenTask: (id: string) => void; onOpenProject: (name: string) => void }) {
  const [list, setList] = useState<OpenTerminal[]>([]);
  const [open, setOpen] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const box = useRef<HTMLDivElement>(null);

  const pull = () => void openTerminals().then(setList).catch(() => {});
  useEffect(() => {
    pull();
    const t = window.setInterval(pull, 10000);
    window.addEventListener("friday:tasks-changed", pull);
    return () => { window.clearInterval(t); window.removeEventListener("friday:tasks-changed", pull); };
  }, []);

  useEffect(() => {
    if (!open) return;
    pull();
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setOpen(false);
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("mousedown", onDown, true); window.removeEventListener("keydown", onKey, true); };
  }, [open]);
  useEffect(() => { if (!open) { setConfirmAll(false); setErr(""); } }, [open]);
  useEffect(() => { if (open && list.length === 0) setOpen(false); }, [list.length]);

  async function close(id?: string) {
    setBusy(id ?? "all");
    setErr("");
    try {
      await closeTerminals(id);
      setConfirmAll(false);
      window.dispatchEvent(new Event("friday:tasks-changed"));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
      pull();
    }
  }

  function go(t: OpenTerminal) {
    setOpen(false);
    if (t.taskId) onOpenTask(t.taskId);
    else onOpenProject(t.project);
  }

  if (list.length === 0) return null;
  return (
    <div className="tlist__wrap" ref={box}>
      <button className="topbar__jobs" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)} title="看看哪些地方开着终端">
        <span className="side__spin" />
        <span className="num mono">{list.length}</span> 个终端
      </button>
      {open && (
        <div className="tlist" role="dialog" aria-label="开着的终端">
          {list.map((t) => {
            const state = SESSION_STATE_LABEL[t.state];
            return (
              <div key={t.sessionId} className="tlist__row">
                <span className={`sdot sdot--${t.state}`} />
                <button className="tlist__main" onClick={() => go(t)} title={t.taskId ? "跳到这条任务" : "跳到项目页"}>
                  <span className="tlist__t">{t.label}</span>
                  <span className="tlist__m">{[t.where === "task" || t.where === "query" ? `${WHERE[t.where]} · ${t.project}` : "", state, t.branch].filter(Boolean).join(" · ")}</span>
                </button>
                <button className="tlist__x" aria-label={`关掉 ${t.label}`} title={t.state === "working" ? "关掉（Claude 正在干活，会被打断）" : "关掉这个终端"} disabled={!!busy} onClick={() => void close(t.sessionId)}>×</button>
              </div>
            );
          })}
          <div className="tlist__foot">
            {err ? <span className="tlist__err">{err}</span> : confirmAll ? <span className="tlist__note">里面跑着的 Claude Code 会一起停掉，任务和 worktree 不动。</span> : <span className="tlist__note">关掉只停终端，任务本身不动。</span>}
            {confirmAll ? (
              <>
                <button className="b b--text" onClick={() => setConfirmAll(false)}>取消</button>
                <button className="b b--primary" disabled={!!busy} onClick={() => void close()}>全部关掉</button>
              </>
            ) : (
              <button className="b b--ghost" disabled={!!busy} onClick={() => setConfirmAll(true)}>全部关掉</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
