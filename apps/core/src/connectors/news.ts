import type { HotSource } from "@friday/shared";
import { mapLimit } from "./exec.js";

export interface RawItem {
  title: string;
  url: string;
  source: HotSource;
  publishedAt: string;
  snippet?: string;
  score?: number;
}

const UA = "Friday/0.1 (+local personal assistant)";
const FRESH_MS = 48 * 3600 * 1000;

async function getJson<T>(url: string, timeoutMs = 8000): Promise<T> {
  const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json() as Promise<T>;
}

async function getText(url: string, timeoutMs = 8000): Promise<string> {
  const res = await fetch(url, { headers: { "user-agent": UA }, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.text();
}

const AI_WORDS =
  /\b(AI|LLMs?|GPT|Claude|OpenAI|Anthropic|Gemini|DeepSeek|Qwen|Llama|Mistral|models?|agents?|agentic|transformer|diffusion|RAG|MCP|inference|neural|machine learning|deep learning|copilot|prompt|token|GPU|CUDA|fine-?tun\w*)\b/i;

export async function hackerNews(): Promise<RawItem[]> {
  const ids = await getJson<number[]>("https://hacker-news.firebaseio.com/v0/topstories.json");
  const items = await mapLimit(ids.slice(0, 60), 10, (id) =>
    getJson<{ title?: string; url?: string; score?: number; time?: number; id: number }>(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).catch(() => null),
  );
  return items
    .filter((it): it is NonNullable<typeof it> => Boolean(it?.title && AI_WORDS.test(it.title)))
    .map((it) => ({
      title: it.title!,
      url: it.url ?? `https://news.ycombinator.com/item?id=${it.id}`,
      source: "hn" as const,
      publishedAt: new Date((it.time ?? 0) * 1000).toISOString(),
      score: it.score ?? 0,
    }))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 12);
}

export async function hfPapers(): Promise<RawItem[]> {
  const list = await getJson<Array<{ paper: { id: string; title: string; summary?: string; upvotes?: number }; publishedAt?: string }>>(
    "https://huggingface.co/api/daily_papers?limit=15",
  );
  return list.map((p) => ({
    title: p.paper.title,
    url: `https://huggingface.co/papers/${p.paper.id}`,
    source: "hf" as const,
    publishedAt: p.publishedAt ?? new Date().toISOString(),
    snippet: p.paper.summary?.slice(0, 300),
    score: p.paper.upvotes ?? 0,
  }));
}

// 极简 RSS / Atom 解析，只取标题、链接、时间、摘要，够用就行。
export function parseFeed(xml: string, source: HotSource, limit = 10): RawItem[] {
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/g) ?? [];
  const text = (b: string, tag: string) => {
    const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(b);
    return m ? decode(m[1]!) : "";
  };
  const link = (b: string) => {
    const atom = /<link\b[^>]*href="([^"]+)"/.exec(b);
    return atom ? atom[1]! : text(b, "link");
  };
  return blocks
    .map((b) => ({
      title: text(b, "title"),
      url: link(b),
      source,
      publishedAt: toIso(text(b, "pubDate") || text(b, "published") || text(b, "updated")),
      snippet: strip(text(b, "description") || text(b, "summary") || text(b, "content")).slice(0, 300),
    }))
    .filter((it) => it.title && it.url)
    .slice(0, limit);
}

const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
const strip = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const toIso = (s: string) => {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
};

const FEEDS: Array<{ source: HotSource; url: string }> = [
  { source: "openai", url: "https://openai.com/news/rss.xml" },
  { source: "simonw", url: "https://simonwillison.net/atom/everything/" },
  { source: "qbitai", url: "https://www.qbitai.com/feed" },
];

export const SOURCES: Array<{ source: HotSource; fetch: () => Promise<RawItem[]> }> = [
  { source: "hn", fetch: hackerNews },
  { source: "hf", fetch: hfPapers },
  ...FEEDS.map((f) => ({ source: f.source, fetch: async () => parseFeed(await getText(f.url), f.source) })),
];

export function fresh(items: RawItem[], now = Date.now()): RawItem[] {
  return items.filter((it) => now - new Date(it.publishedAt).getTime() < FRESH_MS);
}
