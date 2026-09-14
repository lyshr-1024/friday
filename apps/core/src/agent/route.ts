import type { ConversationSummary } from "@friday/shared";
import { askStream } from "./claude.js";
import { runningIds } from "./runs.js";
import { config } from "../config.js";
import { listConversations } from "../memory/conversations.js";
import { loadProjects, type Project } from "../memory/projects.js";

export interface Route {
  conversationId?: string;
  title?: string;
  why: string;
}

// 只是从二十来个标题里选一个序号，Haiku 够用；接错了用户还有「其实是新话题」可点
export const ROUTE_MODEL = "claude-haiku-4-5";
const CANDIDATES = 20;

function ago(iso: string): string {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 60) return `${Math.max(1, m)} 分钟前`;
  if (m < 60 * 24) return `${Math.round(m / 60)} 小时前`;
  return `${Math.round(m / 60 / 24)} 天前`;
}

/** 候选：最近有内容、没在生成中的会话。生成中的接不上（/ask 会 409）。 */
export function routeCandidates(convs: ConversationSummary[], running: string[] = runningIds()): ConversationSummary[] {
  const busy = new Set(running);
  return convs.filter((c) => c.messageCount > 0 && !busy.has(c.id)).slice(0, CANDIDATES);
}

export function routePrompt(text: string, convs: ConversationSummary[], projects: Project[]): { system: string; prompt: string } {
  const registry = projects.map((p) => `- ${p.name}${p.aliases.length ? `（别名：${p.aliases.join("、")}）` : ""}`).join("\n");
  return {
    system: [
      "你是 Friday 的会话路由。用户刚说了一句话，判断它是接着之前哪段对话说的，还是一个新话题。",
      "规则偏保守：只有这句话明显在接着说——用了“那个”“刚才”“上次”“继续”这类指代，或者和某段对话的标题几乎是同一件事——才选那段对话；同一个项目的另一件事、只是话题相近，都算新话题。拿不准就选新话题，接错比新开代价大。",
      registry ? `项目注册表（帮你对上项目名和别名）：\n${registry}` : "",
      '只输出一个 JSON 对象，不要其他文字：{"index": 序号或 0, "why": "不超过 30 字的中文理由"}。0 表示新话题。',
    ]
      .filter(Boolean)
      .join("\n"),
    prompt: [
      `用户这句话：${text.slice(0, 600)}`,
      "",
      convs.length ? "最近的对话：" : "最近没有对话。",
      ...convs.map((c, i) => `${i + 1}. ${c.title.slice(0, 60)}（${ago(c.updatedAt)}，${c.messageCount} 条）`),
    ].join("\n"),
  };
}

export function parseRoute(text: string, convs: ConversationSummary[]): Route {
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  if (!json) return { why: "新话题" };
  try {
    const row = JSON.parse(json) as { index?: unknown; why?: unknown };
    const why = typeof row.why === "string" ? row.why.slice(0, 60) : "";
    const i = typeof row.index === "number" ? row.index : 0;
    const hit = Number.isInteger(i) && i >= 1 && i <= convs.length ? convs[i - 1] : undefined;
    return hit ? { conversationId: hit.id, title: hit.title, why: why || "接着之前的对话" } : { why: why || "新话题" };
  } catch {
    return { why: "新话题" };
  }
}

export async function route(text: string): Promise<Route> {
  const convs = routeCandidates(listConversations(CANDIDATES * 2));
  if (!convs.length) return { why: "还没有历史对话" };
  const { system, prompt } = routePrompt(text, convs, loadProjects());
  let out = "";
  for await (const ev of askStream(prompt, { systemPrompt: system, cwd: config.dataDir, model: ROUTE_MODEL })) {
    if (ev.type === "delta") out += ev.text;
    if (ev.type === "reset") out = "";
  }
  return parseRoute(out, convs);
}
