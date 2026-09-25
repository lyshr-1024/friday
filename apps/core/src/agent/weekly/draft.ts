import type { OkrKR } from "../../connectors/okr.js";
import { askStream, SONNET_MODEL } from "../claude.js";
import { UNTRUSTED_NOTE, untrusted } from "../fence.js";
import { config } from "../../config.js";
import type { Material } from "./collect.js";

export interface KrContext { kr: OkrKR; prevContent: string | null; prevPct: number | null }
export interface DraftItem { objectId: number; content: string; pct: number; why: string; used: string[] }
export interface Drafted { items: DraftItem[]; unmatched: string[] }

export function draftPrompt(krs: KrContext[], materials: Material[]): { system: string; prompt: string } {
  const system = [
    "你在替用户起草 OKR 平台上的每周进展（每个 KR 一段）。只输出一个 JSON，不要任何其他文字。",
    '格式：{"items":[{"objectId":数字,"content":"正文","pct":数字,"why":"进度依据一句话","used":["素材编号"]}],"unmatched":["没对上任何 KR 的素材编号"]}',
    "正文风格对齐上周：一段话，列本周交付了什么、修了什么，带工单号（m-xxxx）。只写素材里有的事，不编、不夸大；没有素材支撑的 KR 不要出现在 items 里。",
    "进度默认沿用上周；只有素材明确显示 KR 里列的事项这周完成了才上调，并在 why 里说清是哪几项；不要下调。",
    "每条 items 的 used 必须列出它依据的素材编号。",
    UNTRUSTED_NOTE,
  ].join("\n");
  const krBlock = krs.map((k) => `- objectId=${k.kr.id}｜O：${k.kr.objective}｜KR：${k.kr.name}｜上周进度：${k.prevPct ?? "无"}`).join("\n");
  const lastWeek = krs.filter((k) => k.prevContent).map((k) => `objectId=${k.kr.id}：${k.prevContent}`).join("\n");
  const prompt = [
    `【我的 KR】\n${krBlock}`,
    lastWeek ? `【上周各 KR 的正文（参考风格和进度）】\n${untrusted("last-week", lastWeek)}` : "",
    `【本周素材】\n${untrusted("materials", materials.map((m) => `${m.id} ${m.text}`).join("\n"))}`,
  ].filter(Boolean).join("\n\n");
  return { system, prompt };
}

export function parseDraft(text: string, krs: KrContext[], materials: Material[]): Drafted | undefined {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return undefined;
  let raw: { items?: unknown; unmatched?: unknown };
  try {
    raw = JSON.parse(m[0]);
  } catch {
    return undefined;
  }
  const byId = new Map(krs.map((k) => [k.kr.id, k]));
  const ids = new Set(materials.map((x) => x.id));
  const items: DraftItem[] = [];
  for (const it of Array.isArray(raw.items) ? raw.items : []) {
    const o = it as Partial<DraftItem>;
    const k = byId.get(Number(o.objectId));
    if (!k || typeof o.content !== "string" || !o.content.trim()) continue;
    const used = (Array.isArray(o.used) ? o.used : []).map(String).filter((x) => ids.has(x));
    if (!used.length) continue;
    const pct = Math.min(100, Math.max(k.prevPct ?? 0, Number.isFinite(Number(o.pct)) ? Number(o.pct) : (k.prevPct ?? 0)));
    items.push({ objectId: k.kr.id, content: o.content.trim(), pct, why: String(o.why ?? ""), used });
  }
  const unmatched = (Array.isArray(raw.unmatched) ? raw.unmatched : []).map(String).filter((x) => ids.has(x));
  return { items, unmatched };
}

export async function draftWithModel(krs: KrContext[], materials: Material[]): Promise<Drafted> {
  const { system, prompt } = draftPrompt(krs, materials);
  let last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    let text = "";
    for await (const ev of askStream(prompt, { systemPrompt: system, cwd: config.dataDir, model: SONNET_MODEL, oneShot: true, label: "okr_weekly" })) {
      if (ev.type === "delta") text += ev.text;
      if (ev.type === "reset") text = "";
      if (ev.type === "error") throw new Error(ev.message);
    }
    const parsed = parseDraft(text, krs, materials);
    if (parsed) return parsed;
    last = text;
  }
  throw new Error(`模型输出解析不了：${last.slice(0, 300)}`);
}
