import { execFile } from "node:child_process";
import { chromeCookies } from "./chromeCookies.js";

// 一律走 agent-browser 而不是 fetch：内网页面要登录（VibeClub 直接 401），SPA 要跑完 JS 才有正文。
// 登录态每次现从你的 Chrome 取（chromeCookies），不另开 profile 让你重新登录。
const SESSION = "friday-web";
const MAX_CHARS = 100_000;
// 可见正文短于这个数，内容多半在脚本数据里（SPA 按路由渲染，没显示的章节不在 DOM 里）
const THIN_TEXT = 8_000;
const MAX_FRAMES = 3;
const EXTRACT =
  "({url: location.href, title: document.title, text: document.body ? document.body.innerText : '', frames: [...document.querySelectorAll('iframe')].map((f) => f.src).filter((s) => /^https?:/.test(s)), scripts: [...document.scripts].filter((s) => !s.src).map((s) => s.textContent)})";

export interface Page {
  url: string;
  title: string;
  text: string;
}

export type ReadResult = ({ kind: "page"; truncated: boolean } & Page) | { kind: "login"; url: string };

interface AbReply {
  success: boolean;
  data?: { result?: unknown };
  error?: string | null;
}

function ab(args: string[], timeout = 45_000): Promise<AbReply["data"]> {
  // 启动参数每条命令都要一样，否则 agent-browser 当成新配置重启浏览器
  const flags = ["--session", SESSION, "--idle-timeout", "2m", "--json"];
  return new Promise((resolve, reject) => {
    execFile("agent-browser", [...flags, ...args], { timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") return reject(new Error("没装 agent-browser，读不了网页：npm i -g agent-browser"));
      let reply: AbReply;
      try {
        reply = JSON.parse(stdout) as AbReply;
      } catch {
        return reject(new Error(err ? `agent-browser 失败：${err.message}` : `agent-browser 输出解析不了：${stdout.slice(0, 200)}`));
      }
      if (!reply.success) return reject(new Error(`agent-browser 失败：${reply.error ?? "未知错误"}`));
      resolve(reply.data);
    });
  });
}

let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

const DENIED = /\b(401|403)\b|unauthori[sz]ed|access (restricted|denied)|forbidden|sign ?in|log ?in|登录|无权/i;
const LOGIN_PATH = /login|signin|sign_in|\bsso\b|oauth|openid|\bauth\b/i;

/** 读到的是登录页 / 无权页，而不是正文。拿不准就当正文 */
export function needsLogin(requested: string, page: Page): boolean {
  const from = new URL(requested);
  const to = new URL(page.url);
  if (to.host !== from.host && (to.host.startsWith("accounts.") || LOGIN_PATH.test(to.host + to.pathname))) return true;
  if (to.host === from.host && LOGIN_PATH.test(to.pathname) && !LOGIN_PATH.test(from.pathname)) return true;
  return page.text.trim().length < 800 && DENIED.test(`${page.title}\n${page.text}`);
}

const injected = new Set<string>();
async function injectCookies(url: string): Promise<void> {
  const host = new URL(url).hostname;
  if (injected.has(host)) return;
  for (const c of await chromeCookies(url)) {
    // host-only 的 Cookie 用 --url 设，带点的才用 --domain，否则 Chrome 会把它变成整个域都带
    const where = c.domain.startsWith(".") ? ["--domain", c.domain] : ["--url", `https://${c.domain}${c.path}`];
    const flags = [...(c.httpOnly ? ["--httpOnly"] : []), ...(c.secure ? ["--secure"] : []), ...(c.sameSite ? ["--sameSite", c.sameSite] : []), ...(c.expires > 0 ? ["--expires", String(c.expires)] : [])];
    await ab(["cookies", "set", c.name, c.value, ...where, "--path", c.path, ...flags]);
  }
  injected.add(host);
}

type Loaded = Page & { frames: string[]; scripts: string[] };

/** 可见正文 + 正文太短时补上内联脚本（VibeClub 的精读页 9 章内容都在脚本里，只渲染当前一章） */
function content(p: Loaded): string {
  const text = p.text.trim();
  if (text.length >= THIN_TEXT) return text;
  const data = p.scripts.map((s) => s.trim()).filter(Boolean).sort((a, b) => b.length - a.length).join("\n\n");
  return data ? `${text}\n\n【页面脚本里的数据（可见正文很短，没显示出来的内容可能在这里）】\n${data}` : text;
}

async function load(url: string): Promise<Loaded> {
  await injectCookies(url);
  await ab(["open", url]);
  await ab(["wait", "--load", "networkidle"], 15_000).catch(() => undefined);
  return (await ab(["eval", EXTRACT]))?.result as Loaded;
}

export function readPage(url: string): Promise<ReadResult> {
  return serial(async () => {
    // 浏览器空闲 2 分钟会自己退出，Cookie 跟着没了；每次重新注入也顺带跟上你在 Chrome 里的重新登录
    injected.clear();
    const page = await load(url);
    if (needsLogin(url, page)) return { kind: "login", url: page.url };
    // 正文常在 iframe 里（VibeClub 的页面是 sandbox iframe，跨源读不到），直接打开它的地址读
    // 有 iframe 时外壳的脚本多半是站点自己的框架代码，不占篇幅
    const parts = [page.frames.length ? page.text.trim() : content(page)];
    for (const src of page.frames.slice(0, MAX_FRAMES)) {
      const frame = await load(src).catch(() => undefined);
      if (frame) parts.push(content(frame));
    }
    const text = parts.filter(Boolean).join("\n\n");
    return { kind: "page", url: page.url, title: page.title, text: text.slice(0, MAX_CHARS), truncated: text.length > MAX_CHARS };
  });
}

// 一次工具返回超过 Claude Code 的 MCP 输出上限（约 2.5 万 token）会被转存成文件，Friday 没有 Read 读不到，所以分段给
const CHUNK = 20_000;
const CACHE_MS = 10 * 60_000;
const cache = new Map<string, { page: Extract<ReadResult, { kind: "page" }>; at: number }>();

export type Chunk = { kind: "login"; url: string } | { kind: "chunk"; url: string; title: string; text: string; from: number; total: number; next?: number; truncated: boolean };

/** offset 为 0 总是重新打开页面；往后翻用 10 分钟内的缓存，不重新加载 */
export async function readChunk(url: string, offset = 0): Promise<Chunk> {
  const hit = cache.get(url);
  let page = offset > 0 && hit && Date.now() - hit.at < CACHE_MS ? hit.page : undefined;
  if (!page) {
    const r = await readPage(url);
    if (r.kind === "login") return r;
    page = r;
    cache.set(url, { page, at: Date.now() });
  }
  const end = offset + CHUNK;
  return { kind: "chunk", url: page.url, title: page.title, text: page.text.slice(offset, end), from: offset, total: page.text.length, ...(end < page.text.length ? { next: end } : {}), truncated: page.truncated };
}
