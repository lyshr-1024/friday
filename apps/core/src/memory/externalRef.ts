import type { Brief, ExternalRef, MergedItem, PendingAction, RunTrigger, TaskDoc, TaskKind, TaskSource } from "@friday/shared";
import { kindOf } from "../connectors/meegle/rules.js";

type Raw = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

function compact<T extends Record<string, unknown>>(o: T): Partial<T> | undefined {
  const out = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
  return Object.keys(out).length ? out : undefined;
}

const WORK_KEYS = ["meegleId", "meegleType", "statusKey", "meegleProject", "linkedStoryId", "linkedStoryName", "meegleTags", "feDue", "beDue", "nodeKey", "nodeName", "reporter"] as const;
const CHAT_KEYS = ["conversation", "channelId", "threadTs", "userName", "threadId"] as const;
const RENAMED = [
  ["mergedMeegleIds", "mergedIds"],
  ["storyContainer", "container"],
  ["meegleClosed", "closedExternally"],
] as const;
const WORK_ATTRS = [
  ["meegleProject", "space"],
  ["nodeKey", "nodeKey"],
  ["nodeName", "nodeName"],
  ["reporter", "reporter"],
] as const;

const WORK = new Set<string>(WORK_KEYS);
const CHAT = new Set<string>(CHAT_KEYS);

function parentOf(r: Raw): ExternalRef["parent"] {
  const id = str(r.linkedStoryId);
  if (!id) return undefined;
  const name = str(r.linkedStoryName);
  return { id, ...(name ? { name } : {}) };
}

const scheduleOf = (r: Raw): ExternalRef["schedule"] => compact({ frontend: str(r.feDue), backend: str(r.beDue) });

function workItemFromLegacy(r: Raw): ExternalRef | undefined {
  const id = str(r.meegleId);
  if (!id) return undefined;
  const typeKey = str(r.meegleType);
  const state = str(r.statusKey);
  const attrs = compact({ typeKey, ...Object.fromEntries(WORK_ATTRS.map(([k, a]) => [a, str(r[k])])) }) as Record<string, string> | undefined;
  const parent = parentOf(r);
  const schedule = scheduleOf(r);
  return {
    tool: "meegle",
    type: "work_item",
    id,
    kind: kindOf(typeKey),
    ...(state ? { state: { key: state } } : {}),
    ...(parent ? { parent } : {}),
    ...(schedule ? { schedule } : {}),
    ...(Array.isArray(r.meegleTags) ? { tags: r.meegleTags as string[] } : {}),
    ...(attrs ? { attrs } : {}),
  };
}

function conversationFromLegacy(r: Raw): ExternalRef | undefined {
  const conv = str(r.conversation);
  const thread = str(r.threadId);
  if (!conv && !thread) return undefined;
  const author = str(r.userName);
  const attrs = compact({ channelId: str(r.channelId), threadTs: str(r.threadTs), ...(conv ? {} : { legacy: "thread" }) }) as Record<string, string> | undefined;
  return { tool: "slack", type: "conversation", id: (conv ?? thread)!, ...(author ? { author } : {}), ...(attrs ? { attrs } : {}) };
}

const migrateDocs = (docs: unknown): TaskDoc[] | undefined =>
  Array.isArray(docs) ? (docs as TaskDoc[]).map((d) => (d.from === "meegle" ? { ...d, from: "sync" } : d)) : undefined;

function migrateMerged(items: unknown): MergedItem[] | undefined {
  if (!Array.isArray(items)) return undefined;
  return (items as Array<Partial<MergedItem>>).map((m) => {
    const id = (m.id ?? m.meegleId)!;
    const docs = migrateDocs(m.docs);
    return { ...m, id, meegleId: id, ...(docs ? { docs } : {}) } as MergedItem;
  });
}

const EVIDENCE: Record<string, "work_item" | "conversation"> = { meegle: "work_item", slack: "conversation" };

