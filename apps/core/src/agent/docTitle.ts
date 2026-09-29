import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TaskDoc } from "@friday/shared";
import { getTask, listTasks, updateTask } from "../memory/tasks.js";

const execFileP = promisify(execFile);
const TRACKING = /^(from|utm_[a-z]+|spm|share_token|sharer)$/i;
const LARK = /(^|\.)(feishu\.cn|larksuite\.com|larkoffice\.com)$/;
const BODY_LIMIT = 200_000;

export function normUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    u.hostname = u.hostname.toLowerCase();
    return u.toString().replace(/\/(\?|$)/, "$1").replace(/\?$/, "");
  } catch {
    return url.trim();
  }
}

export function mergeDocs(a: TaskDoc[], b: TaskDoc[]): TaskDoc[] {
  const out = new Map<string, TaskDoc>();
  for (const d of [...a, ...b]) {
    const k = normUrl(d.url);
    const cur = out.get(k);
    if (!cur) out.set(k, d);
    else if (!cur.title && d.title) out.set(k, { ...cur, title: d.title });
  }
  return [...out.values()];
}

export function syncDocs(existing: TaskDoc[], incoming: TaskDoc[], removed: string[] | undefined): TaskDoc[] {
  const gone = new Set(removed ?? []);
  return mergeDocs(existing, incoming.filter((d) => !gone.has(normUrl(d.url))));
}

export function fallbackTitle(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop() ?? "";
    return `${u.hostname.replace(/^www\./, "")}${last ? ` / ${decodeURIComponent(last)}` : ""}`;
  } catch {
    return url;
  }
}

export function larkTitle(out: string): string | undefined {
  const raw = out.trim().startsWith('"') ? (JSON.parse(out) as string) : out;
  return raw.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || undefined;
}

export async function pageTitle(url: string): Promise<string | undefined> {
  const res = await fetch(url, { signal: AbortSignal.timeout(8_000), redirect: "follow", credentials: "omit" });
  if (!res.ok) return undefined;
  const reader = res.body?.getReader();
  if (!reader) return undefined;
  const dec = new TextDecoder();
  let html = "";
  while (html.length < BODY_LIMIT) {
    const { done, value } = await reader.read();
    if (done) break;
    html += dec.decode(value, { stream: true });
  }
  await reader.cancel().catch(() => {});
  html = html.slice(0, BODY_LIMIT);
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1];
  const title = og ?? html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1];
  return title?.replace(/\s+/g, " ").trim() || undefined;
}

export async function docTitle(url: string): Promise<string | undefined> {
  let host = "";
  try { host = new URL(url).hostname; } catch { return undefined; }
  try {
    if (LARK.test(host)) {
      const { stdout } = await execFileP("lark-cli", ["docs", "+fetch", "--doc", url, "--jq", ".data.document.content"], { timeout: 15_000, maxBuffer: 32 * 1024 * 1024 });
      return larkTitle(stdout);
    }
    return await pageTitle(url);
  } catch {
    return undefined;
  }
}

export function fillDocTitles(taskId: string, only?: string): void {
  const pending = (getTask(taskId)?.source.docs ?? []).filter((d) => !d.title && (!only || normUrl(d.url) === normUrl(only)));
  for (const d of pending) {
    void docTitle(d.url).then((title) => {
      const cur = getTask(taskId);
      if (!title || !cur) return;
      updateTask(taskId, { source: { docs: (cur.source.docs ?? []).map((x) => (normUrl(x.url) === normUrl(d.url) && !x.title ? { ...x, title } : x)) } });
    }).catch(() => {});
  }
}

export async function fillMissingTitles(fetcher: (url: string) => Promise<string | undefined> = docTitle, concurrency = 2): Promise<void> {
  const queue = listTasks(["collected", "understood", "processing", "review", "blocked"], 500).flatMap((t) => (t.source.docs ?? []).filter((d) => !d.title).map((d) => ({ id: t.id, url: d.url })));
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const title = await fetcher(job.url).catch(() => undefined);
      const cur = getTask(job.id);
      if (!title || !cur) continue;
      updateTask(job.id, { source: { docs: (cur.source.docs ?? []).map((x) => (normUrl(x.url) === normUrl(job.url) && !x.title ? { ...x, title } : x)) } });
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
}
