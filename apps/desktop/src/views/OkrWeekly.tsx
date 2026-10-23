import { useEffect, useRef, useState } from "react";
import type { OkrRow, OkrWeeklyDraft, Task } from "@friday/shared";
import { saveOkrDraft } from "../lib/core";

type Edit = { objectId: number; content?: string; pct?: number; checked?: boolean };
type Queue = { edits: Map<number, Edit>; timer: number; error: string | null };

// 提交前要等最后一次编辑落盘，不然交出去的是防抖里还没存的旧草稿
const queued = new Map<string, Queue>();

function notify(taskId: string) {
  window.dispatchEvent(new CustomEvent("friday:okr-draft", { detail: { taskId } }));
}

// 存哪批边界都在这一处读 q.edits：失败不删，留着重试；
// 存的过程里又来的新编辑不能被误删——只清掉这批真正存上的那些。
async function flush(taskId: string): Promise<void> {
  const q = queued.get(taskId);
  if (!q || q.edits.size === 0) return;
  window.clearTimeout(q.timer);
  const batch = new Map(q.edits);
  try {
    await saveOkrDraft(taskId, [...batch.values()]);
    for (const [k, v] of batch) if (q.edits.get(k) === v) q.edits.delete(k);
    q.error = null;
    if (q.edits.size === 0) queued.delete(taskId);
    window.dispatchEvent(new Event("friday:tasks-changed"));
  } catch (err) {
    q.error = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    notify(taskId);
  }
}

export function flushOkrDraft(taskId: string): Promise<void> {
  return flush(taskId);
}

function queueEdit(taskId: string, e: Edit) {
  const q = queued.get(taskId) ?? { edits: new Map<number, Edit>(), timer: 0, error: null };
  q.edits.set(e.objectId, { ...q.edits.get(e.objectId), ...e });
  window.clearTimeout(q.timer);
  q.timer = window.setTimeout(() => void flush(taskId).catch(() => {}), 400);
  queued.set(taskId, q);
  notify(taskId);
}

const STATE_NOTE: Partial<Record<OkrRow["state"], string>> = { existing: "平台上这周已经有了，不会覆盖", submitted: "已提交", failed: "提交失败" };

export function OkrWeekly({ t, onRows }: { t: Task; onRows?: (rows: OkrRow[]) => void }) {
  const action = t.pending?.find((p) => p.type === "okr_submit");
  const server = action?.payload as unknown as OkrWeeklyDraft | undefined;
  const [rows, setRows] = useState<OkrRow[]>(server?.rows ?? []);
  const [saveError, setSaveError] = useState<string | null>(() => queued.get(t.id)?.error ?? null);
  // 进度框清空的那一下不能存成 0：先只改显示，等输入成数字再排进保存队列
  const [pctText, setPctText] = useState<Record<number, string>>({});
  const lastServer = useRef(server);
  useEffect(() => onRows?.(rows), [rows]);
  useEffect(() => {
    if (server && server !== lastServer.current && !queued.has(t.id)) setRows(server.rows);
    lastServer.current = server;
  }, [server, t.id]);
  useEffect(() => {
    setSaveError(queued.get(t.id)?.error ?? null);
    const onDraft = (e: Event) => {
      if ((e as CustomEvent<{ taskId: string }>).detail?.taskId !== t.id) return;
      setSaveError(queued.get(t.id)?.error ?? null);
    };
    window.addEventListener("friday:okr-draft", onDraft);
    return () => window.removeEventListener("friday:okr-draft", onDraft);
  }, [t.id]);
  if (!server) return t.progress ? <div className="fx__text">{t.progress}</div> : null;

  const edit = (objectId: number, patch: Omit<Edit, "objectId">) => {
    setRows((rs) => rs.map((r) => (r.objectId === objectId ? { ...r, ...patch } : r)));
    queueEdit(t.id, { objectId, ...patch });
  };
  const withWork = rows.filter((r) => r.state !== "empty" || r.checked);
  const empty = rows.filter((r) => r.state === "empty" && !r.checked);
  const byO = [...new Set(withWork.map((r) => r.objective))];

  const Row = (r: OkrRow) => {
    const locked = r.state === "existing" || r.state === "submitted";
    return (
      <div key={r.objectId} className={`okr__row okr__row--${r.state}`}>
        <label className="okr__head">
          <input type="checkbox" checked={r.checked} disabled={locked} onChange={(e) => edit(r.objectId, { checked: e.target.checked })} />
          <span className="okr__kr" title={r.kr}>{r.kr}</span>
          {STATE_NOTE[r.state] && <span className="okr__state">{STATE_NOTE[r.state]}{r.error ? `：${r.error}` : ""}</span>}
        </label>
        <textarea className="okr__text" value={r.content} readOnly={locked} rows={3} placeholder="这周在这个 KR 上做了什么" onChange={(e) => edit(r.objectId, { content: e.target.value })} />
        <div className="okr__meta">
          <input
            className="okr__pct"
            type="number"
            min={0}
            max={100}
            value={pctText[r.objectId] ?? r.pct}
            readOnly={locked}
            onChange={(e) => {
              const v = e.target.value;
              setPctText((m) => ({ ...m, [r.objectId]: v }));
              if (v.trim() !== "" && Number.isFinite(Number(v))) edit(r.objectId, { pct: Number(v) });
            }}
            onBlur={() => setPctText((m) => {
              const next = { ...m };
              delete next[r.objectId];
              return next;
            })}
            aria-label="进度百分比"
          />
          <span>%</span>
          <span className="okr__why">{r.prevPct !== null ? `上周 ${r.prevPct}` : "上周没填"}{r.why ? ` · 依据：${r.why}` : ""}</span>
        </div>
        {r.used.length > 0 && (
          <details className="okr__used">
            <summary>用到的素材 {r.used.length} 条</summary>
            <ul>{r.used.map((u) => <li key={u.id}>{u.text}</li>)}</ul>
          </details>
        )}
      </div>
    );
  };

  return (
    <div className="okr">
      {t.understanding && <div className="fx__text">{t.understanding}</div>}
      {saveError && <div className="okr__err">保存失败：{saveError}，提交前会再试一次</div>}
      {byO.map((o) => (
        <section key={o} className="okr__group">
          <span className="k">{o}</span>
          {withWork.filter((r) => r.objective === o).map(Row)}
        </section>
      ))}
      {empty.length > 0 && (
        <section className="okr__group">
          <span className="k">本周没找到相关工作（勾上可以手写补交）</span>
          {empty.map((r) => (
            <label key={r.objectId} className="okr__head okr__head--empty">
              <input type="checkbox" checked={false} onChange={() => edit(r.objectId, { checked: true })} />
              <span className="okr__kr" title={r.kr}>{r.kr}</span>
            </label>
          ))}
        </section>
      )}
      {server.unmatched.length > 0 && (
        <details className="okr__used">
          <summary>没对上任何 KR 的工作 {server.unmatched.length} 条</summary>
          <ul>{server.unmatched.map((u) => <li key={u.id}>{u.text}</li>)}</ul>
        </details>
      )}
    </div>
  );
}
