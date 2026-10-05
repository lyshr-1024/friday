import { conversationKey, meegleIdsIn, slackNode, taskNode, urlsIn } from "../../memory/infer.js";
import { listInbox } from "../../memory/inbox.js";
import {
  fetchChannelRecent,
  fetchDmRecent,
  loadSlackCreds,
  slackCaller,
  slackSelfId,
  type SlackContextLine,
} from "../../connectors/slack.js";
import { normUrl } from "../docTitle.js";
import { attachedTasks } from "../slack/attach.js";
import { linkUp } from "../../memory/links.js";
import { listTasks } from "../../memory/tasks.js";
import { displayNames, userNames } from "../../memory/roster.js";

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

const prettyName = (raw: string, book: Map<string, string>) => book.get(raw.toLowerCase()) ?? raw;

/**
 * 首次呼出要扫一遍所有私聊认人（真机 37 个并发约 1.2 秒），加上拉原文刚好压在 2.5 秒上，
 * 实测会被砍掉导致「第一次呼出永远没有上下文」。认过的人有缓存，之后稳定在 1 秒内。
 */
const LIVE_TIMEOUT_MS = 4_000;

type Live = { channelId?: string; lines: SlackContextLine[]; me?: string };

/**
 * 去 Slack 拉这段对话的原文。私聊和频道取数的接口不同（私聊只能 client.counts + history，
 * 频道在 Enterprise Grid 下只有 search 这条路通），但要的东西一样：屏幕上这段对话本身。
 */
async function liveConversation(channel?: string, person?: string): Promise<Live> {
  const creds = await loadSlackCreds();
  if (!creds) return { lines: [] };
  const call = slackCaller(creds);
  const me = await slackSelfId(call);
  if (channel) return { ...(await fetchChannelRecent(call, channel, me)), me };
  if (!person) return { lines: [] };
  return { ...(await fetchDmRecent(call, person, me)), me };
}

const MENTION = /<@([A-Z0-9]+)(?:\|[^>]*)?>/g;

const mentionsMe = (text: string, me: string) => Boolean(me) && text.includes(`<@${me}>`);

/**
 * `<@U092UA21P6D>` 对模型是一串乱码：它分不清哪条 @ 的是我、哪条 @ 的是别人，
 * 实测把「@佳成 帮忙合一下」说成「有人在等你处理」。换成人名，我自己换成「我」。
 * 人名只从本地查：对话里出现过的人 + 收件箱花名册，都没有写「某人」，绝不显示 ID。
 */
function renderMentions(text: string, names: Map<string, string>, me: string): string {
  return text.replace(MENTION, (_m, id: string) => `@${id === me ? "我" : (names.get(id) ?? "某人")}`);
}


const OPEN = ["collected", "understood", "processing", "review", "blocked"] as const;

/**
 * 整段对话里提到过的 Meegle 工单号 → 对应任务，零模型调用。
 *
 * 收件箱那条挂靠链路（attachOnce）只在同步时跑，而私聊消息要入库得先满足「未读、
 * 非噪音、我还没回过」——你已经回过的对话根本不入库，于是 HUD 永远查不到挂靠。
 * 这里按屏幕上这段对话自己认一次：工单号是硬信号，比收件箱那条更全（它只有一条）。
 */
function attachByTicket(conv: string, lines: SlackContextLine[]): string | undefined {
  const ids = new Set(lines.flatMap((l) => meegleIdsIn(l.text)));
  // Slack 的链接是 <url|标题> 形式，urlsIn 取到的尾部会带 "|标题"，按分隔符切掉
  const urls = new Set(lines.flatMap((l) => urlsIn(l.text)).map((u) => u.split("|")[0]!.replace(/[>）)]+$/, "")));
  if (!ids.size && !urls.size) return undefined;

  const tasks = listTasks([...OPEN], 200);
  const byTicket = ids.size
    ? tasks.find((t) => (t.source.meegleId && ids.has(t.source.meegleId)) || (t.source.linkedStoryId && ids.has(t.source.linkedStoryId)))
    : undefined;
  if (byTicket) {
    linkUp(slackNode(conv), taskNode(byTicket.id), "rule", `这段对话里提到了工单 ${byTicket.source.meegleId ?? byTicket.source.linkedStoryId}`);
    return byTicket.id;
  }

  // 产品经理发的多是需求文档链接而不是工单号（实测频道里 16 条只有 1 条带工单号），
  // 而任务上本来就存着需求资料链接——同一篇文档就是同一件事。
  const normed = new Set([...urls].map(normUrl));
  for (const t of tasks) {
    const same = (t.source.docs ?? []).find((d) => normed.has(normUrl(d.url)));
    if (!same) continue;
    linkUp(slackNode(conv), taskNode(t.id), "rule", "这段对话里贴的就是这条任务的需求文档");
    return t.id;
  }
  return undefined;
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

  const me = live.me ?? "";
  const book = live.lines.length ? displayNames() : new Map<string, string>();
  const named = live.lines.map((l) => ({ ...l, userName: prettyName(l.userName, book) }));
  const names = live.lines.length ? userNames() : new Map<string, string>();
  for (const l of named) if (l.userId && l.userName !== "我") names.set(l.userId, l.userName);
  const lines = named.map((l) => ({ ...l, text: renderMentions(l.text, names, me) }));

  const want = channel?.replace(/^#/, "");
  const who = person ? bareName(person) : "";
  const hit = listInbox(true, 200)
    .filter((i) =>
      want
        ? i.kind === "mention" && i.channelName.replace(/^#/, "") === want
        : i.kind === "dm" && bareName(i.userName) === who,
    )
    .sort((a, b) => Number(b.ts) - Number(a.ts))[0];

  // 对话键锚在最后一条 @ 我的消息上：那才是「要我处理的事」，收件箱里存的也是它——
  // 锚在最后一条（往往是我自己的回话）会让「建成任务 / 帮我查」在收件箱里查不到对话。
  const anchorAt = live.lines.map((l) => mentionsMe(l.text, me)).lastIndexOf(true);
  const anchor = anchorAt >= 0 ? lines[anchorAt] : lines.at(-1);
  if (anchor && live.channelId) {
    const conv = `${live.channelId}:${anchor.threadTs ?? anchor.ts}`;
    const taskId = attachedTasks(conv)[0] ?? attachByTicket(conv, lines);
    return {
      conv,
      text: anchor.text,
      userName: anchor.userName,
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
