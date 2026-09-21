import type { InboxItem, Task } from "@friday/shared";
import { askStream, SMALL_MODEL } from "../claude.js";
import { UNTRUSTED_NOTE, untrusted } from "../fence.js";
import { config } from "../../config.js";
import { channelNode, conversationKey, meegleIdsIn, slackNode, taskNode } from "../../memory/infer.js";
import { listInboxNear } from "../../memory/inbox.js";
import { linkUp, neighbors, rejected } from "../../memory/links.js";
import { listTasks } from "../../memory/tasks.js";
import { matchChannelTask } from "./channelMatch.js";

export interface AttachHit {
  taskId: string;
  why: string;
  /** 靠频道名字面对上的：调用方要顺手把频道也挂上，同频道后续消息直接查表 */
  byChannelName?: boolean;
}

/** 同一人同一频道近期挂过哪些任务。上层给实现，纯函数测试里给桩。 */
export type RecentLookup = (item: InboxItem) => Array<{ taskId: string; userName: string; hoursAgo: number }>;

/** 这个频道已经挂靠到哪些任务上。上层给实现，纯函数测试里给桩。 */
export type ChannelLookup = (channelName: string) => string[];

export const RECENT_MAX_HOURS = 48;

export function hardSignal(item: InboxItem, tasks: Task[], recent: RecentLookup, channelTasks: ChannelLookup): AttachHit | undefined {
  const byId = new Map(tasks.map((t) => [t.id, t]));

  for (const id of meegleIdsIn(item.text)) {
    const hit = tasks.find((t) => t.source.meegleId === id || t.source.linkedStoryId === id);
    if (hit) return { taskId: hit.id, why: `消息里提到了工单 ${id}` };
  }

  for (const r of recent(item)) {
    if (r.hoursAgo > RECENT_MAX_HOURS || !byId.has(r.taskId)) continue;
    return { taskId: r.taskId, why: `${r.userName} ${r.hoursAgo} 小时前在这个频道说的也是这条` };
  }

  for (const taskId of channelTasks(item.channelName)) {
    if (byId.has(taskId)) return { taskId, why: `#${item.channelName.replace(/^#/, "")} 这个频道对应的就是这条需求` };
  }
  const literal = matchChannelTask(item.channelName, tasks);
  return literal ? { ...literal, byChannelName: true } : undefined;
}

/** 候选：还没收工的任务，减去你说过「不是这条」的 */
export function candidateTasks(conv: string, tasks: Task[]): Task[] {
  const me = slackNode(conv);
  return tasks.filter((t) => !rejected(me, taskNode(t.id)));
}

/** 这段对话已经挂上的任务 */
export function attachedTasks(conv: string): string[] {
  return neighbors(slackNode(conv), "task").map((n) => n.ref);
}

const OPEN = ["collected", "understood", "processing", "review", "blocked"] as const;

export function attachPrompt(item: InboxItem, tasks: Task[], prior: string[]): { system: string; prompt: string } {
  return {
    system: [
      "判断一条 Slack 消息说的是不是下面某条任务的事。用户是前端工程师，这些任务是他手上在办的活。",
      "消息常常是指代句（「那个问题改了吗」「抽空弄一下」），本身看不出说的是什么，结合前文和任务标题判断。",
      "拿不准就答 none——挂错会让两件事混成一条，比不挂更糟。",
      UNTRUSTED_NOTE,
      '只输出 JSON，不要其他文字：{"taskId": "任务 id 或 none", "why": "一句话理由"}',
    ].join("\n"),
    prompt: [
      prior.length ? `这之前聊的是：\n${untrusted("slack", prior.map((p) => `- ${p.slice(0, 200)}`).join("\n"))}\n` : "",
      `${item.userName} 在 ${item.channelName} 说：\n${untrusted("slack", item.text.slice(0, 800))}`,
      "",
      "候选任务：",
      ...tasks.map((t) => `- ${t.id}：${t.title}${t.understanding ? ` —— ${t.understanding.slice(0, 80)}` : ""}`),
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

export function parseAttach(text: string, ids: string[]): string | undefined {
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  if (!json) return undefined;
  try {
    const id = (JSON.parse(json) as { taskId?: unknown }).taskId;
    return typeof id === "string" && ids.includes(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/** 同一人同一频道近期挂过的任务：查 links 里这个频道其它对话的邻居 */
function tasksOfChannel(channelName: string): string[] {
  return neighbors(channelNode(channelName), "task").map((n) => n.ref);
}

function recentInChannel(item: InboxItem): Array<{ taskId: string; userName: string; hoursAgo: number }> {
  const now = Number(item.ts) * 1000;
  return listInboxNear(item).flatMap((prev) =>
    attachedTasks(conversationKey(prev)).map((taskId) => ({
      taskId,
      userName: prev.userName,
      hoursAgo: Math.max(1, Math.round((now - Number(prev.ts) * 1000) / 3_600_000)),
    })),
  );
}

export async function attachOnce(item: InboxItem, prior: string[] = []): Promise<AttachHit | undefined> {
  const conv = conversationKey(item);
  const already = attachedTasks(conv);
  if (already.length) return { taskId: already[0]!, why: "这段对话已经挂过了" };

  const tasks = candidateTasks(conv, listTasks([...OPEN], 200));
  if (!tasks.length) return undefined;

  const hard = hardSignal(item, tasks, recentInChannel, tasksOfChannel);
  if (hard) {
    linkUp(slackNode(conv), taskNode(hard.taskId), "rule", hard.why);
    if (hard.byChannelName) linkUp(channelNode(item.channelName), taskNode(hard.taskId), "rule", hard.why);
    return hard;
  }

  const { system, prompt } = attachPrompt(item, tasks, prior);
  let text = "";
  try {
    for await (const ev of askStream(prompt, { systemPrompt: system, cwd: config.dataDir, model: SMALL_MODEL, label: "attach" })) {
      if (ev.type === "delta") text += ev.text;
      if (ev.type === "reset") text = "";
    }
  } catch {
    return undefined;
  }
  const id = parseAttach(text, tasks.map((t) => t.id));
  if (!id) return undefined;
  const why = "Friday 读消息推断的";
  linkUp(slackNode(conv), taskNode(id), "guess", why);
  return { taskId: id, why };
}
