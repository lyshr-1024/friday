import { useEffect, useState } from "react";
import { briefable, type Brief, type ClientTask as Task } from "@friday/shared";
import { briefBuild, briefDepReady, projectKnowledge, taskApprove, taskReject } from "../lib/core";
import { useImeGuard } from "../lib/ime";
import { Linkified } from "./shared";

const BUILDING = "Friday 在读需求、写理解卡";
const REVIEW: Record<Brief["review"], string> = { pending: "待你审", approved: "审过", none: "不用审", rejected: "被打回" };
const CASES_FROM: Record<Brief["acceptance"]["source"], string> = { cases: "现成用例", prd: "按 PRD 推的", own: "Friday 自己写的" };

type Act = (t: Task, fn: () => Promise<unknown>) => Promise<void>;

export function BriefCard({ t, onAct }: { t: Task; onAct: Act }) {
  const b = t.source.brief;
  const failed = t.source.briefFailed;
  const building = !failed && Boolean(t.progress?.startsWith("Friday 在读需求"));
  const canEdit = briefable(t);
  const [err, setErr] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [names, setNames] = useState<Record<string, string>>({});
  const features = b?.features.join(",") ?? "";

  useEffect(() => {
    if (!building) return;
    const timer = window.setInterval(() => window.dispatchEvent(new Event("friday:tasks-changed")), 5000);
    return () => window.clearInterval(timer);
  }, [building]);

  useEffect(() => {
    if (!features || !t.project) return;
    void projectKnowledge(t.project).then((k) => setNames(Object.fromEntries(k.features.map((f) => [f.id, f.name])))).catch(() => undefined);
  }, [features, t.project]);

  const run = (fn: () => Promise<unknown>) => {
    setErr("");
    return onAct(t, async () => {
      try {
        await fn();
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    });
  };
  const rebuild = () => void run(() => briefBuild(t.id));
  const approve = t.pending?.find((a) => a.type === "brief_approve");
  const errLine = err && <div className="brief__err">{err}</div>;
  const buildingLine = <div className="brief__line brief__line--live"><span className="brief__spin" />{BUILDING}</div>;
  const failedLine = failed && (
    <div className="brief__failed">
      <div className="brief__line">
        <span>理解没建成：{failed.why}</span>
        {canEdit && !b && <button className="b b--ghost" onClick={rebuild}>重建</button>}
      </div>
      {failed.log && <code className="brief__log">{failed.log}</code>}
    </div>
  );

  if (!b) {
    return (
      <div className="brief brief--bare">
        {building ? buildingLine : failed ? failedLine : (
          <div className="brief__line">
            <span>还没有理解卡</span>
            <button className="b b--ghost" onClick={rebuild}>建理解卡</button>
          </div>
        )}
        {errLine}
      </div>
    );
  }

  return (
    <div className="brief">
      <div className="brief__head">
        <span className="brief__title">理解卡</span>
        <span className="brief__meta">{REVIEW[b.review]}</span>
        <span className="th__sp" />
        {canEdit && !building && <button className="b b--text" onClick={rebuild}>重建</button>}
      </div>
      {building && buildingLine}
      {failedLine}
      {errLine}
      {b.stale && <div className="brief__note">需求变了，这张卡写在变之前，{b.review === "rejected" ? "点重建" : `重建或在主对话里说「#${t.seq} 按这个做」`}</div>}
      {b.review === "rejected" && b.reviewNote && <div className="brief__note">打回原因：{b.reviewNote}</div>}

      <section className="brief__sec">
        <div className="brief__k">要做什么</div>
        <div className="brief__text"><Linkified text={b.todo} /></div>
      </section>

      <section className="brief__sec">
        <div className="brief__k">要别人给的</div>
        {b.deps.length ? (
          <ul className="brief__deps">
            {b.deps.map((d, i) => (
              <li key={i} className="brief__dep">
                <span className={`brief__dot brief__dot--${d.status}`} aria-label={d.status === "ready" ? "到了" : "还没到"} />
                <span className="brief__dep-main">
                  <span>{d.what}{d.from && <span className="brief__dim"> · 找 {d.from}</span>}</span>
                  {d.evidence && <span className="brief__ev"><Linkified text={[d.evidence.text, d.evidence.url].filter(Boolean).join(" ")} /></span>}
                </span>
                {d.status === "pending" && canEdit && <button className="b b--ghost brief__ready" onClick={() => void run(() => briefDepReady(t.id, i))}>到了</button>}
              </li>
            ))}
          </ul>
        ) : <div className="brief__dim">不用等别人</div>}
      </section>

      <section className="brief__sec">
        <div className="brief__k">怎么验收<span className="brief__dim"> · {CASES_FROM[b.acceptance.source]}</span></div>
        <ol className="brief__cases">
          {b.acceptance.cases.map((c, i) => <li key={i}><Linkified text={c} /></li>)}
        </ol>
        {b.acceptance.note && <div className="brief__dim">{b.acceptance.note}</div>}
      </section>

      <section className="brief__sec">
        <div className="brief__k">怎么发</div>
        <div className="brief__text"><Linkified text={b.release} /></div>
      </section>

      <details className="brief__plan">
        <summary className="brief__k">方案</summary>
        <div className="brief__text"><Linkified text={b.plan} /></div>
      </details>

      {b.features.length > 0 && (
        <div className="brief__features"><span className="brief__k">知识库</span>{b.features.map((id) => names[id] ?? id).join("、")}</div>
      )}

      {approve && (
        <div className="brief__foot">
          <div className="brief__dim">通过后，依赖齐了 Friday 就会自己开工（自主开工开着时）</div>
          <div className="brief__acts">
            <button className="b b--primary" disabled={building} onClick={() => void run(() => taskApprove(t.id, approve.id))}>方案看过，开工</button>
            <button className="b b--ghost" disabled={building} onClick={() => setRejecting(true)}>打回…</button>
          </div>
        </div>
      )}
      {rejecting && <RejectBrief onClose={() => setRejecting(false)} onReject={(reason) => { setRejecting(false); void run(() => taskReject(t.id, reason)); }} />}
    </div>
  );
}

function RejectBrief({ onClose, onReject }: { onClose: () => void; onReject: (reason: string) => void }) {
  const [reason, setReason] = useState("");
  const ime = useImeGuard();
  const submit = () => { if (reason.trim()) onReject(reason.trim()); };
  return (
    <div className="modal" onMouseDown={onClose}>
      <div className="modal__box" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="打回理解卡">
        <strong className="modal__title">打回理解卡</strong>
        <p className="modal__note">写清哪里不对，Friday 照这个重建一次。</p>
        <div className="modal__row">
          <textarea
            autoFocus
            rows={4}
            value={reason}
            placeholder="哪里不对、该怎么改"
            onChange={(e) => setReason(e.target.value)}
            {...ime.handlers}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { if (ime.isImeEnter(e)) return; e.preventDefault(); submit(); }
              if (e.key === "Escape") { e.preventDefault(); onClose(); }
            }}
          />
        </div>
        <div className="modal__foot">
          <button className="b b--primary" disabled={!reason.trim()} onClick={submit}>打回<kbd>⌘↵</kbd></button>
          <button className="b b--text" onClick={onClose}>取消</button>
        </div>
      </div>
    </div>
  );
}
