import { useCallback, useEffect, useState, type ReactNode } from "react";
import { SESSION_STATE_LABEL, type ProjectTerminal } from "@friday/shared";
import { openProjectTerminal, projectTerminals } from "../lib/core";
import { Terminal } from "./Terminal";

const PICK_KEY = "friday:project";

const pickedBefore = (): string | null => {
  try {
    return localStorage.getItem(PICK_KEY);
  } catch {
    return null;
  }
};

const live = (p: ProjectTerminal) => Boolean(p.taskId && p.status && p.status !== "closed");

function subLine(p: ProjectTerminal): string {
  if (!live(p)) return "没开终端";
  if (p.status === "exited") return "Claude 已退出";
  return (p.state && SESSION_STATE_LABEL[p.state]) || "终端开着";
}

/** 顶栏「项目」：不建任务，直接在项目主仓里开一个 Claude 终端 */
export function Projects({ nav }: { nav: ReactNode }) {
  const [list, setList] = useState<ProjectTerminal[] | null>(null);
  const [picked, setPicked] = useState<string | null>(pickedBefore);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const refresh = useCallback(() => void projectTerminals().then(setList).catch((e) => setErr(e instanceof Error ? e.message : String(e))), []);
  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, 5000);
    window.addEventListener("friday:tasks-changed", refresh);
    return () => { window.clearInterval(t); window.removeEventListener("friday:tasks-changed", refresh); };
  }, [refresh]);

  const cur = list?.find((p) => p.name === picked) ?? list?.[0];

  function pick(name: string) {
    setPicked(name);
    try {
      localStorage.setItem(PICK_KEY, name);
    } catch {}
  }

  async function open(name: string) {
    setBusy(true);
    setErr("");
    try {
      const r = await openProjectTerminal(name);
      setList((l) => (l ?? []).map((p) => (p.name === name ? r : p)));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header className="q__head q__head--wide" data-tauri-drag-region>{nav}</header>
      <div className="deck">
        <div className="deck__one">
          {err && <div className="err" style={{ margin: "0 0 12px" }}>{err}</div>}
          {!list ? null : !cur ? (
            <div className="empty"><strong>注册表里还没有项目</strong>在设置页「记忆库 → 项目注册表」里登记项目和目录。</div>
          ) : (
            <section className="detail">
              <div className="th">
                <div className="th__meta">
                  <span className={`th__state th__state--${live(cur) ? (cur.status === "exited" ? "exited" : cur.state ?? "idle") : "none"}`}>
                    <span className={`sdot sdot--${live(cur) ? (cur.status === "exited" ? "exited" : cur.state ?? "idle") : "none"}`} />
                    {subLine(cur)}
                  </span>
                  <span className="th__m"><span className="th__sep">·</span>{cur.dir}</span>
                </div>
                <div className="th__title"><h2 title={cur.name}>{cur.name}</h2></div>
              </div>
              {live(cur) ? (
                <>
                  {cur.status === "exited" && (
                    <div className="detail__resume">Claude 已退出<span className="th__sep">·</span><button className="idle__link" disabled={busy} onClick={() => void open(cur.name)}>接着聊</button></div>
                  )}
                  <div className="detail__term"><Terminal key={cur.jobId ?? ""} sessionId={cur.taskId!} /></div>
                </>
              ) : (
                <div className="pt__empty">
                  <p>直接在 <code>{cur.dir}</code> 里开一个 Claude Code 终端：不建任务、不建 worktree，适合临时查代码、问问题。在里面改代码就是改主仓。</p>
                  <button className="b b--primary" disabled={busy} onClick={() => void open(cur.name)}>{busy ? "打开中…" : "打开终端"}</button>
                </div>
              )}
            </section>
          )}
        </div>
        <aside className="side">
          <nav className="anchors" aria-label="项目">
            <div className="anchors__scroll">
              <div className="anchors__g">项目</div>
              {(list ?? []).map((p) => (
                <div
                  key={p.name}
                  className="an"
                  role="button"
                  tabIndex={0}
                  aria-current={p.name === cur?.name}
                  onClick={() => pick(p.name)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(p.name); } }}
                >
                  <span className={`sdot sdot--${live(p) ? (p.status === "exited" ? "exited" : p.state ?? "idle") : "none"}`} />
                  <span className="an__main">
                    <span className="an__t">{p.name}</span>
                    <span className="an__sub">{subLine(p)}</span>
                  </span>
                </div>
              ))}
            </div>
          </nav>
        </aside>
      </div>
    </>
  );
}
