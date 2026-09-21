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
export function slackScene(channel?: string, person?: string): SlackScene | undefined {
  if (!channel && !person) return undefined;
  const want = channel?.replace(/^#/, "");
  const hit = listInbox(true, 200)
    .filter((i) => (want ? i.kind === "mention" && i.channelName === want : i.kind === "dm" && i.userName === person))
    .sort((a, b) => Number(b.ts) - Number(a.ts))[0];
  if (!hit) return undefined;
  const conv = conversationKey(hit);
  const taskId = attachedTasks(conv)[0];
  return { conv, text: hit.text, userName: hit.userName, channelName: hit.channelName, ...(taskId ? { taskId } : {}) };
}
