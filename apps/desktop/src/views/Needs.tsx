import { useEffect, useState } from "react";
import { NEED_LABEL } from "@friday/shared";
import type { MainNeeds } from "@friday/shared";
import { mainNeeds } from "../lib/core";
import { fmtTime } from "./shared";
import type { FridayEvent } from "../lib/events";

const GROUPS: Array<{ key: keyof MainNeeds; label: string; dot: string }> = [
  { key: "brief", label: NEED_LABEL.brief, dot: "dot--review" },
  { key: "review", label: NEED_LABEL.review, dot: "dot--done" },
  { key: "blocked", label: NEED_LABEL.blocked, dot: "dot--blocked" },
  { key: "working", label: "在干", dot: "dot--processing" },
  { key: "queued", label: "排队", dot: "" },
];

/** 主对话右侧：现在有哪些事在等你、在干、排队。点一行去那条任务。 */
export function Needs({ mainId, onPick }: { mainId: string | null; onPick: (taskId: string) => void }) {
  const [needs, setNeeds] = useState<MainNeeds | null>(null);

  useEffect(() => {
    let timer = 0;
    const pull = () => void mainNeeds().then(setNeeds).catch(() => {});
    const later = () => { window.clearTimeout(timer); timer = window.setTimeout(pull, 200); };
    pull();
    const onEvent = (e: Event) => {
      const ev = (e as CustomEvent<FridayEvent>).detail;
      if (ev.type === "tasks" || (ev.type === "conversation" && ev.id === mainId)) later();
    };
    window.addEventListener("friday:event", onEvent);
    return () => { window.clearTimeout(timer); window.removeEventListener("friday:event", onEvent); };
  }, [mainId]);

  const shown = needs ? GROUPS.filter((g) => needs[g.key].length > 0) : [];
  return (
    <aside className="needs" aria-label="等你">
      <div className="needs__head">等你</div>
      {needs && shown.length === 0 && <div className="needs__empty">眼下没有要你处理的事。</div>}
      {shown.map((g) => (
        <section key={g.key} className="needs__group">
          <h3 className="needs__title">{g.label}<span className="needs__n">{needs![g.key].length}</span></h3>
          {needs![g.key].map((n) => (
            <button key={n.id} className="needs__row" onClick={() => onPick(n.id)} title={n.reason ?? n.title}>
              <span className={`dot ${g.dot}`} />
              <span className="needs__main">
                <span className="needs__text"><span className="needs__seq mono">#{n.seq}</span> {n.title}</span>
                <span className="needs__meta">{n.reason ? `${n.reason} · ` : ""}{fmtTime(n.since)}</span>
              </span>
            </button>
          ))}
        </section>
      ))}
    </aside>
  );
}
