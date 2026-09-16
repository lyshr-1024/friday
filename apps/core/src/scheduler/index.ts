import type { Notice } from "@friday/shared";
import { applyReversibleWrites } from "../agent/autowrite.js";
import { threadToTask } from "../agent/pipeline.js";
import { buildBrief } from "../agent/brief.js";
import { enrichThread, slackContext } from "../agent/enrich.js";
import { triage } from "../agent/triage.js";
import { syncMeegleOnce } from "../agent/meegle.js";
import { reviewDue, reviewOnce, REVIEW_KEY } from "../agent/lessons.js";
import { RAN_KEY, historyDue, learnHistoryOnce } from "../agent/handbook.js";
import { mapLimit } from "../connectors/exec.js";
import { attachToThread, closeSettledThreads, getThread, graceCandidate, setThreadBrief } from "../memory/threads.js";
import { CONTINUATION_MAX_MS, isContinuation } from "../agent/continuation.js";
import { fetchLastRead, fetchSlack, isRead, loadSlackCreds, postMessage, repliedSince, slackCaller, type SlackCreds } from "../connectors/slack.js";
import { addInboxItems, getCursor, setCursor, setSlackTeam, setTriage, sweepRepliedInbox } from "../memory/inbox.js";

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
          closeSettledThreads();
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

    if (added.length) {
      const result = await triage(added);
      added.forEach((it, i) => {
        const t = result.get(i + 1);
        if (t) setTriage(it.id, t);
      });
      // 逐条分类之后按人聚合成线程，对每个被触及的线程做功课、出情境卡、做可逆自动写。
      const touched = new Set<string>();
      for (const [i, it] of added.entries()) {
        const t = result.get(i + 1);
        const item = { ...it, ...(t ? { triage: t } : {}) };
        // 隔了两小时以上的，先问一句是不是在催同一件事，是就接回原线程而不是新起一条。
        // 两条消息常常都是指代句，所以把线程已有的情境和频道前文一起交给它判断。
        const candidate = graceCandidate(item, CONTINUATION_MAX_MS);
        const same = candidate
          ? await isContinuation(candidate.items, item, {
              ...(candidate.brief?.situation ? { situation: candidate.brief.situation } : {}),
              context: (await slackContext(item)).map((c) => `${c.userName}：${c.text}`),
            })
          : false;
        touched.add(attachToThread(item, Date.now(), { graceMs: CONTINUATION_MAX_MS, sameTopic: () => same }));
      }
      const needReply: string[] = [];
      await mapLimit([...touched], 3, async (id) => {
        const thread = getThread(id, true);
        if (!thread) return;
        try {
          const enrichment = await enrichThread(thread);
          const brief = await buildBrief(thread, enrichment);
          if (!brief) return;
          const task = await threadToTask(getThread(id, true)!, brief, enrichment.project?.name, {
            slackPost: (channel, text, threadTs) => postMessage(call, channel, text, threadTs),
          });
          const writes = applyReversibleWrites(thread, brief, task.id);
          setThreadBrief(id, { ...brief, context: [...brief.context, ...writes], ...(enrichment.context.length ? { priorMessages: enrichment.context } : {}) }, enrichment.project?.name);
          // Friday 已经自动回过（任务已 done）就不用再推「等你回」的通知，用户点开只会看到一件已经处理完的事。
          if (brief.needsReply && task.status !== "done") needReply.push(`${thread.userName}：${brief.situation}`);
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
  // 每天复盘一次你的人工处理，重写对应类别的经验手册（reviewDue 只看离上次跑过了多久）
  const reviewTick = async () => {
    if (reviewDue(getCursor(REVIEW_KEY))) await reviewOnce();
    setTimeout(reviewTick, LEARN_CHECK_MS).unref();
  };
  setTimeout(reviewTick, 20_000).unref();
  // 从 Claude Code 历史提炼项目手册，每周一轮（historyDue 只看离上次跑过了多久）
  const historyTick = async () => {
    if (historyDue(getCursor(RAN_KEY))) await learnHistoryOnce();
    setTimeout(historyTick, LEARN_CHECK_MS).unref();
  };
  setTimeout(historyTick, 40_000).unref();
}
