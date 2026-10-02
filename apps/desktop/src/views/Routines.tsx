import { useEffect, useState } from "react";
import type { OkrRow, OkrWeeklyDraft, SettingsResponse, Task } from "@friday/shared";
import { learnHistory, listHandbooks, okrWeeklyNow, settings, taskApprove, taskSet, updateSettings } from "../lib/core";
import { Modal } from "./TaskDialog";
import { OkrWeekly, flushOkrDraft } from "./OkrWeekly";
import { HandbookReview } from "./HandbookReview";
import { RulesEditor } from "./RulesEditor";
import { Row } from "./shared";

export type Routine = "weekly" | "learn";

const closed = (t: Task) => t.status === "done" || t.status === "ignored";
const day = (iso: string) => iso.slice(5, 10);
const submittable = (rows: OkrRow[]) => rows.filter((r) => r.checked && r.state !== "existing" && r.state !== "submitted" && r.content.trim()).length;

/** 还挂着要你处理的：周报只认最新那张没收工的，手册可能攒了好几批 */
export const openWeekly = (ts: Task[]) => ts.find((t) => !closed(t));
export const openReviews = (ts: Task[]) => ts.filter((t) => t.status === "review" && (t.pending ?? []).some((p) => p.type === "handbook_apply"));

function usePrefs() {
  const [prefs, setPrefs] = useState<SettingsResponse | null>(null);
  useEffect(() => { void settings().then(setPrefs).catch(() => {}); }, []);
  const toggle = (key: "okrWeekly" | "learnHistory") => { if (prefs) void updateSettings({ [key]: !prefs[key] }).then(setPrefs); };
  return { prefs, toggle };
}

function Switch({ on, disabled, onClick }: { on: boolean; disabled: boolean; onClick: () => void }) {
  return <button className={`switch ${on ? "switch--on" : ""}`} role="switch" aria-checked={on} disabled={disabled} onClick={onClick} />;
}

/** 点了就跑、跑完把结果在按钮上显示几秒 */
function useRun() {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  async function run(fn: () => Promise<string>) {
    setBusy(true);
    setNote("");
    try {
      setNote(await fn());
    } catch (e) {
      setNote(e instanceof Error ? e.message : "出错了");
    } finally {
      setBusy(false);
      setTimeout(() => setNote(""), 6000);
    }
  }
  return { busy, note, run };
}

function weeklyState(t: Task): string {
  if (t.status === "done") return "已提交";
  if (t.status === "ignored") return "没交";
  if (t.status === "blocked") return "卡住了";
  return t.pending?.some((p) => p.type === "okr_submit") ? "待提交" : "处理中";
}

export function WeeklyDialog({ tasks, onClose }: { tasks: Task[]; onClose: () => void }) {
  const { prefs, toggle } = usePrefs();
  const draft = useRun();
  const current = openWeekly(tasks);
  const history = tasks.filter((t) => t !== current);
  const action = current?.pending?.find((p) => p.type === "okr_submit");
  const [rows, setRows] = useState<OkrRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const week = current?.source.okrWeek ?? (action?.payload as unknown as OkrWeeklyDraft | undefined)?.week;
  const n = submittable(rows);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setErr("");
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal label="周报" title="OKR 周报" sub={week ?? "这周还没起草"} onClose={onClose} className="rtn">
      <div className="group">
        <Row label="每周自动起草" hint="每周五 16:00 后用本周 git 提交和任务起草；平台上这周已经有你自己填的就跳过">
          <Switch on={!!prefs?.okrWeekly} disabled={!prefs} onClick={() => toggle("okrWeekly")} />
        </Row>
        <Row label={current ? "重新起草" : "现在起草一份"} hint={current ? "按最新的提交和任务重写草稿，已经交上去的几条原样保留" : "不等到周五，立刻按本周内容起草一份"}>
          <button
            className="btn"
            disabled={draft.busy}
            onClick={() => void draft.run(async () => {
              const r = await okrWeeklyNow();
              return r.skipped ?? `起草好了：${r.drafted} 条`;
            })}
          >
            {draft.busy ? "起草中…" : draft.note || (current ? "重新起草" : "现在起草")}
          </button>
        </Row>
      </div>

      {current && (
        <section className="rtn__sec">
          <div className="tdlg__k">草稿 · {weeklyState(current)}</div>
          {current.status === "blocked" && current.progress && <div className="okr__err">{current.progress}</div>}
          <OkrWeekly key={current.id} t={current} onRows={setRows} />
        </section>
      )}

      {history.length > 0 && (
        <section className="rtn__sec">
          <div className="tdlg__k">往期</div>
          <div className="rtn__list">
            {history.map((t) => (
              <div key={t.id} className="rtn__item">
                <span className="rtn__name mono">{t.source.okrWeek ?? t.title}</span>
                <span className={`rtn__state rtn__state--${t.status}`}>{weeklyState(t)}</span>
                <span className="rtn__note" title={t.progress ?? ""}>{t.progress ?? ""}</span>
              </div>
            ))}
          </div>
        </section>
      )}
      {current && action && (
        <footer className="hbr__foot rtn__foot">
          <span className="hbr__conseq">{err || `以你的身份提交到 OKR 平台 ${week ?? ""}，共 ${n} 条；可以在操作记录里撤销（会删掉这几条）。`}</span>
          <button className="b b--ghost" disabled={busy} onClick={() => void act(() => taskSet(current.id, "ignore"))}>这周不交</button>
          <button
            className="b b--primary"
            disabled={busy || n === 0}
            onClick={() => void act(async () => {
              await flushOkrDraft(current.id);
              await taskApprove(current.id, action.id);
            })}
          >
            {busy ? "提交中" : `提交 ${n} 条`}
          </button>
        </footer>
      )}
    </Modal>
  );
}

