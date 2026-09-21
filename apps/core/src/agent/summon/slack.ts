import { conversationKey } from "../../memory/infer.js";
import { listInbox } from "../../memory/inbox.js";
import { attachedTasks } from "../slack/attach.js";

export interface SlackScene {
  conv: string;
  text: string;
  userName: string;
  channelName: string;
  taskId?: string;
}

/** HUD 在 Slack 前台：按窗口标题解析出的频道或人名，找该处最近一段对话。 */
/** Slack 显示名常带英文后缀（「拂晓 (Chen Xiaofu)」），窗口标题里可能只剩中文名，两边都剥一次再比 */
const bareName = (s: string) => s.replace(/\s*[（(][^（）()]*[）)]\s*/g, "").trim();

export function slackScene(channel?: string, person?: string): SlackScene | undefined {
  if (!channel && !person) return undefined;
  // 库里的频道名带 #（#proj-xxx），窗口标题里不带——两侧都剥一次再比，只剥一边等于永远对不上
  const want = channel?.replace(/^#/, "");
  const who = person ? bareName(person) : "";
  const hit = listInbox(true, 200)
    .filter((i) => (want ? i.kind === "mention" && i.channelName.replace(/^#/, "") === want : i.kind === "dm" && bareName(i.userName) === who))
    .sort((a, b) => Number(b.ts) - Number(a.ts))[0];
  if (!hit) return undefined;
  const conv = conversationKey(hit);
  const taskId = attachedTasks(conv)[0];
  return { conv, text: hit.text, userName: hit.userName, channelName: hit.channelName, ...(taskId ? { taskId } : {}) };
}
