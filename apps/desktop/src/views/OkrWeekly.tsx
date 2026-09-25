import { useEffect, useRef, useState } from "react";
import type { OkrRow, OkrWeeklyDraft, Task } from "@friday/shared";
import { saveOkrDraft } from "../lib/core";

type Edit = { objectId: number; content?: string; pct?: number; checked?: boolean };

// 提交前要等最后一次编辑落盘，不然交出去的是防抖里还没存的旧草稿
const queued = new Map<string, { edits: Map<number, Edit>; timer: number; flush: () => Promise<void> }>();

export function flushOkrDraft(taskId: string): Promise<void> {
  const q = queued.get(taskId);
  if (!q) return Promise.resolve();
  window.clearTimeout(q.timer);
  return q.flush();
}

function queueEdit(taskId: string, e: Edit) {
  const q = queued.get(taskId) ?? { edits: new Map<number, Edit>(), timer: 0, flush: async () => {} };
  q.edits.set(e.objectId, { ...q.edits.get(e.objectId), ...e });
  q.flush = async () => {
    queued.delete(taskId);
    await saveOkrDraft(taskId, [...q.edits.values()]);
    window.dispatchEvent(new Event("friday:tasks-changed"));
  };
  window.clearTimeout(q.timer);
  q.timer = window.setTimeout(() => void q.flush(), 400);
  queued.set(taskId, q);
}

const STATE_NOTE: Partial<Record<OkrRow["state"], string>> = { existing: "平台上这周已经有了，不会覆盖", submitted: "已提交", failed: "提交失败" };

export function OkrWeekly({ t }: { t: Task }) {
  const action = t.pending?.find((p) => p.type === "okr_submit");
  const server = action?.payload as unknown as OkrWeeklyDraft | undefined;
  const [rows, setRows] = useState<OkrRow[]>(server?.rows ?? []);
  const lastServer = useRef(server);
  useEffect(() => {
    if (server && server !== lastServer.current && !queued.has(t.id)) setRows(server.rows);
    lastServer.current = server;
  }, [server, t.id]);
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
          <input className="okr__pct" type="number" min={0} max={100} value={r.pct} readOnly={locked} onChange={(e) => edit(r.objectId, { pct: Number(e.target.value) })} aria-label="进度百分比" />
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
