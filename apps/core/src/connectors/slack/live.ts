import type { ChatLine } from "../roles.js";
import { fetchChannelRecent, fetchDmRecent, loadSlackCreds, slackCaller, slackSelfId } from "./client.js";

/** Slack 显示名常带英文后缀（「拂晓 (Chen Xiaofu)」），窗口标题里可能只剩中文名，两边都剥一次再比 */
export const bareName = (s: string) => s.replace(/\s*[（(][^（）()]*[）)]\s*/g, "").trim();

export const prettyName = (raw: string, book: Map<string, string>) => book.get(raw.toLowerCase()) ?? raw;

export type Live = { channelId?: string; lines: ChatLine[]; me?: string };

/**
 * 去 Slack 拉这段对话的原文。私聊和频道取数的接口不同（私聊只能 client.counts + history，
 * 频道在 Enterprise Grid 下只有 search 这条路通），但要的东西一样：屏幕上这段对话本身。
 */
export async function liveConversation(channel?: string, person?: string): Promise<Live> {
  const creds = await loadSlackCreds();
  if (!creds) return { lines: [] };
  const call = slackCaller(creds);
  const me = await slackSelfId(call);
  if (channel) return { ...(await fetchChannelRecent(call, channel, me)), me };
  if (!person) return { lines: [] };
  return { ...(await fetchDmRecent(call, person, me)), me };
}

const MENTION = /<@([A-Z0-9]+)(?:\|[^>]*)?>/g;

export const mentionsMe = (text: string, me: string) => Boolean(me) && text.includes(`<@${me}>`);

/**
 * `<@U092UA21P6D>` 对模型是一串乱码：它分不清哪条 @ 的是我、哪条 @ 的是别人，
 * 实测把「@佳成 帮忙合一下」说成「有人在等你处理」。换成人名，我自己换成「我」。
 * 人名只从本地查：对话里出现过的人 + 收件箱花名册，都没有写「某人」，绝不显示 ID。
 */
export function renderMentions(text: string, names: Map<string, string>, me: string): string {
  return text.replace(MENTION, (_m, id: string) => `@${id === me ? "我" : (names.get(id) ?? "某人")}`);
}