function migrateBrief(b: unknown): Brief | undefined {
  if (!b || typeof b !== "object" || !Array.isArray((b as Brief).deps)) return b as Brief | undefined;
  const brief = b as Brief;
  return {
    ...brief,
    deps: brief.deps.map((d) => {
      const to = d.evidence && EVIDENCE[d.evidence.source];
      return to ? { ...d, evidence: { ...d.evidence!, source: to } } : d;
    }),
  };
}

function migrateNested(s: Raw): void {
  if (s.docs !== undefined) s.docs = migrateDocs(s.docs);
  if (s.merged !== undefined) s.merged = migrateMerged(s.merged);
  if (s.brief !== undefined) s.brief = migrateBrief(s.brief);
}

/** 老形状 → 新形状：缺的新键从老键补，已有新键为准；迁移期间老键留着 */
export function normalizeSource(raw: Raw): TaskSource {
  const s: Raw = { ...raw };
  if (!s.external) {
    const ext = workItemFromLegacy(raw) ?? conversationFromLegacy(raw);
    if (ext) s.external = ext;
  }
  for (const [old, neu] of RENAMED) if (s[neu] === undefined && raw[old] !== undefined) s[neu] = raw[old];
  migrateNested(s);
  return s as TaskSource;
}

function legacyWork(e: ExternalRef): Raw {
  const a = e.attrs ?? {};
  return {
    meegleId: e.id,
    meegleType: a.typeKey ?? (e.kind === "story" ? "story" : e.kind === "defect" ? "issue" : undefined),
    statusKey: e.state?.key,
    linkedStoryId: e.parent?.id,
    linkedStoryName: e.parent?.name,
    meegleTags: e.tags,
    feDue: e.schedule?.frontend,
    beDue: e.schedule?.backend,
    ...Object.fromEntries(WORK_ATTRS.map(([k, attr]) => [k, a[attr]])),
  };
}

function legacyChat(e: ExternalRef): Raw {
  const a = e.attrs ?? {};
  const thread = a.legacy === "thread";
  return { conversation: thread ? undefined : e.id, threadId: thread ? e.id : undefined, channelId: a.channelId, threadTs: a.threadTs, userName: e.author };
}

const legacyOf = (e: ExternalRef): Raw => (e.type === "work_item" ? legacyWork(e) : legacyChat(e));

/** 新键 → 老键，给还没切到新字段的读者 */
export function legacyMirror(src: TaskSource): TaskSource {
  const s: Raw = { ...src };
  if (src.external) Object.assign(s, legacyOf(src.external));
  for (const [old, neu] of RENAMED) if (neu in s) s[old] = s[neu];
  if (s.merged !== undefined) s.merged = migrateMerged(s.merged);
  return s as TaskSource;
}

function patchWorkItem(s: Raw, touched: string[]): void {
  const ext = s.external as ExternalRef | undefined;
  if (!ext || ext.type !== "work_item" || touched.includes("meegleId")) {
    const fresh = workItemFromLegacy(s);
    if (fresh) s.external = { ...fresh, ...(ext?.type === "work_item" && ext.attrs ? { attrs: { ...ext.attrs, ...fresh.attrs } } : {}) };
    else if (ext?.type === "work_item") s.external = conversationFromLegacy(s);
    return;
  }
  const next: ExternalRef = { ...ext, attrs: { ...ext.attrs } };
  const set = <K extends keyof ExternalRef>(k: K, v: ExternalRef[K] | undefined) => {
    if (v === undefined) delete next[k];
    else next[k] = v;
  };
  const attr = (k: string, v: string | undefined) => {
    if (v === undefined) delete next.attrs![k];
    else next.attrs![k] = v;
  };
  for (const k of touched) {
    if (k === "meegleType") {
      next.kind = kindOf(str(s.meegleType));
      attr("typeKey", str(s.meegleType));
    } else if (k === "statusKey") set("state", str(s.statusKey) ? { key: str(s.statusKey)! } : undefined);
    else if (k === "linkedStoryId" || k === "linkedStoryName") set("parent", parentOf(s));
    else if (k === "meegleTags") set("tags", Array.isArray(s.meegleTags) ? (s.meegleTags as string[]) : undefined);
    else if (k === "feDue" || k === "beDue") set("schedule", scheduleOf(s));
    else {
      const a = WORK_ATTRS.find(([old]) => old === k);
      if (a) attr(a[1], str(s[k]));
    }
  }
  if (!Object.keys(next.attrs!).length) delete next.attrs;
  s.external = next;
}

