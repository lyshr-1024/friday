import { Hono } from "hono";
import type { HotItem, HotResponse, HotSource } from "@friday/shared";
import { askStream } from "../agent/claude.js";
import { hotBrief } from "../agent/prompt.js";
import { config } from "../config.js";
import { SOURCES, fresh, type RawItem } from "../connectors/news.js";
import { finishSession, startSession } from "../memory/sessions.js";
import { userSettings } from "../settings.js";

const CACHE_MS = 60 * 60 * 1000;
let cache: HotResponse | undefined;

export async function buildHot(): Promise<HotResponse> {
  const sourceErrors: Partial<Record<HotSource, string>> = {};
  const collected = await Promise.all(
    SOURCES.map(async (s) => {
      try {
        return fresh(await s.fetch());
      } catch (e) {
        sourceErrors[s.source] = e instanceof Error ? e.message : String(e);
        return [];
      }
    }),
  );
  const seen = new Set<string>();
  const raw = collected.flat().filter((it) => !seen.has(it.url) && seen.add(it.url));

  const { system, prompt } = hotBrief(raw);
  const sessionId = startSession("hot", prompt);
  let text = "";
  const { model } = userSettings();
  for await (const ev of askStream(prompt, { systemPrompt: system, cwd: config.dataDir, ...(model ? { model } : {}) })) {
    if (ev.type === "delta") text += ev.text;
  }
  finishSession(sessionId, text);

  return { generatedAt: new Date().toISOString(), items: pick(raw, text), sourceErrors };
}

// Claude 只负责挑选和写中文标题/摘要，链接与来源按序号从原始列表回填，避免它编 URL。
export function pick(raw: RawItem[], text: string): HotItem[] {
  const json = /\[[\s\S]*\]/.exec(text)?.[0];
  let picked: Array<{ index: number; title: string; summary: string }> = [];
  try {
    picked = json ? (JSON.parse(json) as typeof picked) : [];
  } catch {
    picked = [];
  }
  const items = picked
    .map((p) => {
      const src = raw[p.index - 1];
      return src ? { title: p.title, summary: p.summary, url: src.url, source: src.source, publishedAt: src.publishedAt } : null;
    })
    .filter((x): x is HotItem => x !== null);
  if (items.length) return items;
  return raw.slice(0, 10).map((r) => ({ title: r.title, summary: r.snippet ?? "", url: r.url, source: r.source, publishedAt: r.publishedAt }));
}

export const hot = new Hono().get("/hot", async (c) => {
  const force = c.req.query("refresh") === "1";
  if (!force && cache && Date.now() - new Date(cache.generatedAt).getTime() < CACHE_MS) return c.json(cache);
  cache = await buildHot();
  return c.json(cache);
});
