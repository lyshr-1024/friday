import type { InboxItem } from "@friday/shared";
import { askStream, SMALL_MODEL } from "../claude.js";
import { UNTRUSTED_NOTE, untrusted } from "../fence.js";
import { config } from "../../config.js";
import { loadProjects, type Project } from "../../memory/projects.js";

const QUESTION = /[?？]|怎么|哪里|哪儿|为什么|为啥|能不能|是不是|有没有/;

export function hasQuestionSignal(text: string): boolean {
  return QUESTION.test(text);
}

export function queryPrompt(item: InboxItem, prior: string[], projects: Project[]): { system: string; prompt: string } {
  return {
    system: [
      "判断一条 Slack 消息是不是「读代码就能回答」的问题：问某个功能在哪实现、为什么这样写、某个字段从哪来、能不能改成什么样。",
      "不是这类的：要你去改代码、催进度、约时间、要你做决定、闲聊、通知。这些答 false。",
      `再判断问的是哪个项目，只能从这些里选：${projects.map((p) => p.name).join("、") || "（注册表为空）"}。判不出就省略 project 字段，不要猜。`,
      UNTRUSTED_NOTE,
      '只输出 JSON，不要其他文字：{"codeAnswerable": true, "ask": "把问题写成一句完整的话", "project": "项目名"}',
    ].join("\n"),
    prompt: [
      prior.length ? `这之前聊的是：\n${prior.map((p) => `- ${p.slice(0, 200)}`).join("\n")}\n` : "",
      `${item.userName} 问：\n${untrusted("slack", item.text.slice(0, 800))}`,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

export function parseQuery(text: string, names: string[]): { ask: string; project?: string } | undefined {
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  if (!json) return undefined;
  try {
    const r = JSON.parse(json) as { codeAnswerable?: unknown; ask?: unknown; project?: unknown };
    if (r.codeAnswerable !== true) return undefined;
    const ask = typeof r.ask === "string" ? r.ask.trim().slice(0, 300) : "";
    if (!ask) return undefined;
    const project = typeof r.project === "string" && names.includes(r.project) ? r.project : undefined;
    return { ask, ...(project ? { project } : {}) };
  } catch {
    return undefined;
  }
}

/** 只对私聊和 @ 我、带疑问信号的消息跑。不是查询类返回 undefined。 */
export async function classifyQuery(item: InboxItem, prior: string[] = []): Promise<{ ask: string; project?: string } | undefined> {
  if (!hasQuestionSignal(item.text)) return undefined;
  const projects = loadProjects();
  const { system, prompt } = queryPrompt(item, prior, projects);
  let text = "";
  try {
    for await (const ev of askStream(prompt, { systemPrompt: system, cwd: config.dataDir, model: SMALL_MODEL, label: "query" })) {
      if (ev.type === "delta") text += ev.text;
      if (ev.type === "reset") text = "";
    }
  } catch {
    return undefined;
  }
  return parseQuery(text, projects.map((p) => p.name));
}
