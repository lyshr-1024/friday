import type { Thread } from "@friday/shared";
import { readMemoryFile } from "../../memory/files.js";
import { listThreads } from "../../memory/threads.js";

/** 频道名（"#wealth-fe"）或人名匹配这个线程。频道用频道名，私聊用对方人名。 */
export function threadMatches(thread: Thread, channel?: string, person?: string): boolean {
  if (channel) return thread.kind === "mention" && thread.channelName === channel.replace(/^#/, "");
  if (person) return thread.kind === "dm" && thread.userName === person;
  return false;
}

/** people.md 里某人的条目（"## 姓名" 到下一个 "## " 之前）。找不到返回 undefined。 */
export function personEntry(markdown: string, name: string): string | undefined {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${name}`);
  if (start < 0) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  const section = end < 0 ? rest : rest.slice(0, end);
  const body = section.find((l) => l.trim().length > 0);
  return body ? `${name}：${body.trim().replace(/^-\s*/, "")}` : undefined;
}

const hoursAgo = (ts: string): string => {
  const ms = Date.now() - Number(ts) * 1000;
  const h = Math.round(ms / 3_600_000);
  return h <= 0 ? "刚刚" : `${h} 小时前`;
};

/**
 * Slack 场景的一段上下文：这个频道/这个人最近找过我什么事，Friday 的判断，人物背景。
 * 频道和人二选一（窗口标题解析出的是哪种就传哪种）。查不到相关线程返回 undefined。
 */
export function slackContext(channel: string | undefined, person: string | undefined): string | undefined {
  if (!channel && !person) return undefined;
  const thread = listThreads("all", 200).find((t) => threadMatches(t, channel, person));
  if (!thread) return undefined;

  const lines = [`Slack：${channel ?? thread.userName}`];
  const last = thread.items[thread.items.length - 1];
  if (last) lines.push(`最近找你的：${last.userName} ${hoursAgo(last.ts)}「${last.text.slice(0, 80)}」`);
  if (thread.brief) {
    lines.push(`Friday 查到的：${thread.brief.situation}`);
  }
  const who = person ?? thread.userName;
  const entry = personEntry(readMemoryFile("people"), who);
  if (entry) lines.push(`人物：${entry}`);
  return lines.join("\n");
}
