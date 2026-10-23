import { createHash } from "node:crypto";
import type { Brief, BriefDep, Task } from "@friday/shared";
import { isFridayProject, type Project } from "../memory/projects.js";

export { briefable } from "@friday/shared";
import { briefable } from "@friday/shared";

export type BriefPolicy = "全部" | "大的" | "不用";

const PRIORITY = { high: 0, normal: 1, low: 2 } as const;

/** Meegle 工单刚建时描述常被反复改，等一个同步周期再动 */
export const AUTOSTART_SETTLE_MS = 15 * 60_000;

export function pickBriefQueue(tasks: Task[], now = Date.now(), skip: (t: Task) => boolean = () => false): Task | undefined {
  return tasks
    .filter((t) => briefable(t) && !t.source.brief && !t.source.briefFailed && !t.source.autostartOff)
    .filter((t) => !(t.kind === "work_item" && now - Date.parse(t.createdAt) < AUTOSTART_SETTLE_MS) && !skip(t))
    .sort((a, b) => {
      if (a.due !== b.due) return !a.due ? 1 : !b.due ? -1 : a.due < b.due ? -1 : 1;
      if (a.priority !== b.priority) return PRIORITY[a.priority] - PRIORITY[b.priority];
      return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
    })[0];
}

export function briefPolicy(p: Project | undefined): BriefPolicy {
  if (isFridayProject(p)) return "全部";
  const v = p?.extra["方案送审"]?.trim();
  return v === "大的" || v === "不用" ? v : "全部";
}

export function reviewFor(size: Brief["size"], policy: BriefPolicy): "none" | "pending" {
  if (policy === "不用") return "none";
  if (policy === "大的") return size === "large" ? "pending" : "none";
  return "pending";
}

export function briefBasis(t: Task): string {
  const docs = (t.source.docs ?? []).map((d) => d.url).join("\n");
  return createHash("sha1").update(`${t.title}\n${t.source.description ?? ""}\n${docs}`).digest("hex").slice(0, 12);
}

const clip = (v: unknown, n: number): string => (typeof v === "string" ? v.trim().slice(0, n) : "");

// 老名字 meegle / slack 是迁移前的写法，收进来一律写成新名字
const EVIDENCE_SOURCE = new Map<unknown, NonNullable<BriefDep["evidence"]>["source"]>([
  ["work_item", "work_item"],
  ["conversation", "conversation"],
  ["user", "user"],
  ["meegle", "work_item"],
  ["slack", "conversation"],
]);

export function parseBrief(raw: unknown, ctx: { featureIds: Set<string>; basis: string; at?: string }): Brief | string {
  if (!raw || typeof raw !== "object") return "理解卡必须是一个对象";
  const r = raw as Record<string, unknown>;
  const todo = clip(r.todo, 4000);
  if (!todo) return "todo 不能为空：写清这条需求要做什么";
  if (r.size !== "small" && r.size !== "large") return "size 只能是 small 或 large";
  const acc = r.acceptance as Record<string, unknown> | undefined;
  if (!acc || typeof acc !== "object") return "acceptance 缺失：要有 source 和用例 cases";
  if (acc.source !== "cases" && acc.source !== "prd" && acc.source !== "own") return "acceptance.source 只能是 cases / prd / own";
  const cases = (Array.isArray(acc.cases) ? acc.cases : []).map((c) => clip(c, 300)).filter(Boolean).slice(0, 30);
  if (!cases.length) return "acceptance.cases 至少写 1 条用例";
  const deps: BriefDep[] = (Array.isArray(r.deps) ? r.deps : []).slice(0, 20).flatMap((d) => {
    const o = d as Record<string, unknown>;
    const what = clip(o?.what, 300);
    if (!what) return [];
    const dep: BriefDep = { what, status: o.status === "ready" ? "ready" : "pending" };
    const from = clip(o.from, 100);
    if (from) dep.from = from;
    const ev = o.evidence as Record<string, unknown> | undefined;
    const source = ev && typeof ev === "object" ? EVIDENCE_SOURCE.get(ev.source) : undefined;
    if (ev && source) {
      dep.evidence = { source, at: clip(ev.at, 40) || ctx.at || new Date().toISOString() };
      const url = clip(ev.url, 500);
      const text = clip(ev.text, 500);
      if (url) dep.evidence.url = url;
      if (text) dep.evidence.text = text;
    }
    return [dep];
  });
  const note = clip(acc.note, 500);
  const features = (Array.isArray(r.features) ? r.features : []).filter((f): f is string => typeof f === "string" && ctx.featureIds.has(f));
  return {
    todo,
    deps,
    acceptance: { source: acc.source, cases, ...(note ? { note } : {}) },
    release: clip(r.release, 1000),
    plan: clip(r.plan, 4000),
    size: r.size,
    sizeWhy: clip(r.sizeWhy, 300),
    review: "none",
    basis: ctx.basis,
    at: ctx.at ?? new Date().toISOString(),
    features,
  };
}

const ACCEPTANCE_SOURCE = { cases: "来自测试用例", prd: "来自需求文档", own: "Friday 自己拟的" } as const;

export function renderBrief(b: Brief): string {
  const deps = b.deps.length ? b.deps.map((d) => `- ${d.status === "ready" ? "✓" : "…"} ${d.what}${d.from ? ` — ${d.from}` : ""}`).join("\n") : "无";
  const cases = b.acceptance.cases.map((c, i) => `${i + 1}. ${c}`).join("\n");
  return [
    `## 要做什么\n${b.todo}`,
    `## 要别人给的\n${deps}`,
    `## 怎么验收\n${ACCEPTANCE_SOURCE[b.acceptance.source]}${b.acceptance.note ? `（${b.acceptance.note}）` : ""}\n${cases}`,
    `## 怎么发\n${b.release || "未说明"}`,
    `## 方案\n${b.plan || "未说明"}`,
    `规模：${b.size === "small" ? "小" : "大"}（${b.sizeWhy}）`,
  ].join("\n\n");
}

export function briefDetail(t: Task, b: Brief): string {
  return [
    `「${t.title}」这条需求的理解卡已经审过（或不用审），照它做。`,
    renderBrief(b),
    [
      "- 用例清单就是你自测的清单，交付报告的「请验证」逐条对应用例。",
      "- 方案是起点，偏离了在报告里写明为什么。",
      "- 依赖的证据（接口文档、设计稿链接）在上面，没写的去问 friday_context。",
    ].join("\n"),
  ].join("\n\n");
}

/** 手动开工、回退重开：理解卡审过（或不用审）、没过期、项目一致就用它交代，否则返回 undefined 走原来的说法 */
export function usableBriefDetail(t: Task): string | undefined {
  const b = t.source.brief;
  if (!b || (b.review !== "approved" && b.review !== "none") || b.stale || b.basis !== briefBasis(t)) return undefined;
  if (b.project && b.project !== t.project) return undefined;
  return briefDetail(t, b);
}
