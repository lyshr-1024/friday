import type { Thread, ThreadBrief, Urgency } from "@friday/shared";
import { askStream } from "./claude.js";
import { UNTRUSTED_NOTE, untrusted } from "./fence.js";
import type { Enrichment } from "./enrich.js";
import { config } from "../config.js";
import { loadProjects } from "../memory/projects.js";
import { readPlaybook } from "../memory/playbooks.js";
import { recentEdited } from "../memory/lessons.js";
import { threadCategory } from "../memory/threads.js";
import { TRIAGE_MODEL } from "./triage.js";

const now = () => new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });

export function briefPrompt(
  thread: Thread,
  e: Enrichment,
  extra: { playbook?: string; examples?: Array<{ input: string; final: string }> } = {},
): { system: string; prompt: string } {
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
      "要求：situation 一句话说清谁、为什么找、和哪个工单/项目有关、现在卡在哪（不超过 60 字）；needs 一句话说用户需要做什么（不超过 40 字）；needsReply 是否需要用户本人回复；urgency high/normal/low；reply 如果需要回复，给一条 20 到 80 字、口语化、基于背景写的中文回复（把已查到的工单状态、进展直接写进去，不要客套）；actions 建议动作列表，type 取 reply / run_claude / todo / meegle / none，label 不超过 12 字，detail 一句话；context 列出你用到的背景要点（每条不超过 40 字）；如果这件事需要用户之后去做，给 todo（text 不超过 40 字，due 可选 YYYY-MM-DD）；如果对这个人有值得记住的新信息（角色、负责什么、常找你什么），给 person 一句话，否则省略。",
      registry ? `项目注册表：\n${registry}` : "",
      "找用户的消息常常是指代句（“你看看志华遗留的这个问题”“晚一点吧”），前面那段对话才说明是什么事——先读它再判断，situation 要写清具体指的是哪件事，不要复述指代句。",
      "再给 confidence（0-100 的整数）和 confidenceReason（一句话）：按背景是否查全、对方要什么是否明确、回复里有没有只有用户本人能定的承诺来自评。回复里出现工期、方案选型、人力安排这类承诺时，confidence 必须低于 60。",
      "context 只写查到的事实，不要写你自己的能力限制（比如“无权限读 thread”“没有搜索工具”），查不到就不提。",
      extra.playbook ? `这类消息的处理经验（你自己攒的，优先照它做）：\n${extra.playbook}` : "",
      // examples 的 input 是 Friday 自己起草的草稿（不是对方的原话，lessons 表没存原始消息），措辞必须说清这一点，
      // 不然模型会学到「对方说 X 就回 Y」这种错配的因果——这条链直接产出会被自动发出去的文本。
      extra.examples?.length
        ? `你以前是这么回的（左边是你起草的，右边是用户最终改成的话，照这个改法调整语气和详略）：\n${extra.examples.map((x) => `${untrusted("friday-brief", x.input)}\n→ ${x.final}`).join("\n\n")}`
        : "",
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
    const r = JSON.parse(json) as Partial<ThreadBrief> & { urgency?: string; actions?: Array<Partial<ThreadBrief["actions"][number]>>; confidence?: unknown; confidenceReason?: unknown };
    const urgency: Urgency = r.urgency === "high" || r.urgency === "low" ? r.urgency : "normal";
    return {
      situation: (r.situation ?? "").slice(0, 200),
      needs: (r.needs ?? "").slice(0, 120),
      needsReply: Boolean(r.needsReply),
      urgency,
      ...(r.reply ? { reply: String(r.reply).slice(0, 400) } : {}),
      actions: (r.actions ?? [])
        .filter((a) => a && a.label)
        .slice(0, 4)
        .map((a) => ({
          type: (["reply", "run_claude", "todo", "meegle", "none"] as const).includes(a.type as never) ? (a.type as ThreadBrief["actions"][number]["type"]) : "none",
          label: String(a.label).slice(0, 24),
          ...(a.detail ? { detail: String(a.detail).slice(0, 200) } : {}),
        })),
      context: (r.context ?? []).map((c) => String(c).slice(0, 120)).slice(0, 8),
      ...(r.todo?.text ? { todo: { text: String(r.todo.text).slice(0, 120), ...(r.todo.due && /^\d{4}-\d{2}-\d{2}$/.test(r.todo.due) ? { due: r.todo.due } : {}) } } : {}),
      ...(r.person ? { person: String(r.person).slice(0, 200) } : {}),
      confidence: typeof r.confidence === "number" && Number.isFinite(r.confidence) && r.confidence >= 0 && r.confidence <= 100 ? Math.round(r.confidence) : 0,
      confidenceReason: typeof r.confidenceReason === "string" ? r.confidenceReason.slice(0, 200) : "",
    };
  } catch {
    return undefined;
  }
}

export async function buildBrief(thread: Thread, e: Enrichment): Promise<ThreadBrief | undefined> {
  const category = threadCategory(thread);
  const playbook = readPlaybook(category);
  const examples = recentEdited(category, 3).map((l) => ({ input: l.draft ?? "", final: l.final ?? "" })).filter((x) => x.final);
  const { system, prompt } = briefPrompt(thread, e, { ...(playbook ? { playbook } : {}), ...(examples.length ? { examples } : {}) });
  let text = "";
  for await (const ev of askStream(prompt, { systemPrompt: system, cwd: config.dataDir, model: TRIAGE_MODEL })) {
    if (ev.type === "delta") text += ev.text;
    if (ev.type === "reset") text = "";
  }
  return parseBrief(text);
}
