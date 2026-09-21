import { conversationKey } from "../../memory/infer.js";
import { listInbox } from "../../memory/inbox.js";
import { fetchChannelRecent, loadSlackCreds, slackCaller, type SlackContextLine } from "../../connectors/slack.js";
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

/** HUD 在 Slack 前台：按窗口标题解析出的频道或人名，找该处最近一段对话。 */
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
    // 「Zhou Jiacheng」→ 账号名是 jiacheng.zhou（名在前姓在后）
    out.set(`${parts.slice(1).join("")}.${parts[0]}`, name.trim());
  };
  for (const i of listInbox(true, 500)) add(i.userName);
  // 收件箱只认得 @ 过你的人；同组同事天天在群里说话却从没 @ 过你，得靠人物档案补上
  for (const m of readMemoryFile("people").matchAll(/^##\s+(.+?)\s*$/gm)) add(m[1]!);
  return out;
}

const prettyName = (raw: string, book: Map<string, string>) => book.get(raw.toLowerCase()) ?? raw;

// 呼出路径上用户在等，拉不回来就当没有
const LIVE_TIMEOUT_MS = 2_500;

type Live = { channelId?: string; lines: SlackContextLine[] };

async function liveChannel(channel: string): Promise<Live> {
  const creds = await loadSlackCreds();
  if (!creds) return { lines: [] };
  return fetchChannelRecent(slackCaller(creds), channel);
}

export async function slackScene(channel?: string, person?: string): Promise<SlackScene | undefined> {
  if (!channel && !person) return undefined;
  // 库里的频道名带 #（#proj-xxx），窗口标题里不带——两侧都剥一次再比，只剥一边等于永远对不上
  const want = channel?.replace(/^#/, "");
  const who = person ? bareName(person) : "";
  const hit = listInbox(true, 200)
    .filter((i) => (want ? i.kind === "mention" && i.channelName.replace(/^#/, "") === want : i.kind === "dm" && bareName(i.userName) === who))
    .sort((a, b) => Number(b.ts) - Number(a.ts))[0];

  // 私聊本来就在收件箱里，只有频道才需要实时补
  const live: Live = channel
    ? await Promise.race<Live>([
        liveChannel(channel).catch(() => ({ lines: [] })),
        new Promise<Live>((r) => setTimeout(() => r({ lines: [] }), LIVE_TIMEOUT_MS)),
      ])
    : { lines: [] };
  const book = live.lines.length ? displayNames() : new Map<string, string>();
  const lines = live.lines.map((l) => ({ ...l, userName: prettyName(l.userName, book) }));
  const recent = lines.length ? { recent: lines } : {};

  if (hit) {
    const conv = conversationKey(hit);
    const taskId = attachedTasks(conv)[0];
    return { conv, text: hit.text, userName: hit.userName, channelName: hit.channelName, ...(taskId ? { taskId } : {}), ...recent };
  }

  // 本地一条都没有：常驻的群从没 @ 过他，只靠实时消息也要能给出场景
  const last = lines.at(-1);
  if (!channel || !last || !live.channelId) return undefined;
  const conv = `${live.channelId}:${last.ts}`;
  const taskId = attachedTasks(conv)[0];
  return {
    conv,
    text: last.text,
    userName: last.userName,
    channelName: channel.startsWith("#") ? channel : `#${channel}`,
    ...(taskId ? { taskId } : {}),
    ...recent,
  };
}
