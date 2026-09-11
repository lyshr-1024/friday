import type { Notice } from "@friday/shared";
import { applyReversibleWrites } from "../agent/autowrite.js";
import { threadToTask } from "../agent/pipeline.js";
import { buildBrief } from "../agent/brief.js";
import { enrichThread } from "../agent/enrich.js";
import { triage } from "../agent/triage.js";
import { syncMeegleOnce } from "../agent/meegle.js";
import { learnDue, learnOnce, researchFiles } from "../agent/learn.js";
import { mapLimit } from "../connectors/exec.js";
import { attachToThread, getThread, setThreadBrief } from "../memory/threads.js";
import { fetchSlack, loadSlackCreds, slackCaller, type SlackCreds } from "../connectors/slack.js";
import { addInboxItems, getCursor, setCursor, setSlackTeam, setTriage } from "../memory/inbox.js";

/** 10:00–20:00（Asia/Shanghai）3 分钟一轮并通知；其余时段 15 分钟一轮只拉不通知。 */
export const ACTIVE_HOURS: [number, number] = [10, 20];
const ACTIVE_MS = 3 * 60_000;
const QUIET_MS = 15 * 60_000;
const MEEGLE_MS = 15 * 60_000;
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
    const keys = ["slack:mentions"];
    const cursors: Record<string, string | undefined> = Object.fromEntries(keys.map((k) => [k, getCursor(k)]));
    // 私聊游标按 channel 记，fetchSlack 里按需查；这里给它一个懒读取的代理。
    const proxy = new Proxy(cursors, { get: (t, k: string) => (k in t ? t[k] : getCursor(k)) });
    const { items, cursors: next } = await fetchSlack(call, me, proxy, Date.now(), getCursor("slack:url"));
    const added = addInboxItems(items);
    for (const [k, v] of Object.entries(next)) setCursor(k, v);

    if (added.length) {
      const result = await triage(added);
      added.forEach((it, i) => {
        const t = result.get(i + 1);
        if (t) setTriage(it.id, t);
      });
      // 逐条分类之后按人聚合成线程，对每个被触及的线程做功课、出情境卡、做可逆自动写。
      const touched = new Set(added.map((it) => attachToThread({ ...it, ...(result.get(added.indexOf(it) + 1) ? { triage: result.get(added.indexOf(it) + 1)! } : {}) })));
      const needReply: string[] = [];
      await mapLimit([...touched], 3, async (id) => {
        const thread = getThread(id);
        if (!thread) return;
        try {
          const enrichment = await enrichThread(thread);
          const brief = await buildBrief(thread, enrichment);
          if (!brief) return;
          const task = await threadToTask(getThread(id)!, brief, enrichment.project?.name);
          const writes = applyReversibleWrites(thread, brief, task.id);
          setThreadBrief(id, { ...brief, context: [...brief.context, ...writes] }, enrichment.project?.name);
          if (brief.needsReply) needReply.push(`${thread.userName}：${brief.situation}`);
        } catch (e) {
          console.error(`[thread] ${id} 做功课失败：${e instanceof Error ? e.message : String(e)}`);
        }
      });
      if (needReply.length && isActive()) {
        state.notices.push({ title: `Slack ${needReply.length} 个人等你回`, body: needReply.slice(0, 3).join("\n") });
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
  // 每半小时看一眼：过了 LEARN_HOUR 且今天还没有研究笔记就学一题（学不学由 learn 设置决定）
  const learnTick = async () => {
    if (learnDue(researchFiles())) await learnOnce();
    setTimeout(learnTick, LEARN_CHECK_MS).unref();
  };
  setTimeout(learnTick, 60_000).unref();
}
