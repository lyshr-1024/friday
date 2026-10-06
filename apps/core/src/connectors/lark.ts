import { execFile } from "node:child_process";

/**
 * Lark 云文档正文，走本机 lark-cli（登录态归 CLI 管，Friday 不碰凭证），和 Meegle 连接器同一个模式。
 * 不走页面 DOM：Lark 文档是虚拟渲染，innerText 只有屏幕附近几块，还混着目录和评论栏。
 */
export interface LarkDoc {
  title: string;
  outline: string[];
  text: string;
  revision?: number;
}

export type LarkRunner = (args: string[], timeoutMs: number) => Promise<string>;

const defaultRunner: LarkRunner = (args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile("lark-cli", args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: process.env }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });

/** 验收文档一看一下午，同一篇反复呼出；缓存几分钟，第二次起正文零等待 */
const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; doc: LarkDoc }>();

export const resetLarkCache = () => cache.clear();

const cacheKey = (url: string) => url.replace(/[?#].*$/, "");

export async function fetchLarkDoc(url: string, opts: { timeoutMs?: number; run?: LarkRunner; now?: number } = {}): Promise<LarkDoc | undefined> {
  const now = opts.now ?? Date.now();
  const key = cacheKey(url);
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.doc;
  const run = opts.run ?? defaultRunner;
  let raw: string;
  try {
    raw = await run(["docs", "+fetch", "--doc", url, "--doc-format", "markdown"], opts.timeoutMs ?? 3_000);
  } catch (e) {
    console.error(`[lark] 拉文档失败：${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
  const doc = parseLarkFetch(raw);
  if (doc) cache.set(key, { at: now, doc });
  return doc;
}

export function parseLarkFetch(raw: string): LarkDoc | undefined {
  let content: string | undefined;
  let revision: number | undefined;
  try {
    const json = JSON.parse(raw) as { ok?: boolean; data?: { document?: { content?: string; revision_id?: number } } };
    content = json.data?.document?.content;
    revision = json.data?.document?.revision_id;
  } catch {
    return undefined;
  }
  if (!content) return undefined;
  const title = /<title>([^<]*)<\/title>/.exec(content)?.[1]?.trim() ?? "";
  const text = markdownToText(content.replace(/<title>[^<]*<\/title>/, ""));
  const outline = text
    .split("\n")
    .filter((l) => /^#{1,6}\s/.test(l))
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .filter(Boolean);
  return { title, outline, text, ...(revision !== undefined ? { revision } : {}) };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', nbsp: " ", "#34": '"', "#39": "'" };

/** HTML 表格压成一行一格、图片留 alt 描述（验收截图的描述就在那儿）、引用留标题，其余标签去掉 */
export function markdownToText(md: string): string {
  return md
    .replace(/<img\b[^>]*\balt="([^"]*)"[^>]*\/?>/g, (_m, alt: string) => ` [图：${alt.slice(0, 200)}] `)
    .replace(/<img\b[^>]*\/?>/g, " [图] ")
    .replace(/<cite\b[^>]*\btitle="([^"]*)"[^>]*>(?:<\/cite>)?/g, (_m, t: string) => ` [引用：${t}] `)
    .replace(/<\/(tr|li|p|div|h[1-6])>/g, "\n")
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<\/t[dh]>/g, " | ")
    .replace(/<\/?(del|s)>/g, "~")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#?\w+);/g, (m, e: string) => ENTITIES[e] ?? m)
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").replace(/(\s*\|\s*)+$/, "").trim())
    .filter((l, i, arr) => l || (i > 0 && arr[i - 1]))
    .join("\n")
    .trim();
}

/**
 * 给模型的节选：大纲全带（它要知道文档长什么样），正文给选中文字附近那一段，没选就给开头。
 * 整篇 80K 字塞进去既贵又慢，HUD 场景几千字够判断「这是什么、跟哪件事有关」。
 */
export function docExcerpt(doc: LarkDoc, selection?: string, max = 4000): string {
  const head = [doc.title ? `标题：${doc.title}` : "", doc.outline.length ? `大纲：${doc.outline.join(" / ")}` : ""].filter(Boolean).join("\n");
  const budget = Math.max(800, max - head.length);
  let body = "";
  const needle = selection?.trim().slice(0, 80);
  const at = needle ? doc.text.indexOf(needle) : -1;
  if (at >= 0) {
    const start = Math.max(0, at - Math.floor(budget / 3));
    body = `${start > 0 ? "…" : ""}${doc.text.slice(start, start + budget)}${start + budget < doc.text.length ? "…" : ""}`;
  } else {
    body = doc.text.length > budget ? `${doc.text.slice(0, budget)}…` : doc.text;
  }
  return [head, body].filter(Boolean).join("\n");
}
