import { SESSION_STATE_LABEL, isFridayRun } from "@friday/shared";
import type { SessionState, TrayItem, TrayStatus } from "@friday/shared";
import { taskBoard } from "../memory/tasks.js";
import { getTermSession } from "../memory/termSessions.js";
import { taskSession } from "./sessionState.js";
import { openTerminals } from "./terminal.js";

const NEEDS: SessionState[] = ["asking", "awaiting", "deciding", "blocked"];
const MAX_ITEMS = 8;

function waited(since: string | undefined, now: number): string {
  if (!since) return "";
  const m = Math.max(1, Math.round((now - Date.parse(since)) / 60000));
  return m < 60 ? `${m} 分钟` : m < 1440 ? `${Math.round(m / 60)} 小时` : `${Math.round(m / 1440)} 天`;
}

function line(state: SessionState, title: string, since: string | undefined, now: number): string {
  const w = waited(since, now);
  return `${SESSION_STATE_LABEL[state]} · ${title}${w ? `（${w}）` : ""}`;
}

export function trayStatus(now = Date.now()): TrayStatus {
  const open = taskBoard().tasks.filter((t) => t.status !== "done");
  const needs: (TrayItem & { since?: string })[] = [];
  for (const t of open) {
    const s = taskSession(t);
    if (!NEEDS.includes(s.state)) continue;
    const since = s.state === "deciding" ? s.waitingSince : s.state === "awaiting" ? s.lastStopAt : t.updatedAt;
    needs.push({ text: line(s.state, t.title, since, now), kind: s.state === "asking" ? "asking" : "waiting", taskId: t.id, since });
  }
  const terms = openTerminals();
  for (const term of terms) {
    if (term.where !== "project" || (term.state !== "asking" && term.state !== "awaiting")) continue;
    const since = term.state === "awaiting" ? getTermSession(term.sessionId)?.lastStopAt : undefined;
    needs.push({ text: line(term.state, term.label, since, now), kind: term.state === "asking" ? "asking" : "waiting", since });
  }
  // 在问你排最前，其余等得最久的在上面
  needs.sort((a, b) => (a.kind === b.kind ? (a.since ?? "").localeCompare(b.since ?? "") : a.kind === "asking" ? -1 : 1));
  const working = terms.some((t) => t.state === "working" || t.state === "preparing");
  const state = needs.some((n) => n.kind === "asking") ? "asking" : needs.length ? "waiting" : working ? "working" : "idle";
  const items: TrayItem[] = needs.slice(0, MAX_ITEMS).map(({ since: _, ...rest }) => rest);
  if (needs.length > MAX_ITEMS) items.push({ text: `还有 ${needs.length - MAX_ITEMS} 件…`, kind: "waiting" });
  const doing = open.filter((t) => t.status === "processing" && isFridayRun(t.source)).map((t) => ({ taskId: t.id, title: t.title }));
  return { state, count: needs.length, items, doing };
}
