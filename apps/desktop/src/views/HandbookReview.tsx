import { useState } from "react";
import type { Task } from "@friday/shared";
import { taskApprove, taskSet } from "../lib/core";
import { Icon } from "./Icon";

type Line =
  | { t: "head"; text: string }
  | { t: "label"; text: string }
  | { t: "add" | "retire" | "conflict" | "stale"; text: string; quotes: string[] }
  | { t: "revise"; from: string; to: string; quotes: string[] }
  | { t: "meta"; text: string };

const ITEM: Record<string, "add" | "retire" | "conflict" | "stale"> = { "+": "add", "-": "retire", "!": "conflict", "?": "stale" };

/** plan 是 core 的 draftSummary 逐行拼的：`## 项目`、`新增 N`、`+ 规则`、`~ 旧 → 新`、`  > [n] 原话`… */
function parse(plan: string): Line[] {
  const out: Line[] = [];
  for (const raw of plan.split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim() || line === "---") continue;
    const last = out.at(-1);
    if (/^\s+>/.test(line)) {
      if (last && "quotes" in last) last.quotes.push(line.replace(/^\s+>\s*/, ""));
      continue;
    }
    if (line.startsWith("## ")) out.push({ t: "head", text: line.slice(3) });
    else if (line.startsWith("~ ")) {
      const at = line.indexOf(" → ");
      out.push(at < 0 ? { t: "meta", text: line.slice(2) } : { t: "revise", from: line.slice(2, at), to: line.slice(at + 3), quotes: [] });
    } else if (ITEM[line[0]!] && line[1] === " ") out.push({ t: ITEM[line[0]!]!, text: line.slice(2), quotes: [] });
    else if (/^(新增|改写|退役|冲突|久未确认) \d/.test(line)) out.push({ t: "label", text: line });
    else out.push({ t: "meta", text: line });
  }
  return out;
}

const MARK = { add: "+", retire: "−", conflict: "!", stale: "?" };

/** 退役是「规则（为什么）」：只划掉规则，原因照常读 */
function RetireLine({ text }: { text: string }) {
  const m = /^(.*)（([^（）]*)）$/.exec(text);
  return m ? <div><span className="hbr__from">{m[1]}</span><span className="hbr__why"> · {m[2]}</span></div> : <div className="hbr__from">{text}</div>;
}

/** 从 Claude Code 历史学到的手册改动：不是工作任务，不进任务列表，在设置页里过目 */
export function HandbookReview({ task, onBack }: { task: Task; onBack: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const action = (task.pending ?? []).find((p) => p.type === "handbook_apply");
  const lines = parse(task.plan ?? "");

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

  return (
    <div className="editor">
      <header className="editor__head">
        <button className="editor__back" onClick={onBack}><Icon name="chevronRight" className="icon--flip" />设置</button>
        <span className="editor__title">手册改动待过目</span>
        <span className="editor__status mono">{err || task.createdAt.slice(0, 10)}</span>
      </header>
      <div className="rules hbr">
        <p className="hbr__intro">{task.understanding}</p>
        {lines.map((l, i) => {
          if (l.t === "head") return <h3 key={i} className="hbr__head">{l.text}</h3>;
          if (l.t === "label") return <div key={i} className="k hbr__label">{l.text}</div>;
          if (l.t === "meta") return <div key={i} className="hbr__meta">{l.text}</div>;
          return (
            <div key={i} className={`hbr__item hbr__item--${l.t}`}>
              <span className="hbr__mark mono" aria-hidden>{l.t === "revise" ? "~" : MARK[l.t]}</span>
              <div className="hbr__body">
                {l.t === "revise" ? (
                  <>
                    <div className="hbr__from">{l.from}</div>
                    <div>{l.to}</div>
                  </>
                ) : l.t === "retire" ? (
                  <RetireLine text={l.text} />
                ) : (
                  <div>{l.text}</div>
                )}
                {l.quotes.length > 0 && (
                  <ul className="rules__evidence">
                    {l.quotes.map((q, j) => <li key={j}>{q}</li>)}
                  </ul>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <footer className="hbr__foot">
        <span className="hbr__conseq">写进规则表并重新生成 handbooks/，派去终端的 Claude 下次开工就读到；可在操作记录里整体撤销。</span>
        <button className="b b--ghost" disabled={busy} onClick={() => void run(() => taskSet(task.id, "ignore"))}>这批不要</button>
        <button className="b b--primary" disabled={busy || !action} onClick={() => action && void run(() => taskApprove(task.id, action.id))}>通过，写进手册</button>
      </footer>
    </div>
  );
}
