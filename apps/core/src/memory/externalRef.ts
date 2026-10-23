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
  ["reporter", "reporter"],
] as const;

/** 迁移后来源里不该再出现的老键 */
export const LEGACY_KEYS: string[] = [...WORK_KEYS, ...CHAT_KEYS, ...RENAMED.map(([old]) => old)];

/** merged[] 里还有老键（工单号叫 meegleId） */
export const hasLegacyMerged = (s: Raw): boolean => Array.isArray(s.merged) && (s.merged as Raw[]).some((m) => "meegleId" in m);

/** 启动迁移在外部引用迁移之前跑的 SQL 要认老 thread 行：老库里它们只有 threadId */
export const LEGACY_THREAD_ABSENT_SQL = "json_extract(source, '$.threadId') IS NULL";

function parentOf(r: Raw): ExternalRef["parent"] {
  const id = str(r.linkedStoryId);
  if (!id) return undefined;
  const name = str(r.linkedStoryName);
  return { id, ...(name ? { name } : {}) };
}

const stepOf = (r: Raw): ExternalRef["step"] => compact({ key: str(r.nodeKey), name: str(r.nodeName) });

const scheduleOf = (r: Raw): ExternalRef["schedule"] => compact({ frontend: str(r.feDue), backend: str(r.beDue) });

function workItemFromLegacy(r: Raw): ExternalRef | undefined {
  const id = str(r.meegleId);
  if (!id) return undefined;
  const typeKey = str(r.meegleType);
  const state = str(r.statusKey);
  const attrs = compact({ typeKey, ...Object.fromEntries(WORK_ATTRS.map(([k, a]) => [a, str(r[k])])) }) as Record<string, string> | undefined;
  const parent = parentOf(r);
  const schedule = scheduleOf(r);
  const step = stepOf(r);
  return {
    tool: "meegle",
    type: "work_item",
    id,
    kind: kindOf(typeKey),
    ...(state ? { state: { key: state } } : {}),
    ...(parent ? { parent } : {}),
    ...(schedule ? { schedule } : {}),
    ...(step ? { step } : {}),
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
  Array.isArray(docs) ? (docs as TaskDoc[]).map((d) => ((d.from as string) === "meegle" ? { ...d, from: "sync" } : d)) : undefined;

function migrateMerged(items: unknown): MergedItem[] | undefined {
  if (!Array.isArray(items)) return undefined;
  return (items as Array<Partial<MergedItem>>).map((m) => {
    const { meegleId, ...rest } = m as Partial<MergedItem> & { meegleId?: string };
    const docs = migrateDocs(m.docs);
    return { ...rest, id: (m.id ?? meegleId)!, ...(docs ? { docs } : {}) } as MergedItem;
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

/**
 * 老形状 → 新形状，老键一律剥掉。读取时（toTask）永久兜底：迁移前的老行、老快照、迁移失败的库都靠它；
 * 已有新键为准，幂等
 */
export function normalizeSource(raw: Raw): TaskSource {
  const s: Raw = { ...raw };
  if (!s.external) {
    const ext = workItemFromLegacy(raw) ?? conversationFromLegacy(raw);
    if (ext) s.external = ext;
  }
  for (const [old, neu] of RENAMED) if (s[neu] === undefined && raw[old] !== undefined) s[neu] = raw[old];
  migrateNested(s);
  for (const k of LEGACY_KEYS) delete s[k];
  return s as TaskSource;
}

export const EXTRA_CONVERSATION_WHY = "迁移：任务同时带工单号和对话键";

/** 老行同时带工单号和对话键时，external 只放得下工单，对话键另外建边 */
export function extraConversationOf(raw: Raw): string | undefined {
  return str(raw.meegleId) ? str(raw.conversation) : undefined;
}

const KINDS: Record<string, TaskKind> = { meegle: "work_item", slack: "conversation" };
export const migrateKind = (kind: string): TaskKind => KINDS[kind] ?? (kind as TaskKind);

export const migrateTrigger = (t: string): RunTrigger => (t === "slack" ? "chat" : (t as RunTrigger));

/** 老 slack_reply 的 payload 换成 { to, text }：发给谁只认 to，频道和 thread 在 to.attrs 里由工具解释 */
export function migratePending(list: PendingAction[]): PendingAction[] {
  return list.map((p) => {
    const type = p.type as string;
    if (type === "meegle_update") return { ...p, type: "custom" };
    if (type !== "slack_reply") return p;
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
    return { ...p, type: "chat_reply", payload: { to, text: pl.text ?? p.detail } };
  });
}
