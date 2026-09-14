import type { InboxItem } from "@friday/shared";
import type { NewInboxItem } from "../memory/inbox.js";
import { keychainGet } from "./keychain.js";

export interface SlackCreds {
  token: string;
  cookie: string;
}

export async function loadSlackCreds(): Promise<SlackCreds | undefined> {
  const [token, cookie] = await Promise.all([keychainGet("friday-slack", "token"), keychainGet("friday-slack", "cookie")]);
  return token && cookie ? { token, cookie } : undefined;
}

type Call = (method: string, params: Record<string, string>) => Promise<Record<string, unknown>>;

export function slackCaller(creds: SlackCreds): Call {
  return async (method, params) => {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${creds.token}`,
        cookie: `d=${creds.cookie}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!json.ok) throw new Error(`Slack ${method} 失败：${String(json.error ?? res.status)}`);
    return json;
  };
}

interface SearchMatch {
  ts: string;
  text: string;
  user?: string;
  username?: string;
  permalink?: string;
  blocks?: Block[];
  thread_ts?: string;
  channel?: { id: string; name?: string; is_im?: boolean; is_mpim?: boolean };
}

interface Block {
  text?: { text?: string };
  fields?: Array<{ text?: string }>;
  elements?: Block[];
}

/** Block Kit 消息（机器人通知、工作流卡片）的正文在 blocks 里，text 是空的。 */
export function blocksText(blocks: Block[] | undefined): string {
  if (!blocks?.length) return "";
  const out: string[] = [];
  const walk = (bs: Block[]) => {
    for (const b of bs) {
      if (b.text?.text) out.push(b.text.text);
      for (const f of b.fields ?? []) if (f.text) out.push(f.text);
      if (b.elements) walk(b.elements);
    }
  };
  walk(blocks);
  return out.join("\n").trim();
}

interface CountsIm {
  id: string;
  user_id?: string;
  has_unreads?: boolean;
  latest?: string;
}

export interface SlackFetchResult {
  items: NewInboxItem[];
  cursors: Record<string, string>;
}

/**
 * 拉两类新消息：@ 我的（search.messages）和有未读的私聊（client.counts + conversations.history）。
 * cursors 是按来源记的最后 ts，只取更新的。
 */
const COLD_START_MS = 24 * 3600 * 1000;

/** chat.getPermalink 对部分私聊拿不到链接时，用团队域名手动拼一个官方格式的 permalink。 */
export function permalinkFor(teamUrl: string | undefined, channelId: string, ts: string): string {
  if (!teamUrl) return "";
  return `${teamUrl.replace(/\/$/, "")}/archives/${channelId}/p${ts.replace(".", "")}`;
}

export async function fetchSlack(
  call: Call,
  me: string,
  cursors: Record<string, string | undefined>,
  now = Date.now(),
  teamUrl?: string,
): Promise<SlackFetchResult> {
  const out: NewInboxItem[] = [];
  const next: Record<string, string> = {};
  const names = new Map<string, string>();
  // 没有游标（首次运行）时只看最近 24 小时，避免把早就处理过的老消息灌进收件箱。
  const floor = String((now - COLD_START_MS) / 1000);
  const since = (key: string) => cursors[key] ?? floor;

  const bots = new Map<string, boolean>();
  const isBot = async (id: string): Promise<boolean> => {
    const hit = bots.get(id);
    if (hit !== undefined) return hit;
    try {
      const res = (await call("users.info", { user: id })) as { user?: { is_bot?: boolean; real_name?: string; name?: string } };
      const bot = Boolean(res.user?.is_bot);
      bots.set(id, bot);
      if (res.user) names.set(id, res.user.real_name || res.user.name || id);
      return bot;
    } catch {
      return false;
    }
  };

  const userName = async (id: string): Promise<string> => {
    if (!id) return "未知";
    const hit = names.get(id);
    if (hit) return hit;
    try {
      const res = (await call("users.info", { user: id })) as { user?: { real_name?: string; name?: string } };
      const n = res.user?.real_name || res.user?.name || id;
      names.set(id, n);
      return n;
    } catch {
      return id;
    }
  };

  const mentionsSince = since("slack:mentions");
  const search = (await call("search.messages", { query: `<@${me}>`, sort: "timestamp", sort_dir: "desc", count: "20" })) as {
    messages?: { matches?: SearchMatch[] };
  };
  let maxMention = mentionsSince;
  for (const m of search.messages?.matches ?? []) {
    if (!m.channel || !m.ts || Number(m.ts) <= Number(mentionsSince) || m.user === me) continue;
    // 游标要跟着最新一条走，机器人那条也算，否则每次同步都会重新扫到它。
    if (Number(m.ts) > Number(maxMention)) maxMention = m.ts;
    // 和私聊一样，机器人（Meegle 工单通知、日历提醒等）@ 我的不进收件箱。
    if (m.user && (await isBot(m.user))) continue;
    out.push({
      id: `${m.channel.id}:${m.ts}`,
      kind: "mention",
      channelId: m.channel.id,
      channelName: m.channel.name ? `#${m.channel.name}` : "私聊",
      userId: m.user ?? "",
      userName: m.username || (await userName(m.user ?? "")),
      text: m.text?.trim() || blocksText(m.blocks),
      permalink: m.permalink ?? permalinkFor(teamUrl, m.channel.id, m.ts),
      // thread 里的回复：根 ts 留着，做功课时按它去拉整个 thread 的前文
      ...(m.thread_ts && m.thread_ts !== m.ts ? { threadTs: m.thread_ts } : {}),
      ts: m.ts,
    });
  }
  if (maxMention !== mentionsSince) next["slack:mentions"] = maxMention;

  const counts = (await call("client.counts", {})) as { ims?: CountsIm[] };
  for (const im of counts.ims ?? []) {
    if (!im.has_unreads) continue;
    const key = `slack:im:${im.id}`;
    const imSince = since(key);
    if (im.latest && Number(im.latest) <= Number(imSince)) continue;
    const hist = (await call("conversations.history", { channel: im.id, oldest: imSince, limit: "20" })) as {
      messages?: Array<{ ts: string; text?: string; user?: string; subtype?: string; bot_id?: string; blocks?: Block[]; thread_ts?: string }>;
    };
    let max = imSince;
    for (const msg of hist.messages ?? []) {
      // 机器人（Meegle、日历提醒等）的私聊不进收件箱，只要真人发的。
      if (msg.subtype || msg.bot_id || !msg.user || msg.user === me || Number(msg.ts) <= Number(imSince)) continue;
      if (await isBot(msg.user)) continue;
      if (Number(msg.ts) > Number(max)) max = msg.ts;
      const name = await userName(msg.user);
      const link = (await call("chat.getPermalink", { channel: im.id, message_ts: msg.ts }).catch(() => ({}))) as { permalink?: string };
      out.push({
        id: `${im.id}:${msg.ts}`,
        kind: "dm",
        channelId: im.id,
        channelName: `与 ${name} 的私聊`,
        userId: msg.user,
        userName: name,
        text: msg.text?.trim() || blocksText(msg.blocks),
        permalink: link.permalink ?? permalinkFor(teamUrl, im.id, msg.ts),
        ...(msg.thread_ts && msg.thread_ts !== msg.ts ? { threadTs: msg.thread_ts } : {}),
        ts: msg.ts,
      });
    }
    if (max !== imSince) next[key] = max;
  }

  out.sort((a, b) => Number(a.ts) - Number(b.ts));
  return { items: out, cursors: next };
}

