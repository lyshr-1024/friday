import { conversationKey } from "../../memory/infer.js";
import { listInbox } from "../../memory/inbox.js";
import {
  fetchChannelRecent,
  fetchDmRecent,
  loadSlackCreds,
  slackCaller,
  slackSelfId,
  type SlackContextLine,
} from "../../connectors/slack.js";
import { attachedTasks } from "../slack/attach.js";
import { readMemoryFile } from "../../memory/files.js";

export interface SlackScene {
  conv: string;
  text: string;
  userName: string;
  channelName: string;
  taskId?: string;
  recent?: SlackContextLine[];
}

/** Slack 显示名常带英文后缀（「拂晓 (Chen Xiaofu)」），窗口标题里可能只剩中文名，两边都剥一次再比 */
const bareName = (s: string) => s.replace(/\s*[（(][^（）()]*[）)]\s*/g, "").trim();

/**
 * 搜索接口给的是账号名（jiacheng.zhou），而收件箱里存的是显示名（佳成 (Zhou Jiacheng)）。
 * 同一个人两种叫法，模型对不上。拿收件箱当花名册，把姓名倒过来拼就能认出来——纯本地查表，不多花一次调用。
 */
function displayNames(): Map<string, string> {
  const out = new Map<string, string>();
  const add = (name: string) => {
    const en = /[（(]([^（）()]+)[）)]\s*$/.exec(name)?.[1];
    if (!en) return;
    const parts = en.toLowerCase().split(/\s+/).filter(Boolean);
    if (parts.length < 2) return;
    out.set(`${parts.slice(1).join("")}.${parts[0]}`, name.trim());
  };
  for (const i of listInbox(true, 500)) add(i.userName);
  for (const m of readMemoryFile("people").matchAll(/^##\s+(.+?)\s*$/gm)) add(m[1]!);
  return out;
}

const prettyName = (raw: string, book: Map<string, string>) => book.get(raw.toLowerCase()) ?? raw;

/**
 * 首次呼出要扫一遍所有私聊认人（真机 37 个并发约 1.2 秒），加上拉原文刚好压在 2.5 秒上，
 * 实测会被砍掉导致「第一次呼出永远没有上下文」。认过的人有缓存，之后稳定在 1 秒内。
 */
const LIVE_TIMEOUT_MS = 4_000;

type Live = { channelId?: string; lines: SlackContextLine[] };

/**
 * 去 Slack 拉这段对话的原文。私聊和频道取数的接口不同（私聊只能 client.counts + history，
 * 频道在 Enterprise Grid 下只有 search 这条路通），但要的东西一样：屏幕上这段对话本身。
 */
async function liveConversation(channel?: string, person?: string): Promise<Live> {
  const creds = await loadSlackCreds();
  if (!creds) return { lines: [] };
  const call = slackCaller(creds);
  if (channel) return fetchChannelRecent(call, channel);
  if (!person) return { lines: [] };
  return fetchDmRecent(call, person, await slackSelfId(call));
}

/**
 * HUD 在 Slack 前台：按窗口标题解析出的频道或人名，找出你正在看的那段对话。
 *
 * 主语句一律用实时拉到的最后一条，不用收件箱里那条。收件箱是待办队列
 * （只存 @ 到我的、去过噪音的），跟「屏幕上这段对话」是两回事——拿它当主语句，
 * 就会出现你在看今天的催排期、Friday 却在总结三天前那条的错位。
 * 实时拉不到（没配凭证、接口超时）时才退回收件箱，保证至少有东西可说。
 */
export async function slackScene(channel?: string, person?: string): Promise<SlackScene | undefined> {
  if (!channel && !person) return undefined;

  const live: Live = await Promise.race<Live>([
    liveConversation(channel, person).catch(() => ({ lines: [] })),
    new Promise<Live>((r) => setTimeout(() => r({ lines: [] }), LIVE_TIMEOUT_MS)),
  ]);

  const book = live.lines.length ? displayNames() : new Map<string, string>();
  const lines = live.lines.map((l) => ({ ...l, userName: prettyName(l.userName, book) }));

  const want = channel?.replace(/^#/, "");
  const who = person ? bareName(person) : "";
  const hit = listInbox(true, 200)
    .filter((i) =>
      want
        ? i.kind === "mention" && i.channelName.replace(/^#/, "") === want
        : i.kind === "dm" && bareName(i.userName) === who,
    )
    .sort((a, b) => Number(b.ts) - Number(a.ts))[0];

  const last = lines.at(-1);
  if (last && live.channelId) {
    const conv = `${live.channelId}:${last.ts}`;
    const taskId = attachedTasks(conv)[0];
    return {
      conv,
      text: last.text,
      userName: last.userName,
      channelName: channel ? (channel.startsWith("#") ? channel : `#${channel}`) : (hit?.channelName ?? `与 ${person} 的私聊`),
      ...(taskId ? { taskId } : {}),
      recent: lines,
    };
  }

  if (!hit) return undefined;
  const conv = conversationKey(hit);
  const taskId = attachedTasks(conv)[0];
  return {
    conv,
    text: hit.text,
    userName: hit.userName,
    channelName: hit.channelName,
    ...(taskId ? { taskId } : {}),
    ...(lines.length ? { recent: lines } : {}),
  };
}
