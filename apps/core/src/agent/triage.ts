import type { InboxItem, Triage, Urgency } from "@friday/shared";
import { askStream } from "./claude.js";
import { config } from "../config.js";

const now = () => new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });

export function triagePrompt(items: InboxItem[]): { system: string; prompt: string } {
  return {
    system: [
      "你是 Friday，帮用户预处理 Slack 消息。用户是前端工程师，白天在公司。",
      "对每条消息判断：是否需要用户本人回复（needsReply）；紧急度 urgency 取 high / normal / low（high = 阻塞别人或线上问题，low = 群发通知、闲聊、已经被别人回答）；一句不超过 40 字的中文摘要 summary，写清楚谁要什么；如果需要回复，给一句 20 到 60 字、口语化、可以直接发出去的中文回复草稿 draft。",
      '只输出 JSON 数组，不要其他文字：[{"index": 序号, "needsReply": true, "urgency": "high", "summary": "…", "draft": "…"}]',
      `现在是 ${now()}。`,
    ].join("\n"),
    prompt: items
      .map((it, i) => `${i + 1}. [${it.kind === "dm" ? "私聊" : it.channelName}] ${it.userName}：${it.text.slice(0, 800)}`)
      .join("\n"),
  };
}

export function parseTriage(text: string, count: number): Map<number, Triage> {
  const json = /\[[\s\S]*\]/.exec(text)?.[0];
  const out = new Map<number, Triage>();
  if (!json) return out;
  try {
    for (const row of JSON.parse(json) as Array<{ index: number; needsReply?: boolean; urgency?: string; summary?: string; draft?: string }>) {
      if (!Number.isInteger(row.index) || row.index < 1 || row.index > count) continue;
      const urgency: Urgency = row.urgency === "high" || row.urgency === "low" ? row.urgency : "normal";
      out.set(row.index, {
        needsReply: Boolean(row.needsReply),
        urgency,
        summary: (row.summary ?? "").slice(0, 120),
        ...(row.draft ? { draft: row.draft.slice(0, 300) } : {}),
      });
    }
  } catch {
    /* 解析失败就当没有预处理结果 */
  }
  return out;
}

export const TRIAGE_MODEL = "claude-sonnet-5";

export async function triage(items: InboxItem[]): Promise<Map<number, Triage>> {
  if (!items.length) return new Map();
  const { system, prompt } = triagePrompt(items);
  let text = "";
  for await (const ev of askStream(prompt, { systemPrompt: system, cwd: config.dataDir, model: TRIAGE_MODEL })) {
    if (ev.type === "delta") text += ev.text;
    if (ev.type === "reset") text = "";
  }
  return parseTriage(text, items.length);
}
