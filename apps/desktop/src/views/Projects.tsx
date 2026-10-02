import { useCallback, useEffect, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { SESSION_STATE_LABEL, STAGE_GROUP_ORDER, STAGE_LABEL, type ProjectOverview, type ProjectTaskLine, type ProjectTerminal, type Stage } from "@friday/shared";
import { closeProjectTerminal, openProjectTerminal, projectOverview, projectShell, projectTerminals } from "../lib/core";
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
const shellLive = (p: ProjectTerminal) => Boolean(p.shell?.status && p.shell.status !== "closed");
const claudeState = (p: ProjectTerminal) => (p.status === "exited" ? "exited" : p.state ?? "idle");

function subLine(p: ProjectTerminal): string {
  const parts = [live(p) ? (p.status === "exited" ? "Claude 已退出" : SESSION_STATE_LABEL[p.state ?? "idle"] || "Claude 开着") : "", shellLive(p) ? "终端开着" : ""].filter(Boolean);
  return [p.openTasks ? `${p.openTasks} 件在办` : "", ...parts].filter(Boolean).join(" · ") || "没开";
}

/** 注册表里的地址多半不带协议 */
const href = (url: string) => (/^https?:\/\//.test(url) ? url : `https://${url}`);

function TaskRow({ t, onOpen }: { t: ProjectTaskLine; onOpen: (id: string) => void }) {
  const state = t.state && SESSION_STATE_LABEL[t.state];
  return (
    <button className="pj__task" onClick={() => onOpen(t.id)}>
      <span className={`sdot sdot--${t.state ?? "none"}`} />
      <span className="pj__task-t">{t.title}</span>
      <span className="pj__task-m mono">{[state, t.branch].filter(Boolean).join(" · ")}</span>
    </button>
  );
}

/** 概览：项目是什么、主仓停在哪、手上有哪些活。数据来自注册表和任务板，不在这里改 */
function Overview({ o, compact, onOpenTask }: { o: ProjectOverview; compact: boolean; onOpenTask: (id: string) => void }) {
  const [more, setMore] = useState(false);
  const groups = [...STAGE_GROUP_ORDER, undefined].map((st) => ({ st, list: o.open.filter((t) => t.stage === st || (!st && !t.stage)) })).filter((g) => g.list.length);
  return (
    <div className={`pj__ov ${compact ? "pj__ov--compact" : ""}`}>
      {o.note && (
        <div className={`pj__note ${more ? "is-open" : ""}`} onClick={() => setMore(!more)} title={more ? "收起" : "展开"}>{o.note}</div>
      )}
      {(o.envs.length > 0 || o.channels.length > 0 || o.aliases.length > 0) && (
        <div className="pj__facts">
          {o.envs.map((e) => (
            <a key={e.url} className="link" href={href(e.url)} onClick={(ev) => { ev.preventDefault(); void openUrl(href(e.url)); }}>{e.name} {e.url}</a>
          ))}
          {o.channels.length > 0 && <span>{o.channels.join("  ")}</span>}
          {o.aliases.length > 0 && <span className="pj__dim">也叫 {o.aliases.join("、")}</span>}
        </div>
      )}
      <div className="pj__tasks">
        <div className="tdlg__k">手上的活 {o.open.length || ""}</div>
        {groups.length === 0 && <div className="pj__dim">这个项目现在没有没收工的任务。</div>}
        {groups.map((g) => (
          <div key={g.st ?? "none"} className="pj__grp">
            <div className="pj__grp-k">{g.st ? STAGE_LABEL[g.st as Stage] : "没有阶段"}</div>
            {g.list.map((t) => <TaskRow key={t.id} t={t} onOpen={onOpenTask} />)}
          </div>
        ))}
        {o.recent.length > 0 && (
          <details className="pj__recent">
            <summary>最近收工的 {o.recent.length} 条</summary>
            {o.recent.map((t) => <TaskRow key={t.id} t={t} onOpen={onOpenTask} />)}
          </details>
        )}
        {o.leftover > 0 && <div className="pj__dim">还有 {o.leftover} 个收工任务留下的 worktree 没删，在设置页「终端」里清理。</div>}
      </div>
    </div>
  );
}

/** 顶栏「项目」：项目概览，按需在主仓里开 Claude 或普通终端，两个同屏不切换 */
export function Projects({ nav, onOpenTask }: { nav: ReactNode; onOpenTask: (id: string) => void }) {
  const [list, setList] = useState<ProjectTerminal[] | null>(null);
  const [picked, setPicked] = useState<string | null>(pickedBefore);
  const [ov, setOv] = useState<ProjectOverview | null>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  const refresh = useCallback(() => void projectTerminals().then(setList).catch((e) => setErr(e instanceof Error ? e.message : String(e))), []);
  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, 5000);
    window.addEventListener("friday:tasks-changed", refresh);
    return () => { window.clearInterval(t); window.removeEventListener("friday:tasks-changed", refresh); };
  }, [refresh]);

  const cur = list?.find((p) => p.name === picked) ?? list?.[0];

  useEffect(() => {
    if (!cur) return;
    const name = cur.name;
    const pull = () => void projectOverview(name).then((o) => { if (o.name === name) setOv(o); }).catch(() => {});
    setOv(null);
    pull();
    window.addEventListener("friday:tasks-changed", pull);
    const t = window.setInterval(pull, 30000);
    return () => { window.removeEventListener("friday:tasks-changed", pull); window.clearInterval(t); };
  }, [cur?.name]);

  function pick(name: string) {
    setPicked(name);
    try {
      localStorage.setItem(PICK_KEY, name);
    } catch {}
  }

  async function run(what: string, fn: () => Promise<ProjectTerminal>) {
    setBusy(what);
    setErr("");
    try {
      const r = await fn();
      setList((l) => (l ?? []).map((p) => (p.name === r.name ? r : p)));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }

  const claudeOn = cur ? live(cur) : false;
  const shellOn = cur ? shellLive(cur) : false;

  return (
    <>
      <header className="q__head q__head--wide" data-tauri-drag-region>{nav}</header>
      <div className="deck">
        <div className="deck__one">
          {err && <div className="err" style={{ margin: "0 0 12px" }}>{err}</div>}
          {!list ? null : !cur ? (
            <div className="empty"><strong>注册表里还没有项目</strong>在设置页「记忆库 → 项目注册表」里登记项目和目录。</div>
          ) : (
            <section className="detail pj">
              <div className="th">
                <div className="th__meta">
                  <span className="th__m mono">{cur.dir}</span>
                  {ov?.branch && <span className="th__m"><span className="th__sep">·</span>主仓在 <span className="mono">{ov.branch}</span></span>}
                  {ov?.dirty && <span className="th__m pj__dirty"><span className="th__sep">·</span>有没提交的改动</span>}
                  {ov?.status && <span className="th__m"><span className="th__sep">·</span>{ov.status}</span>}
                </div>
                <div className="th__title">
                  <h2 title={cur.name}>{cur.name}</h2>
                  <span className="th__sp" />
                  {!claudeOn && <button className="b b--primary" disabled={!!busy} onClick={() => void run("claude", () => openProjectTerminal(cur.name))}>{busy === "claude" ? "打开中…" : "打开 Claude"}</button>}
                  {!shellOn && <button className="b b--ghost" disabled={!!busy} onClick={() => void run("shell", () => projectShell(cur.name, true))}>{busy === "shell" ? "打开中…" : "开终端"}</button>}
                </div>
              </div>
              {ov && <Overview o={ov} compact={claudeOn || shellOn} onOpenTask={onOpenTask} />}
              {!claudeOn && !shellOn && ov && (
                <div className="pj__hint">「打开 Claude」直接在 <code>{cur.dir}</code> 里开 Claude Code，「开终端」开一个普通 zsh；都不建任务、不建 worktree，改代码就是改主仓。</div>
              )}
              {claudeOn && (
                <div className="pj__term pj__term--claude">
                  <div className="pj__bar">
                    <span className={`sdot sdot--${claudeState(cur)}`} />
                    <span>Claude</span>
                    <span className="pj__dim">{cur.status === "exited" ? "已退出，窗格里是 zsh；要接回旧对话自己 claude --resume" : SESSION_STATE_LABEL[cur.state ?? "idle"]}</span>
                    <span className="th__sp" />
                    <button className="idle__link" disabled={!!busy} title="关掉这段 Claude，全新开一段（上下文太大时用）" onClick={() => void run("fresh", () => openProjectTerminal(cur.name, true))}>{busy === "fresh" ? "新开中…" : "新开一段"}</button>
                  </div>
                  <div className="pj__termbox"><Terminal key={cur.jobId ?? ""} sessionId={cur.taskId!} onCloseSession={() => void run("closeClaude", () => closeProjectTerminal(cur.name))} /></div>
                </div>
              )}
              {shellOn && (
                <div className="pj__term pj__term--shell">
                  <div className="pj__bar">
                    <span className="sdot sdot--idle" />
                    <span>终端</span>
                  </div>
                  <div className="pj__termbox"><Terminal key={cur.shell!.taskId} sessionId={cur.shell!.taskId} onCloseSession={() => void run("close", () => projectShell(cur.name, false))} /></div>
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
                  <span className={`sdot sdot--${live(p) ? claudeState(p) : shellLive(p) ? "idle" : "none"}`} />
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
