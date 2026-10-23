import { isFridayRun, NEED_LABEL, taskCategory, type MainNeeds, type Message, type NeedKind, type Task } from "@friday/shared";
import { publish, subscribe } from "../bus.js";
import { addMessage, listMessages } from "../memory/conversations.js";
import { getCursor, setCursor } from "../memory/inbox.js";
import { mainConversationId } from "../memory/mainConversation.js";
import { listOpenBoardTasks, tagOf, taskTag } from "../memory/tasks.js";
import { deliveryText } from "./delivery.js";
import { autostartEnv, autostartPlan } from "./autostart.js";
import { needOf } from "./needs.js";

export function noticeText(t: Task, need: NonNullable<ReturnType<typeof needOf>>): string {
  if (need.kind === "brief") return `${taskTag(t)} · 方案待审\n${need.reason}\n说「#${t.seq} 按这个做」开工，或说哪里要改。`;
  if (need.kind === "review") {
    const how = t.pending?.some((a) => a.type === "git_merge") ? `\n说「#${t.seq} 合并吧」收下，或说哪里不对。` : t.pending?.some((a) => a.type === "slack_reply") ? `\n说「#${t.seq} 发」发出去，或说怎么改。` : "";
    return `${taskTag(t)} · 待验收\n${deliveryText(t.report!, Boolean(t.source.headless))}${how}`;
  }
  const held = need.key.startsWith("decide:") && t.pending?.some((a) => a.type === "tool_call" && need.key === `decide:${a.id}`);
  return `${taskTag(t)} · 卡住\n${need.reason}${held ? `\n说「#${t.seq} 执行」放行，或说不要。` : ""}`;
}

/** 升级后第一次只记 key 不发，否则存量任务会一口气在主对话里刷出一排 */
export function postNotices(): number {
  const first = !getCursor("notice:init");
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
        payload: { need: need.kind, ...(shots?.length ? { attachments: shots } : {}) },
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

type Bucket = keyof MainNeeds;
const BUCKETS: Bucket[] = ["brief", "review", "blocked", "working", "queued"];
const KID_LABEL: Record<Bucket, string> = { brief: "方案待审", review: "修完待核验", blocked: "卡住", working: "在修", queued: "排队" };

/** 缺陷挂在列表里另一张开着的卡（需求 / 修复卡）下面：收进那一行，不单独占一行 */
function parentIn(tasks: Task[]): (t: Task) => string | undefined {
  const open = new Set(tasks.map((t) => t.id));
  const story = new Map<string, string>();
  for (const t of tasks) for (const m of [...(t.source.meegleId ? [t.source.meegleId] : []), ...(t.source.mergedMeegleIds ?? [])]) story.set(m, t.id);
  return (t) => {
    if (taskCategory(t.source) !== "defect") return undefined;
    const p = t.source.rootId && open.has(t.source.rootId) ? t.source.rootId : t.source.linkedStoryId ? story.get(t.source.linkedStoryId) : undefined;
    return p && p !== t.id ? p : undefined;
  };
}

export function mainNeeds(): MainNeeds {
  const out: MainNeeds = { brief: [], review: [], blocked: [], working: [], queued: [] };
  const env = autostartEnv();
  const tasks = listOpenBoardTasks();
  const bucketOf = (t: Task): { bucket: Bucket; reason?: string } | undefined => {
    const need = needOf(t);
    if (need) return { bucket: need.kind, reason: need.reason };
    if (t.status === "processing" && isFridayRun(t.source)) return { bucket: "working" };
    if (t.status === "understood" && autostartPlan(t, env)) return { bucket: "queued" };
    return undefined;
  };
  const parent = parentIn(tasks);
  const kids = new Map<string, Bucket[]>();
  for (const t of tasks) {
    const p = parent(t);
    const b = p && bucketOf(t)?.bucket;
    if (p && b) kids.set(p, [...(kids.get(p) ?? []), b]);
  }
  for (const t of tasks) {
    if (parent(t)) continue;
    const own = bucketOf(t);
    const under = kids.get(t.id) ?? [];
    const bucket = BUCKETS.find((b) => own?.bucket === b || under.includes(b));
    if (!bucket) continue;
    const summary = under.length ? `名下缺陷：${BUCKETS.filter((b) => under.includes(b)).map((b) => `${under.filter((x) => x === b).length} 条${KID_LABEL[b]}`).join("、")}` : "";
    const reason = [own?.reason, summary].filter(Boolean).join(" · ");
    out[bucket].push({ id: t.id, seq: t.seq, title: t.title, since: t.updatedAt, ...(reason ? { reason } : {}) });
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
      lines.push(`【${NEED_LABEL[kind]}】${tagOf(i.seq, i.title)} · ${cut(i.reason ?? "")}`);
    }
  }
  const doing = [...needs.working.map((i) => tagOf(i.seq, i.title)), ...needs.queued.map((i) => `${tagOf(i.seq, i.title)}（排队）`)];
  if (doing.length) lines.push(`还在干：${doing.join("，")}`);
  return [`离开这 ${minutes} 分钟，${n} 件要你：`, ...lines].join("\n");
}

export function presence(active: boolean, now = Date.now()): Message | undefined {
  if (!active) {
    if (!getCursor("main:away")) setCursor("main:away", String(now));
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
    payload: { digest: true },
    taskIds: NEED_ORDER.flatMap((k) => needs[k].map((i) => i.id)),
  });
  publish({ type: "conversation", id, running: false });
  return msg;
}

export function postMainNotice(content: string): void {
  addMessage(mainConversationId(), { role: "assistant", kind: "notice", content });
  publish({ type: "conversation", id: mainConversationId(), running: false });
}