/** 一条消息落在收件箱之前，它前面已经聊过的内容。 */
export interface SlackContextLine {
  ts: string;
  userName: string;
  text: string;
}

export const CONTEXT_LIMIT = 10;

/**
 * 取一条消息的对话上下文。
 * 收件箱里存的是「@ 到我的那一条」，往往是「你看看志华遗留的这个问题」这种指代句，
 * 光凭它判断不出要干什么——前文从来没被拉过，这里补上。
 * 在 thread 里就拉整个 thread，否则拉频道/私聊里它前面的若干条。
 */
export async function fetchContext(
  call: Call,
  item: Pick<InboxItem, "channelId" | "ts" | "threadTs">,
  resolveName: (id: string) => Promise<string>,
  limit = CONTEXT_LIMIT,
): Promise<SlackContextLine[]> {
  const raw: Array<{ ts: string; text?: string; user?: string; username?: string; bot_id?: string; subtype?: string }> = [];
  try {
    if (item.threadTs) {
      const res = (await call("conversations.replies", { channel: item.channelId, ts: item.threadTs, limit: String(limit + 1) })) as {
        messages?: typeof raw;
      };
      raw.push(...(res.messages ?? []));
    } else {
      // latest 是闭区间的上界，带上 inclusive 才包含这条消息本身，去掉后就是它前面的内容
      const res = (await call("conversations.history", { channel: item.channelId, latest: item.ts, limit: String(limit + 1), inclusive: "true" })) as {
        messages?: typeof raw;
      };
      raw.push(...(res.messages ?? []));
    }
  } catch {
    // 拉不到上下文不该让整条消息的处理失败，当作没有前文
    return [];
  }

  const lines: SlackContextLine[] = [];
  for (const m of raw) {
    if (!m.ts || m.ts === item.ts) continue;
    if (Number(m.ts) > Number(item.ts)) continue; // 只要它之前的
    // 入群退群、置顶这类系统消息不是对话，混进来会挤掉真正有用的前文
    if (m.subtype) continue;
    const text = (m.text ?? "").trim();
    if (!text) continue;
    lines.push({ ts: m.ts, userName: m.username ?? (m.user ? await resolveName(m.user) : m.bot_id ? "机器人" : "未知"), text });
  }
  lines.sort((a, b) => Number(a.ts) - Number(b.ts));
  return lines.slice(-limit);
}

/** 审核通过后才会调用：往频道或私聊发一条消息；@ 我的消息回在原 thread 里。 */
export async function postMessage(call: Call, channel: string, text: string, threadTs?: string): Promise<{ ts: string; permalink?: string }> {
  const res = (await call("chat.postMessage", { channel, text, ...(threadTs ? { thread_ts: threadTs } : {}) })) as { ts?: string };
  const ts = String(res.ts ?? "");
  const link = ts ? ((await call("chat.getPermalink", { channel, message_ts: ts }).catch(() => ({}))) as { permalink?: string }) : {};
  return { ts, ...(link.permalink ? { permalink: link.permalink } : {}) };
}