function patchConversation(s: Raw, touched: string[]): void {
  const ext = s.external as ExternalRef | undefined;
  if (ext?.type === "work_item") return;
  if (!ext || touched.includes("conversation") || touched.includes("threadId")) {
    s.external = conversationFromLegacy(s);
    return;
  }
  const attrs = compact({ ...ext.attrs, channelId: str(s.channelId), threadTs: str(s.threadTs) }) as Record<string, string> | undefined;
  const author = str(s.userName);
  const { attrs: _a, author: _u, ...rest } = ext;
  s.external = { ...rest, ...(author ? { author } : {}), ...(attrs ? { attrs } : {}) };
}

/**
 * updateTask 合并完 source 之后两套键对齐：补丁里给的是哪套就以哪套为准、推出另一套；
 * 补丁没碰的键两边都不动（没切换的写入方改老键时不能被旧的新键盖回去）
 */
export function syncSourcePatch(cur: TaskSource, patch: Partial<TaskSource>): TaskSource {
  const s: Raw = { ...cur, ...patch };
  const keys = Object.keys(patch);
  if ("external" in patch) {
    const type = patch.external?.type ?? cur.external?.type;
    for (const k of type === "conversation" ? CHAT_KEYS : type === "work_item" ? WORK_KEYS : []) delete s[k];
    if (patch.external) Object.assign(s, legacyOf(patch.external));
  } else {
    const work = keys.filter((k) => WORK.has(k));
    if (work.length) patchWorkItem(s, work);
    const chat = keys.filter((k) => CHAT.has(k));
    if (chat.length) patchConversation(s, chat);
    if (s.external === undefined) delete s.external;
  }
  for (const [old, neu] of RENAMED) {
    if (neu in patch) s[old] = s[neu];
    else if (old in patch) s[neu] = s[old];
  }
  migrateNested(s);
  return s as TaskSource;
}

/** 老行同时带工单号和对话键时，external 只放得下工单，对话键另外建边 */
export function extraConversationOf(raw: Raw): string | undefined {
  return str(raw.meegleId) ? str(raw.conversation) : undefined;
}

export function stripLegacy(src: TaskSource): TaskSource {
  const s: Raw = { ...src };
  for (const k of [...WORK_KEYS, ...CHAT_KEYS, ...RENAMED.map(([old]) => old)]) delete s[k];
  if (Array.isArray(s.merged)) s.merged = (s.merged as MergedItem[]).map(({ meegleId: _m, ...m }) => m);
  return s as TaskSource;
}

const KINDS: Record<string, TaskKind> = { meegle: "work_item", slack: "conversation" };
export const migrateKind = (kind: string): TaskKind => KINDS[kind] ?? (kind as TaskKind);

export const migrateTrigger = (t: string): RunTrigger => (t === "slack" ? "chat" : (t as RunTrigger));

/** 迁移期间 chat_reply 的 payload 仍带老键（channel / threadTs / userName），没切换的执行方照样读得到 */
export function migratePending(list: PendingAction[]): PendingAction[] {
  return list.map((p) => {
    if (p.type === "meegle_update") return { ...p, type: "custom" };
    if (p.type !== "slack_reply") return p;
    const pl = p.payload as { channel?: string; threadTs?: string; userName?: string; text?: string };
    const channel = pl.channel ?? "";
    const attrs = compact({ channelId: channel || undefined, threadTs: pl.threadTs }) as Record<string, string> | undefined;
    const to: ExternalRef = {
      tool: "slack",
      type: "conversation",
      id: pl.threadTs ? `${channel}:${pl.threadTs}` : channel,
      ...(pl.userName ? { author: pl.userName } : {}),
      ...(attrs ? { attrs } : {}),
    };
    return { ...p, type: "chat_reply", payload: { ...p.payload, to } };
  });
}
