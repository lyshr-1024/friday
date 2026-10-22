import { isFridayRun, NEED_LABEL, type MainNeeds, type Message, type NeedKind, type Task } from "@friday/shared";
import { publish, subscribe } from "../bus.js";
import { addMessage, listMessages } from "../memory/conversations.js";
import { getCursor, setCursor } from "../memory/inbox.js";
import { mainConversationId } from "../memory/mainConversation.js";
import { listOpenBoardTasks, taskTag } from "../memory/tasks.js";
import { deliveryText } from "./delivery.js";
import { autostartEnv, autostartPlan } from "./autostart.js";
import { needOf } from "./needs.js";

export function noticeText(t: Task, need: NonNullable<ReturnType<typeof needOf>>): string {
  if (need.kind === "brief") return `${taskTag(t)} · 方案待审\n${need.reason}\n说「#${t.seq} 按这个做」开工，或说哪里要改。`;
  if (need.kind === "review") {
    const how = t.pending?.some((a) => a.type === "git_merge") ? `\n说「#${t.seq} 合并吧」收下，或说哪里不对。` : t.pending?.some((a) => a.type === "slack_reply") ? `\n说「#${t.seq} 发」发出去，或说怎么改。` : "";
    return `${taskTag(t)} · 待验收\n${deliveryText(t.report!, Boolean(t.source.headless))}${how}`;
  }
  return `${taskTag(t)} · 卡住\n${need.reason}`;
}

/** 升级后第一次只记 key 不发，否则存量任务会一口气在主对话里刷出一排 */
export function postNotices(): number {
  const first = getCursor("notice:init") === undefined || getCursor("notice:init") === "";
  let posted = 0;
  for (const t of listOpenBoardTasks()) {
    const need = needOf(t);
    const cursor = `notice:${t.id}`;
    const seen = getCursor(cursor) ?? "";
    if (!need) {
      if (seen) setCursor(cursor, "");
      continue;
    }
    if (need.key === seen) continue;
    if (!first) {
      const shots = need.kind === "review" ? t.report?.screenshots : undefined;
      addMessage(mainConversationId(), {
        role: "assistant",
        kind: "notice",
        content: noticeText(t, need),
        payload: shots?.length ? { attachments: shots } : undefined,
        taskIds: [t.id],
      });
      posted++;
    }
    setCursor(cursor, need.key);
  }
  if (first) setCursor("notice:init", "1");
  if (posted) publish({ type: "conversation", id: mainConversationId(), running: false });
  return posted;
}

export function startNoticeWatcher(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    postNotices();
  } catch (e) {
    console.error(`[notices] ${e instanceof Error ? e.message : e}`);
  }
  const off = subscribe((ev) => {
    if (ev.type !== "tasks" || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      try {
        postNotices();
      } catch (e) {
        console.error(`[notices] ${e instanceof Error ? e.message : e}`);
      }
    }, 500);
  });
  return () => {
    off();
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
}

const AWAY_MIN_MS = 15 * 60_000;
const NEED_ORDER: NeedKind[] = ["brief", "review", "blocked"];

export function mainNeeds(): MainNeeds {
  const out: MainNeeds = { brief: [], review: [], blocked: [], working: [], queued: [] };
  const env = autostartEnv();
  for (const t of listOpenBoardTasks()) {
    const item = { id: t.id, seq: t.seq, title: t.title, since: t.updatedAt };
    const need = needOf(t);
    if (need) out[need.kind].push({ ...item, reason: need.reason });
    else if (t.status === "processing" && isFridayRun(t.source)) out.working.push(item);
    else if (t.status === "understood" && autostartPlan(t, env)) out.queued.push(item);
  }
  return out;
}

const cut = (s: string) => (s.length > 60 ? s.slice(0, 60) + "…" : s);

function digestText(minutes: number, needs: MainNeeds): string {
  const lines: string[] = [];
  let n = 0;
  for (const kind of NEED_ORDER) {
    for (const i of needs[kind]) {
      n++;
      lines.push(`【${NEED_LABEL[kind]}】#${i.seq} ${i.title.slice(0, 30)} · ${cut(i.reason ?? "")}`);
    }
  }
  const doing = [...needs.working.map((i) => `#${i.seq} ${i.title.slice(0, 30)}`), ...needs.queued.map((i) => `#${i.seq} ${i.title.slice(0, 30)}（排队）`)];
  if (doing.length) lines.push(`还在干：${doing.join("，")}`);
  return [`离开这 ${minutes} 分钟，${n} 件要你：`, ...lines].join("\n");
}

export function presence(active: boolean, now = Date.now()): Message | undefined {
  if (!active) {
    setCursor("main:away", String(now));
    return undefined;
  }
  const away = Number(getCursor("main:away") || 0);
  if (!away) return undefined;
  setCursor("main:away", "");
  if (now - away < AWAY_MIN_MS) return undefined;
  const id = mainConversationId();
  if (!listMessages(id).some((m) => m.kind === "notice" && Date.parse(m.createdAt) > away)) return undefined;
  const needs = mainNeeds();
  if (!NEED_ORDER.some((k) => needs[k].length)) return undefined;
  const msg = addMessage(id, {
    role: "assistant",
    kind: "notice",
    content: digestText(Math.floor((now - away) / 60_000), needs),
    taskIds: NEED_ORDER.flatMap((k) => needs[k].map((i) => i.id)),
  });
  publish({ type: "conversation", id, running: false });
  return msg;
}
