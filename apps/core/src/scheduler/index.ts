import type { Notice } from "@friday/shared";
import { triage } from "../agent/triage.js";
import { fetchSlack, loadSlackCreds, slackCaller, type SlackCreds } from "../connectors/slack.js";
import { addInboxItems, getCursor, setCursor, setSlackTeam, setTriage } from "../memory/inbox.js";

/** 10:00–20:00（Asia/Shanghai）3 分钟一轮并通知；其余时段 15 分钟一轮只拉不通知。 */
export const ACTIVE_HOURS: [number, number] = [10, 20];
const ACTIVE_MS = 3 * 60_000;
const QUIET_MS = 15 * 60_000;

export function hourInShanghai(d = new Date()): number {
  return Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: "Asia/Shanghai" }).format(d)) % 24;
}

export function isActive(d = new Date()): boolean {
  const h = hourInShanghai(d);
  return h >= ACTIVE_HOURS[0] && h < ACTIVE_HOURS[1];
}

export function intervalMs(d = new Date()): number {
  return isActive(d) ? ACTIVE_MS : QUIET_MS;
}

export const state = {
  configured: false,
  lastSyncAt: null as string | null,
  lastError: null as string | null,
  notices: [] as Notice[],
  running: false,
};

let me = "";
let creds: SlackCreds | undefined;

export async function syncSlackOnce(): Promise<number> {
  if (state.running) return 0;
  state.running = true;
  try {
    creds ??= await loadSlackCreds();
    if (!creds) {
      state.configured = false;
      return 0;
    }
    state.configured = true;
    const call = slackCaller(creds);
    if (!me) {
      const auth = (await call("auth.test", {})) as { user_id?: string; team_id?: string };
      me = String(auth.user_id ?? "");
      if (auth.team_id) setSlackTeam(auth.team_id);
    }
    const keys = ["slack:mentions"];
    const cursors: Record<string, string | undefined> = Object.fromEntries(keys.map((k) => [k, getCursor(k)]));
    // 私聊游标按 channel 记，fetchSlack 里按需查；这里给它一个懒读取的代理。
    const proxy = new Proxy(cursors, { get: (t, k: string) => (k in t ? t[k] : getCursor(k)) });
    const { items, cursors: next } = await fetchSlack(call, me, proxy);
    const added = addInboxItems(items);
    for (const [k, v] of Object.entries(next)) setCursor(k, v);

    if (added.length) {
      const result = await triage(added);
      const needReply: string[] = [];
      added.forEach((it, i) => {
        const t = result.get(i + 1);
        if (!t) return;
        setTriage(it.id, t);
        if (t.needsReply) needReply.push(`${it.userName}：${t.summary}`);
      });
      if (needReply.length && isActive()) {
        state.notices.push({ title: `Slack ${needReply.length} 条待回复`, body: needReply.slice(0, 3).join("\n") });
      }
    }
    state.lastSyncAt = new Date().toISOString();
    state.lastError = null;
    return added.length;
  } catch (e) {
    state.lastError = e instanceof Error ? e.message : String(e);
    if (/invalid_auth|not_authed|token_revoked/.test(state.lastError)) creds = undefined;
    console.error(`[slack] ${state.lastError}`);
    return 0;
  } finally {
    state.running = false;
  }
}

export function drainNotices(): Notice[] {
  return state.notices.splice(0);
}

export function startScheduler(): void {
  const tick = async () => {
    await syncSlackOnce();
    setTimeout(tick, intervalMs()).unref();
  };
  setTimeout(tick, 5_000).unref();
}
