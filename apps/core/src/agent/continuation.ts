import type { InboxItem } from "@friday/shared";
import { askStream } from "./claude.js";
import { config } from "../config.js";

export const CONTINUATION_MODEL = "claude-sonnet-5";

/** 超过这个跨度就不再算同一件事的催办，无论内容多像。 */
export const CONTINUATION_MAX_MS = 24 * 3600 * 1000;

export function continuationPrompt(previous: string[], incoming: string, opts: { situation?: string; context?: string[] } = {}): { system: string; prompt: string } {
  return {
    system: [
      "判断两段 Slack 消息是不是在说同一件事。同一个人、同一个频道，新消息比上一条晚了几个小时。",
      "常见情况是催办：同一件事隔几小时又提一次，说法不同但指向同一个诉求，这算同一件事。",
      "消息常常是指代句（“那个问题改了吗”“抽空弄一下”），本身看不出说的是什么——结合给出的前文和已知情境判断它指向哪件事。",
      "不同的需求、不同的页面、不同的活动、只是恰好用词相近的，都算两件事。",
      "拿不准就答 false——错误地合并会让两件事只剩一条待办，比拆开更糟。",
      '只输出 JSON，不要其他文字：{"same": true, "why": "一句话理由"}',
    ].join("\n"),
    prompt: [
      opts.context?.length ? `频道里更早的对话：\n${opts.context.map((c) => `- ${c.slice(0, 300)}`).join("\n")}\n` : "",
      opts.situation ? `已有线程说的是：${opts.situation.slice(0, 300)}\n` : "",
      "已有线程里的消息：",
      ...previous.map((t, i) => `${i + 1}. ${t.slice(0, 400)}`),
      "",
      `新来的消息：${incoming.slice(0, 400)}`,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

export function parseContinuation(text: string): boolean {
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  if (!json) return false;
  try {
    return (JSON.parse(json) as { same?: unknown }).same === true;
  } catch {
    return false;
  }
}

/**
 * 新消息是不是在催已有线程里那件事。判断不出就当不是。
 * 光看两条消息的字面常常判不出来（都是指代句），所以把线程已有的情境和频道前文一起给它。
 */
export async function isContinuation(
  previous: InboxItem[],
  incoming: InboxItem,
  opts: { situation?: string; context?: string[] } = {},
): Promise<boolean> {
  const texts = previous.map((i) => i.text.trim()).filter(Boolean);
  if ((!texts.length && !opts.situation) || !incoming.text.trim()) return false;
  const { system, prompt } = continuationPrompt(texts, incoming.text, opts);
  let text = "";
  try {
    for await (const ev of askStream(prompt, { systemPrompt: system, cwd: config.dataDir, model: CONTINUATION_MODEL })) {
      if (ev.type === "delta") text += ev.text;
      if (ev.type === "reset") text = "";
    }
  } catch {
    return false;
  }
  return parseContinuation(text);
}
