import type { InboxItem, Notice } from "@friday/shared";
import { attachOnce } from "../agent/slack/attach.js";
import { classifyQuery } from "../agent/slack/query.js";
import { startQueryJob } from "../agent/slack/queryJob.js";
import { settleQueryTasks } from "../agent/slack/settle.js";
import { syncMeegleOnce } from "../agent/meegle.js";
import { sweepClosedTerminals } from "../agent/terminal.js";
import { RAN_KEY, historyDue, learnHistoryOnce } from "../agent/handbook.js";
import { mapLimit } from "../connectors/exec.js";
import {
  fetchContext,
  fetchLastRead,
  fetchSlack,
  isRead,
  loadSlackCreds,
  repliedSince,
  slackCaller,
  type SlackCreds,
} from "../connectors/slack.js";
import { addInboxItems, getCursor, setCursor, setSlackTeam, sweepRepliedInbox } from "../memory/inbox.js";

/** 10:00–20:00（Asia/Shanghai）3 分钟一轮并通知；其余时段 15 分钟一轮只拉不通知。 */
export const ACTIVE_HOURS: [number, number] = [10, 20];
const ACTIVE_MS = 3 * 60_000;
const QUIET_MS = 15 * 60_000;
const MEEGLE_MS = 15 * 60_000;
const TERMINAL_SWEEP_MS = 60_000;
const LEARN_CHECK_MS = 30 * 60_000;

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
  nextSyncAt: null as string | null,
  lastError: null as string | null,
  notices: [] as Notice[],
  running: false,
};

let me = "";
let creds: SlackCreds | undefined;

// 挂靠和查询分类都要前文，拉一次两边共用
const priorCache = new Map<string, string[]>();

async function priorLines(call: ReturnType<typeof slackCaller>, item: InboxItem): Promise<string[]> {
  const hit = priorCache.get(item.id);
  if (hit) return hit;
  const lines = (await fetchContext(call, item, async (id) => id)).map((c) => `${c.userName}：${c.text}`);
  priorCache.set(item.id, lines);
  if (priorCache.size > 200) priorCache.clear();
  return lines;
}

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
      const auth = (await call("auth.test", {})) as { user_id?: string; team_id?: string; url?: string };
      me = String(auth.user_id ?? "");
      if (auth.team_id) setSlackTeam(auth.team_id);
      if (auth.url) setCursor("slack:url", auth.url);
    }
    // 每轮同步都扫一遍收件箱：我随时会直接在 Slack 里读掉或回掉，Friday 得跟着收，
    // 否则界面上一直挂着我已经处理完的事（这正是「回复了还是有待办」的由来）。
    if (me) {
      try {
        const lastRead = await fetchLastRead(call);
        const swept = await sweepRepliedInbox(async (item) =>
          isRead(item, lastRead, item.channelId) || (await repliedSince(call, me, item)),
        );
        if (swept) {
          console.log(`把 ${swept} 条我已在 Slack 读过或回过的消息标成已处理`);
          settleQueryTasks();
        }
      } catch (e) {
        console.error(`[slack] 收件箱对齐失败：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const keys = ["slack:mentions"];
    const cursors: Record<string, string | undefined> = Object.fromEntries(keys.map((k) => [k, getCursor(k)]));
    // 私聊游标按 channel 记，fetchSlack 里按需查；这里给它一个懒读取的代理。
    const proxy = new Proxy(cursors, { get: (t, k: string) => (k in t ? t[k] : getCursor(k)) });
    const { items, cursors: next } = await fetchSlack(call, me, proxy, Date.now(), getCursor("slack:url"));
    const added = addInboxItems(items);
    for (const [k, v] of Object.entries(next)) setCursor(k, v);

    for (const item of added) {
      try {
        await attachOnce(item, await priorLines(call, item));
      } catch (e) {
        console.error(`[slack] ${item.id} 挂靠失败：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // 只有私聊和 @ 我、且带疑问信号的，才值得花一次分类
    await mapLimit(added, 2, async (item) => {
      try {
        const q = await classifyQuery(item, await priorLines(call, item));
        if (q) await startQueryJob(item, q.ask, q.project);
      } catch (e) {
        console.error(`[slack] ${item.id} 查询判定失败：${e instanceof Error ? e.message : String(e)}`);
      }
    });
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
    const wait = intervalMs();
    state.nextSyncAt = new Date(Date.now() + wait).toISOString();
    setTimeout(tick, wait).unref();
  };
  state.nextSyncAt = new Date(Date.now() + 5_000).toISOString();
  setTimeout(tick, 5_000).unref();
  const meegleTick = async () => {
    await syncMeegleOnce();
    setTimeout(meegleTick, MEEGLE_MS).unref();
  };
  setTimeout(meegleTick, 8_000).unref();
  // 从 Claude Code 历史提炼项目手册，每周一轮（historyDue 只看离上次跑过了多久）
  const historyTick = async () => {
    if (historyDue(getCursor(RAN_KEY))) await learnHistoryOnce();
    setTimeout(historyTick, LEARN_CHECK_MS).unref();
  };
  setTimeout(historyTick, 40_000).unref();
  // 手动关掉的终端窗口没有回调，只能定时问一句。一分钟的滞后可以接受——
  // 工作台窗口聚焦时也会拉一次（POST /jobs/sweep），你回来看的那一眼是准的。
  const sweepTick = async () => {
    await sweepClosedTerminals().catch(() => []);
    setTimeout(sweepTick, TERMINAL_SWEEP_MS).unref();
  };
  setTimeout(sweepTick, 20_000).unref();
}
