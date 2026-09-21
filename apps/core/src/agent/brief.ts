import type { Thread, ThreadBrief, Urgency } from "@friday/shared";
import { askStream } from "./claude.js";
import { UNTRUSTED_NOTE, untrusted } from "./fence.js";
import type { Enrichment } from "./enrich.js";
import { config } from "../config.js";
import { loadProjects } from "../memory/projects.js";
import { SONNET_MODEL } from "./claude.js";
import { readPlaybook } from "../memory/playbooks.js";
import { threadCategory } from "../memory/threads.js";

const now = () => new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });

export function briefPrompt(thread: Thread, e: Enrichment, playbook?: string): { system: string; prompt: string } {
  const registry = loadProjects()
    .map((p) => `- ${p.name}${p.aliases.length ? `（${p.aliases.join("、")}）` : ""}${p.channels.length ? ` ${p.channels.join(" ")}` : ""}${p.note ? ` — ${p.note}` : ""}`)
    .join("\n");
  const msgs = thread.items.map((i) => `[${new Date(Number(i.ts) * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai" })}] ${i.userName}：\n${untrusted("slack", i.text.slice(0, 1200))}`).join("\n");
  const before = e.context
    .map((c) => `[${new Date(Number(c.ts) * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai" })}] ${c.userName}：\n${untrusted("slack", c.text.slice(0, 600))}`)
    .join("\n");
  const ctx = [
    e.person ? `这个人：${untrusted("friday-brief", e.person)}` : "",
    e.history.length ? `之前和他的往来：\n${untrusted("friday-brief", e.history.map((h) => `- ${h}`).join("\n"))}` : "",
    e.links.length ? `消息里链接指向：\n${untrusted("meegle", e.links.map((l) => `- ${l}`).join("\n"))}` : "",
    e.project ? `相关项目 ${e.project.name}（${e.project.dir}）当前：${e.project.git}` : "",
  ].filter(Boolean);
  return {
    system: [
      "你是 Friday，用户的私人助理。用户是前端工程师。下面是一个人在 Slack 上找用户的一组消息，以及你已经查好的背景。请替用户把功课做完，输出一张情境卡。",
      "你的活是把事实摆清楚，不是替用户拿主意。situation 一句话说清谁、为什么找、和哪个工单/项目有关、现在卡在哪（不超过 60 字）；needs 一句话说对方要用户做什么（不超过 40 字，照抄诉求，保留原话里的关键词、报错、路径、工单号）；needsReply 是否需要用户本人回复；urgency high/normal/low；context 列出你用到的背景要点（每条不超过 40 字）；如果对这个人有值得记住的新信息（角色、负责什么、常找你什么），给 person 一句话，否则省略。",
      "不要起草回复，不要给行动建议，不要写改哪个文件、用什么方案、分几步。你只读到了这几条消息和一点前文，写出来的方案会把有完整上下文的人和终端带偏。用户看完你的卡自己决定怎么办。",
      registry ? `项目注册表：\n${registry}` : "",
      "找用户的消息常常是指代句（“你看看志华遗留的这个问题”“晚一点吧”），前面那段对话才说明是什么事——先读它再判断，situation 要写清具体指的是哪件事，不要复述指代句。",
      "context 只写查到的事实，不要写你自己的能力限制（比如“无权限读 thread”“没有搜索工具”），查不到就不提。",
      playbook ? `这类消息你自己攒的判断经验（优先照它做）：\n${playbook}` : "",
      UNTRUSTED_NOTE,
      "只输出一个 JSON 对象，不要其他文字。",
      `现在是 ${now()}。`,
    ]
      .filter(Boolean)
      .join("\n"),
    prompt: [
      before ? `这之前，${thread.channelName} 里聊的是：\n${before}\n` : "",
      `找用户的消息，来自 ${thread.userName}（${thread.channelName}）：\n${msgs}`,
      ctx.length ? `\n背景：\n${ctx.join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

export function parseBrief(text: string): ThreadBrief | undefined {
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  if (!json) return undefined;
  try {
    const r = JSON.parse(json) as Partial<ThreadBrief> & { urgency?: string };
    const urgency: Urgency = r.urgency === "high" || r.urgency === "low" ? r.urgency : "normal";
    return {
      situation: (r.situation ?? "").slice(0, 200),
      needs: (r.needs ?? "").slice(0, 120),
      needsReply: Boolean(r.needsReply),
      urgency,
      context: (r.context ?? []).map((c) => String(c).slice(0, 120)).slice(0, 8),
      ...(r.person ? { person: String(r.person).slice(0, 200) } : {}),
    };
  } catch {
    return undefined;
  }
}

export async function buildBrief(thread: Thread, e: Enrichment): Promise<ThreadBrief | undefined> {
  const { system, prompt } = briefPrompt(thread, e, readPlaybook(threadCategory(thread)) || undefined);
  let text = "";
  for await (const ev of askStream(prompt, { systemPrompt: system, cwd: config.dataDir, model: SONNET_MODEL, label: "brief" })) {
    if (ev.type === "delta") text += ev.text;
    if (ev.type === "reset") text = "";
  }
  return parseBrief(text);
}