function learnState(t: Task): string {
  if (t.status === "done") return "写进了手册";
  if (t.status === "ignored") return "没要";
  return t.status === "review" ? "待过目" : "处理中";
}

export function LearnDialog({ tasks, onClose }: { tasks: Task[]; onClose: () => void }) {
  const { prefs, toggle } = usePrefs();
  const learn = useRun();
  const [handbooks, setHandbooks] = useState<string[]>([]);
  const [page, setPage] = useState<{ review: Task } | { rules: string } | null>(null);
  const reviews = openReviews(tasks);
  const history = tasks.filter((t) => !reviews.includes(t));
  useEffect(() => { void listHandbooks().then(setHandbooks).catch(() => {}); }, [page]);

  return (
    <Modal label="学习" title="学习" sub="从你在 Claude Code 里说过的话提炼项目手册" onClose={onClose} className="rtn">
      {page && "review" in page ? (
        <HandbookReview task={page.review} onBack={() => setPage(null)} />
      ) : page ? (
        <RulesEditor project={page.rules} onBack={() => setPage(null)} />
      ) : (
        <>
          <div className="group">
            <Row label="每周自动学一轮" hint="扫上次之后的 Claude Code 会话，提炼结果挂在这里待你过目；一轮约 $0.2，冷启动那次约 $1">
              <Switch on={!!prefs?.learnHistory} disabled={!prefs} onClick={() => toggle("learnHistory")} />
            </Row>
            <Row label="现在学一轮" hint="不等到下周，立刻扫一遍">
              <button
                className="btn"
                disabled={learn.busy}
                onClick={() => void learn.run(async () => {
                  const r = await learnHistory();
                  return r.skipped ? "没学到新的" : `提炼了 ${r.groups} 份，在下面过目`;
                })}
              >
                {learn.busy ? "提炼中…" : learn.note || "现在学一轮"}
              </button>
            </Row>
          </div>

          {reviews.length > 0 && (
            <section className="rtn__sec">
              <div className="tdlg__k">待你过目</div>
              <div className="group">
                {reviews.map((t) => (
                  <Row key={t.id} label={t.title} hint={`${day(t.createdAt)} 学的`}>
                    <button className="btn" onClick={() => setPage({ review: t })}>过目…</button>
                  </Row>
                ))}
              </div>
            </section>
          )}

          <section className="rtn__sec">
            <div className="tdlg__k">手册</div>
            {handbooks.length === 0 ? (
              <div className="rtn__empty">还没有手册。学一轮会按项目提炼出「在这里怎么干活」，每条带你的原话出处。</div>
            ) : (
              <div className="group">
                {handbooks.map((slug) => (
                  <Row key={slug} label={slug === "_global" ? "通用习惯" : slug} hint="派去终端干活的 Claude 会先读这份；学错了点「退役」写一句为什么，你改过的 Friday 不会再动">
                    <button className="btn" onClick={() => setPage({ rules: slug })}>规则…</button>
                  </Row>
                ))}
              </div>
            )}
          </section>

          {history.length > 0 && (
            <section className="rtn__sec">
              <div className="tdlg__k">学过的</div>
              <div className="rtn__list">
                {history.map((t) => (
                  <div key={t.id} className="rtn__item">
                    <span className="rtn__name mono">{day(t.createdAt)}</span>
                    <span className={`rtn__state rtn__state--${t.status}`}>{learnState(t)}</span>
                    <span className="rtn__note" title={t.title}>{t.title}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </Modal>
  );
}
