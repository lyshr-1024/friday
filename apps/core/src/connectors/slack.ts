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
  channel?: { id: string; name?: string; is_im?: boolean; is_mpim?: boolean };
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

export async function fetchSlack(
  call: Call,
  me: string,
  cursors: Record<string, string | undefined>,
  now = Date.now(),
): Promise<SlackFetchResult> {
  const out: NewInboxItem[] = [];
  const next: Record<string, string> = {};
  const names = new Map<string, string>();
  // 没有游标（首次运行）时只看最近 24 小时，避免把早就处理过的老消息灌进收件箱。
  const floor = String((now - COLD_START_MS) / 1000);
  const since = (key: string) => cursors[key] ?? floor;

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
    if (Number(m.ts) > Number(maxMention)) maxMention = m.ts;
    out.push({
      id: `${m.channel.id}:${m.ts}`,
      kind: "mention",
      channelId: m.channel.id,
      channelName: m.channel.name ? `#${m.channel.name}` : "私聊",
      userId: m.user ?? "",
      userName: m.username ?? (await userName(m.user ?? "")),
      text: m.text,
      permalink: m.permalink ?? "",
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
      messages?: Array<{ ts: string; text?: string; user?: string; subtype?: string }>;
    };
    let max = imSince;
    for (const msg of hist.messages ?? []) {
      if (msg.subtype || !msg.user || msg.user === me || Number(msg.ts) <= Number(imSince)) continue;
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
        text: msg.text ?? "",
        permalink: link.permalink ?? "",
        ts: msg.ts,
      });
    }
    if (max !== imSince) next[key] = max;
  }

  out.sort((a, b) => Number(a.ts) - Number(b.ts));
  return { items: out, cursors: next };
}
