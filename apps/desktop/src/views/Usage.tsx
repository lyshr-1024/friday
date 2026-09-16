import { useEffect, useRef, useState } from "react";
import { USAGE_LABELS, USAGE_RANGE_LABEL, type UsageRange, type UsageSummary } from "@friday/shared";
import { usage as fetchUsage } from "../lib/core";
import { Icon } from "./Icon";

const RANGES: UsageRange[] = ["today", "7d", "30d"];

/** 金额：不到一分钱就别写 $0.00，那看着像没花钱 */
function money(v: number): string {
  if (v <= 0) return "$0";
  if (v < 0.01) return "<$0.01";
  return `$${v.toFixed(2)}`;
}

function tokens(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1000) return `${Math.round(v / 1000)}k`;
  return String(v);
}

/**
 * 左栏底部的用量：收起时一行今天花了多少，展开看按调用点、按模型的明细。
 * 金额是 Claude Code 按 API 标价折算的估算，用来比较各处轻重，不是账单。
 */
export function UsageStrip() {
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState<UsageRange>("today");
  const [data, setData] = useState<UsageSummary | null>(null);
  const [today, setToday] = useState<UsageSummary | null>(null);
  const [err, setErr] = useState("");
  const box = useRef<HTMLDivElement>(null);

  // 收起时那行显示的永远是今天，展开后换档只影响面板
  useEffect(() => {
    let alive = true;
    const load = () => fetchUsage("today").then((d) => alive && setToday(d)).catch(() => {});
    void load();
    const timer = window.setInterval(load, 60_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setErr("");
    fetchUsage(range).then((d) => alive && setData(d)).catch((e) => alive && setErr(e instanceof Error ? e.message : String(e)));
    return () => { alive = false; };
  }, [open, range]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey, true); };
  }, [open]);

  const rows = (list: UsageSummary["byLabel"], name: (k: string) => string) =>
    list.length ? (
      <ul className="usage__list">
        {list.map((e) => (
          <li key={e.key}>
            <span className="usage__name">{name(e.key)}</span>
            <span className="usage__calls mono">{e.calls}</span>
            <span className="usage__cost mono">{money(e.costUsd)}</span>
          </li>
        ))}
      </ul>
    ) : (
      <div className="usage__empty">这段时间没有调用</div>
    );

  return (
    <div className="usage" ref={box}>
      <button className="usage__strip" onClick={() => setOpen((v) => !v)} aria-expanded={open} title="Friday 调用 Claude 的用量（按 API 标价折算）">
        <span className="usage__strip-label">今天</span>
        <span className="usage__strip-cost mono">{today ? money(today.total.costUsd) : "—"}</span>
        <span className="usage__strip-calls mono">{today ? `${today.total.calls} 次` : ""}</span>
        <Icon name={open ? "chevronDown" : "chevronRight"} />
      </button>

      {open && (
        <div className="usage__panel">
          <div className="seg usage__seg">
            {RANGES.map((r) => (
              <button key={r} className={`seg__item ${range === r ? "on" : ""}`} onClick={() => setRange(r)}>
                {USAGE_RANGE_LABEL[r]}
              </button>
            ))}
          </div>

          {err ? (
            <div className="usage__empty">{err}</div>
          ) : !data ? (
            <div className="usage__empty">正在统计…</div>
          ) : (
            <>
              <div className="usage__total">
                <span className="usage__total-cost mono">{money(data.total.costUsd)}</span>
                <span className="usage__total-sub mono">
                  {data.total.calls} 次 · 入 {tokens(data.total.inputTokens)} / 出 {tokens(data.total.outputTokens)}
                  {data.total.cacheRead > 0 ? ` · 缓存命中 ${tokens(data.total.cacheRead)}` : ""}
                </span>
              </div>
              <div className="usage__group">
                <div className="k">按调用点</div>
                {rows(data.byLabel, (k) => USAGE_LABELS[k] ?? k)}
              </div>
              <div className="usage__group">
                <div className="k">按模型</div>
                {rows(data.byModel, (k) => k.replace(/^claude-/, ""))}
              </div>
              <p className="usage__note">你走的是 Claude Code 订阅，这里按 API 标价折算，用来比较各处轻重，不是账单。派到终端的 Claude Code 不计在内。</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
