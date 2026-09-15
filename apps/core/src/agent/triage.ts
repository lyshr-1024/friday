import type { InboxItem, Triage, Urgency, ReplyCategory } from "@friday/shared";
import { REPLY_CATEGORIES } from "@friday/shared";
import { askStream } from "./claude.js";
import { UNTRUSTED_NOTE, untrusted } from "./fence.js";
import { config } from "../config.js";
import { loadProjects, type Project } from "../memory/projects.js";

const now = () => new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });

export function triagePrompt(items: InboxItem[], projects: Project[] = loadProjects()): { system: string; prompt: string } {
  const registry = projects
    .map((p) => `- ${p.name}${p.aliases.length ? `（别名：${p.aliases.join("、")}）` : ""}${p.channels.length ? ` 频道：${p.channels.join(" ")}` : ""}${p.note ? ` — ${p.note}` : ""}`)
    .join("\n");
  return {
    system: [
      "你是 Friday，帮用户预处理 Slack 消息。用户是前端工程师，白天在公司。",
      "对每条消息判断：是否需要用户本人回复（needsReply）；紧急度 urgency 取 high / normal / low（high = 阻塞别人或线上问题，low = 群发通知、闲聊、已经被别人回答）；一句不超过 40 字的中文摘要 summary，写清楚谁要什么；如果需要回复，给一句 20 到 60 字、口语化、可以直接发出去的中文回复草稿 draft。",
      "再判断消息关联的项目 project：从下面的项目注册表里选一个名字（按频道、别名、内容关键词匹配），判断不出就省略该字段，不要猜。如果这条消息要用户去改代码、修 bug、调配置、查线上问题，再给一句 task：用中文写清楚要在该项目里做什么，可直接交给 Claude Code 执行，不超过 80 字；不是编码任务就省略 task。",
      registry ? `项目注册表：\n${registry}` : "项目注册表为空。",
      "再给一个类别 category：question=问你一件事、status_ask=问进度或问某事做完没、code_fix=要你改代码或修 bug、review_ask=要你看 PR/文档/设计、notice=通知或群发不用回、other=都不像。只能取这六个值之一。",
      UNTRUSTED_NOTE,
      '只输出 JSON 数组，不要其他文字：[{"index": 序号, "needsReply": true, "urgency": "high", "summary": "…", "draft": "…", "project": "whale-console", "task": "…", "category": "code_fix"}]',
      `现在是 ${now()}。`,
    ].join("\n"),
    prompt: items
      .map((it, i) => `${i + 1}. [${it.kind === "dm" ? "私聊" : it.channelName}] ${it.userName}：\n${untrusted("slack", it.text.slice(0, 800))}`)
      .join("\n"),
  };
}

export function parseTriage(text: string, count: number): Map<number, Triage> {
  const json = /\[[\s\S]*\]/.exec(text)?.[0];
  const out = new Map<number, Triage>();
  if (!json) return out;
  try {
    for (const row of JSON.parse(json) as Array<{ index: number; needsReply?: boolean; urgency?: string; summary?: string; draft?: string; project?: string | null; task?: string | null; category?: string }>) {
      if (!Number.isInteger(row.index) || row.index < 1 || row.index > count) continue;
      const urgency: Urgency = row.urgency === "high" || row.urgency === "low" ? row.urgency : "normal";
      const category: ReplyCategory = REPLY_CATEGORIES.includes(row.category as ReplyCategory) ? (row.category as ReplyCategory) : "other";
      out.set(row.index, {
        needsReply: Boolean(row.needsReply),
        urgency,
        summary: (row.summary ?? "").slice(0, 120),
        ...(row.draft ? { draft: row.draft.slice(0, 300) } : {}),
        ...(row.project ? { project: row.project.slice(0, 80) } : {}),
        ...(row.task ? { task: row.task.slice(0, 300) } : {}),
        category,
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
