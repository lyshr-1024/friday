import { RULE_SECTIONS, type Rule, type RuleEvidence, type RuleSection } from "@friday/shared";
import { askStream } from "./claude.js";
import { untrusted, UNTRUSTED_NOTE } from "./fence.js";
import { groupByProject, scanHistory } from "./history.js";
import { config } from "../config.js";
import { record } from "../memory/audit.js";
import { readMemoryFile, upsertPerson, writeMemoryFile } from "../memory/files.js";
import { addProjectHints } from "../memory/projectHints.js";
import { GLOBAL, handbookSlug, writeHandbook } from "../memory/handbooks.js";
import { lessonsSince } from "../memory/runs.js";
import { activeRules, addRule, confirmRule, getRule, renderHandbook, restoreRules, retireRule, reviseRule, snapshotRules, staleRules, type RulesSnapshot } from "../memory/rules.js";
import { FORBIDDEN } from "./guard.js";
import { BRANCH_RULE } from "./prompt.js";
import { getCursor, setCursor } from "../memory/inbox.js";
import { addPending, createTask, getTask } from "../memory/tasks.js";
import { userSettings } from "../settings.js";

export const HANDBOOK_MODEL = "sonnet";
export const CURSOR_KEY = "history:at";
export const RAN_KEY = "history:ran";
/** 每周学一轮就够：一周攒不满几十条新约定，天天跑只会天天弹一条没内容的待审。 */
export const HISTORY_EVERY_DAYS = 7;
/** 一组最多送多少条原话去提炼。超了取最新的——旧约定多半已经沉淀进手册了。 */
export const MAX_PER_GROUP = 120;
const CLIP = 400;
/** 攒够这么多条才值得跑一轮，否则一周学两条规则还不如不弹。 */
export const MIN_CANDIDATES = 8;

/**
 * 该学了没。跟 reviewDue 一个思路：不看「是不是周一这一刻」，只看离上次跑过了多久，
 * 机器关着也不会整周漏掉。上次时间存在 sync_state 里，重启不会丢。
 */
export function historyDue(lastRanIso: string | undefined, now = Date.now()): boolean {
  if (!lastRanIso) return true;
  const last = Date.parse(lastRanIso);
  return Number.isNaN(last) || now - last >= HISTORY_EVERY_DAYS * 86_400_000;
}

export const historyState = {
  lastRunAt: null as string | null,
  lastError: null as string | null,
  running: false,
  cursorAt: null as string | null,
};

export interface HandbookDecision {
  text: string;
  why?: string;
  at?: string;
}

export interface HandbookPerson {
  name: string;
  note: string;
}

export interface Candidate {
  /** 从 1 开始的编号；模型只能用它引证，不能自己写引文 */
  n: number;
  at: string;
  text: string;
  kind: "utterance" | "outcome";
  /** utterance：会话 id；outcome：任务 id */
  ref?: string;
}

export type RuleOp =
  | { op: "add"; section: RuleSection; text: string; evidence: number[]; why: string }
  | { op: "confirm"; id: string; evidence: number[] }
  | { op: "revise"; id: string; text: string; evidence: number[]; why: string }
  | { op: "retire"; id: string; why: string };

export interface RuleConflict {
  text: string;
  with: string;
}

export interface GroupDraft {
  project: string;
  candidates: Candidate[];
  ops: RuleOp[];
  conflicts: RuleConflict[];
  /** 久未确认的：审核卡上问一句「还算吗」 */
  stale: Array<{ id: string; text: string; lastConfirmedAt: string }>;
  /** 引证无效被丢掉的操作数 */
  dropped: number;
  decisions: HandbookDecision[];
  people: HandbookPerson[];
  aliases: string[];
  sources: number;
}

export interface HandbookDraft {
  groups: GroupDraft[];
}

const clip = (s: string, n = CLIP) => (s.length > n ? `${s.slice(0, n)}…` : s);
const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const RULE_TEXT_MAX = 60;
export const STALE_WEEKS = 8;

/** 引证必须是 1..count 的整数、至少一个；否则这条操作作废 */
function refs(v: unknown, count: number): number[] | undefined {
  if (!Array.isArray(v) || !v.length) return undefined;
  return v.every((n) => Number.isInteger(n) && n >= 1 && n <= count) ? [...new Set(v as number[])] : undefined;
}

/**
 * 模型可能多给一层 ```json 包装，也可能在前后说两句。
 * 解析层是真正的闸门：引证不存在、改动你手改过的、退役不给理由，一律丢掉并计数。
 */
export function parseOps(
  raw: string,
  count: number,
  active: Map<string, Rule>,
): Pick<GroupDraft, "ops" | "conflicts" | "dropped" | "decisions" | "people" | "aliases"> | undefined {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const ops: RuleOp[] = [];
  let dropped = 0;
  for (const item of Array.isArray(obj.ops) ? obj.ops : []) {
    const o = (item ?? {}) as Record<string, unknown>;
    const rule = typeof o.id === "string" ? active.get(o.id) : undefined;
    const text = str(o.text, RULE_TEXT_MAX);
    const why = str(o.why, 200);
    const ev = refs(o.evidence, count);
    const section = (RULE_SECTIONS as readonly string[]).includes(String(o.section)) ? (o.section as RuleSection) : "约定";
    let op: RuleOp | undefined;
    if (o.op === "add" && text && ev) op = { op: "add", section, text, evidence: ev, why };
    else if (o.op === "confirm" && rule && ev) op = { op: "confirm", id: rule.id, evidence: ev };
    else if (o.op === "revise" && rule && rule.origin !== "manual" && text && ev) op = { op: "revise", id: rule.id, text, evidence: ev, why };
    else if (o.op === "retire" && rule && rule.origin !== "manual" && why) op = { op: "retire", id: rule.id, why };
    if (op) ops.push(op);
    else dropped++;
  }
  const conflicts = (Array.isArray(obj.conflicts) ? obj.conflicts : [])
    .map((c) => {
      const o = (c ?? {}) as Record<string, unknown>;
      const text = str(o.text, 120);
      const w = str(o.with, 120);
      return text && w ? { text, with: w } : undefined;
    })
    .filter((c): c is RuleConflict => Boolean(c))
    .slice(0, 10);
  const decisions = Array.isArray(obj.decisions)
    ? obj.decisions
        .map((d) => {
          const o = (d ?? {}) as Record<string, unknown>;
          const text = str(o.text, 200);
          const why = str(o.why, 300);
          const at = /^\d{4}-\d{2}-\d{2}$/.test(String(o.at ?? "")) ? String(o.at) : "";
          return text ? { text, ...(why ? { why } : {}), ...(at ? { at } : {}) } : undefined;
        })
        .filter((d): d is HandbookDecision => Boolean(d))
        .slice(0, 20)
    : [];
  const people = Array.isArray(obj.people)
    ? obj.people
        .map((p) => {
          const o = (p ?? {}) as Record<string, unknown>;
          const name = str(o.name, 40);
          const note = str(o.note, 200);
          return name && note ? { name, note } : undefined;
        })
        .filter((p): p is HandbookPerson => Boolean(p))
        .slice(0, 20)
    : [];
  const aliases = Array.isArray(obj.aliases)
    ? obj.aliases.map((a) => str(a, 40)).filter((a) => a.length >= 2).slice(0, 10)
    : [];
  return { ops, conflicts, dropped, decisions, people, aliases };
}

/** Friday 自己的硬约束：提炼时一并给模型，让它标出和这些打架的规则 */
function hardConstraints(): string[] {
  return [...FORBIDDEN.map(([, why]) => `自主任务：${why}（守卫直接拦）`), `分支名：${BRANCH_RULE}`];
}

export function distillPrompt(project: string, candidates: Candidate[], current: Rule[], stale: ReadonlySet<string>): { system: string; prompt: string } {
  const global = project === GLOBAL;
  const system = [
    global
      ? "你在维护一个私人助理的「这位用户干活时的通用习惯」规则表——跨项目都成立的那些：提交流程、分支规范、验证要求、沟通口径。"
      : `你在维护一个私人助理的项目 ${project} 的「在这个项目里怎么干活」规则表。`,
    "输入有两类候选：用户在 Claude Code 里说过的原话（大多是纠正或定口径），和【】开头的 Friday 交付结果（被打回的原因、被用户改过才合并）。",
    "只提炼可复用的约定，一次性的具体活儿一律不要。拿不准就不动——学错一条比少学一条贵得多。",
    "输出对规则表的操作，不要重写整张表：",
    '- {"op":"add","section":"约定|技术口径|流程|别踩的坑","text":"规则，一行不超过 40 字","evidence":[候选编号],"why":"一句话"}',
    '- {"op":"confirm","id":"r-xxxxxxxx","evidence":[候选编号]}：候选里又出现了支持这条规则的证据',
    '- {"op":"revise","id":"r-xxxxxxxx","text":"新写法","evidence":[候选编号],"why":"一句话"}：新证据让它更准或推翻了旧说法',
    '- {"op":"retire","id":"r-xxxxxxxx","why":"一句话"}：新证据明确推翻了它',
    "evidence 只能填候选前面的编号，不许自己写引文；找不到能支撑的编号就说明这条是你编的，不要输出。",
    "标 [手改] 的规则是用户亲手改过的，不许 revise 或 retire。标 ⚠ 久未确认 的只在候选里有新证据时 confirm，不许因为「久」就 retire。",
    "说的是同一件事就 confirm 或 revise 已有规则，不要重复 add。",
    "如果某条规则（已有的或你要加的）和下面「Friday 的硬约束」冲突，列进 conflicts：{\"text\":\"规则\",\"with\":\"冲突的那条硬约束\"}。",
    "只输出一个 JSON 对象，不要包在代码块里：",
    '{"ops": [...], "conflicts": [...], "decisions": [{"text": "一句话结论", "why": "理由", "at": "YYYY-MM-DD"}], "people": [{"name": "人名", "note": "一句话"}], "aliases": ["项目别名"]}',
    "decisions 只放影响面超出单个文件的一次性技术决策；people 只放明确提到的协作对象；aliases 只放用户称呼这个项目用的别名。都可以是空数组，宁缺毋滥。",
    global ? "aliases 恒为空数组。" : "",
    "",
    "Friday 的硬约束：",
    ...hardConstraints().map((c) => `- ${c}`),
    UNTRUSTED_NOTE,
  ]
    .filter((l) => l !== "")
    .join("\n");
  const table = current.length
    ? current
        .map((r) => `${r.id} | ${r.section} | ${r.text} | 最近确认 ${r.lastConfirmedAt.slice(0, 10)}${r.origin === "manual" ? " [手改]" : ""}${stale.has(r.id) ? " ⚠ 久未确认" : ""}`)
        .join("\n")
    : "（还没有规则）";
  const prompt = [
    `当前规则：\n${table}`,
    "候选：",
    untrusted("claude-code-history", candidates.map((c) => `[${c.n}] ${c.at.slice(0, 10)} ${clip(c.text)}`).join("\n")),
  ].join("\n\n");
  return { system, prompt };
}

async function distillGroup(project: string, candidates: Candidate[]): Promise<GroupDraft | undefined> {
  const picked = candidates.slice(-MAX_PER_GROUP).map((c, i) => ({ ...c, n: i + 1 }));
  const current = activeRules(project);
  const stale = staleRules(project, STALE_WEEKS);
  const { system, prompt } = distillPrompt(project, picked, current, new Set(stale.map((r) => r.id)));
  let text = "";
  for await (const ev of askStream(prompt, { systemPrompt: system, cwd: config.dataDir, model: HANDBOOK_MODEL, builtin: [], label: "handbook" })) {
    if (ev.type === "delta") text += ev.text;
    if (ev.type === "reset") text = "";
  }
  const parsed = parseOps(text, picked.length, new Map(current.map((r) => [r.id, r])));
  if (!parsed) return undefined;
  return {
    project,
    candidates: picked,
    ...parsed,
    ...(project === GLOBAL ? { aliases: [] } : {}),
    stale: stale.map((r) => ({ id: r.id, text: r.text, lastConfirmedAt: r.lastConfirmedAt })),
    sources: picked.length,
  };
}

/** 被打回、被你改过才合、合进去又被 Reopen 的交付：Friday 自己干活的教训 */
export function outcomeCandidates(since: string): Array<Omit<Candidate, "n"> & { project: string }> {
  const label: Record<string, string> = { rejected: "被你打回", merged_modified: "被你改过才合并", reopened: "合并后工单又被 Reopen" };
  return lessonsSince(since).map((r) => {
    const title = getTask(r.taskId)?.title ?? r.taskId;
    return {
      project: r.project,
      at: r.outcomeAt!,
      text: `【Friday 的交付${label[r.outcome]}】${r.outcomeWhy ?? "没写原因"}（任务：${title.slice(0, 60)}）`,
      kind: "outcome" as const,
      ref: r.taskId,
    };
  });
}

const nameOf = (project: string) => (project === GLOBAL ? "通用习惯" : project);

/** 审核卡：按增删改列出来，删了什么、凭什么，一眼能核对 */
export function draftSummary(draft: HandbookDraft): string {
  return draft.groups
    .filter((g) => g.ops.length || g.decisions.length || g.people.length || g.aliases.length || g.conflicts.length || g.stale.length)
    .map((g) => {
      const quote = (ns: number[]) => ns.map((n) => g.candidates[n - 1]).filter(Boolean).map((c) => `  > [${c!.n}] ${clip(c!.text, 120)}`);
      const textOf = (id: string) => getRule(id)?.text ?? id;
      const adds = g.ops.filter((o): o is Extract<RuleOp, { op: "add" }> => o.op === "add");
      const revs = g.ops.filter((o): o is Extract<RuleOp, { op: "revise" }> => o.op === "revise");
      const rets = g.ops.filter((o): o is Extract<RuleOp, { op: "retire" }> => o.op === "retire");
      const cfs = g.ops.filter((o): o is Extract<RuleOp, { op: "confirm" }> => o.op === "confirm");
      const lines = [`## ${nameOf(g.project)}（依据 ${g.sources} 条）`];
      if (adds.length) lines.push(`新增 ${adds.length}`, ...adds.flatMap((o) => [`+ ${o.text}（${o.section}）`, ...quote(o.evidence)]));
      if (revs.length) lines.push(`改写 ${revs.length}`, ...revs.flatMap((o) => [`~ ${textOf(o.id)} → ${o.text}（${o.why}）`, ...quote(o.evidence)]));
      if (rets.length) lines.push(`退役 ${rets.length}`, ...rets.map((o) => `- ${textOf(o.id)}（${o.why}）`));
      if (cfs.length) lines.push(`确认 ${cfs.length}：${cfs.map((o) => textOf(o.id)).join("；")}`);
      if (g.conflicts.length) lines.push(`冲突 ${g.conflicts.length}`, ...g.conflicts.map((c) => `! ${c.text} ⟂ ${c.with}`));
      if (g.stale.length) lines.push(`久未确认 ${g.stale.length}（${STALE_WEEKS} 周没再说过，还算吗？不算就去设置页退役）`, ...g.stale.map((r) => `? ${r.text}（最近 ${r.lastConfirmedAt.slice(0, 10)}）`));
      if (g.dropped) lines.push(`因引证无效丢弃 ${g.dropped} 条`);
      if (g.decisions.length) lines.push(`决策 ${g.decisions.length} 条：${g.decisions.map((d) => d.text).join("；")}`);
      if (g.people.length) lines.push(`人物 ${g.people.length} 条：${g.people.map((p) => p.name).join("、")}`);
      if (g.aliases.length) lines.push(`别名：${g.aliases.join("、")}`);
      return lines.join("\n");
    })
    .join("\n\n---\n\n");
}

export type HistoryResult = { skipped: string } | { taskId: string; groups: number; candidates: number };

/**
 * 扫一遍 Claude Code 历史，把用户说过的约定提炼成项目手册。
 * 结果不直接写记忆库——挂成一条待审任务，用户过一眼点「通过并执行」才落盘。
 */
export async function learnHistoryOnce(manual = false): Promise<HistoryResult> {
  if (historyState.running) return { skipped: "上一轮还在跑" };
  if (!manual && !userSettings().learnHistory) return { skipped: "从 Claude Code 学已在设置里关掉" };
  historyState.running = true;
  historyState.lastError = null;
  try {
    const since = getCursor(CURSOR_KEY);
    const messages = scanHistory(since);
    const outcomes = outcomeCandidates(since ?? new Date(Date.now() - 30 * 86_400_000).toISOString());
    historyState.cursorAt = since ?? null;
    const total0 = messages.length + outcomes.length;
    if (total0 < (manual ? 1 : MIN_CANDIDATES)) {
      setCursor(RAN_KEY, new Date().toISOString());
      return { skipped: since ? `自上次学过之后只攒了 ${total0} 条新的，不够提炼一轮` : "没在 Claude Code 历史里找到可学的原话" };
    }
    const groups = new Map<string, Candidate[]>();
    for (const [project, list] of groupByProject(messages)) {
      groups.set(project, list.map((m) => ({ n: 0, at: m.at, text: m.text, kind: "utterance" as const, ref: m.session })));
    }
    for (const o of outcomes) {
      const { project, ...c } = o;
      groups.set(project, [...(groups.get(project) ?? []), { ...c, n: 0 }]);
    }
    const drafts: GroupDraft[] = [];
    for (const [project, list] of groups) {
      // 一个项目只说过一两句的，多半是路过；但 Friday 自己的交付被打回，哪怕一次也值得看
      if (list.length < 3 && !list.some((c) => c.kind === "outcome")) continue;
      const d = await distillGroup(project, list.sort((a, b) => a.at.localeCompare(b.at)));
      if (d && (d.ops.length || d.decisions.length || d.people.length || d.aliases.length || d.conflicts.length)) drafts.push(d);
    }
    if (!drafts.length) return { skipped: "这批原话里没提炼出可复用的约定" };

    const latest = [...messages.map((m) => m.at), ...outcomes.map((o) => o.at)].reduce((max, at) => (at > max ? at : max), since ?? "");
    const total = drafts.reduce((n, g) => n + g.sources, 0);
    const names = drafts.map((g) => (g.project === GLOBAL ? "通用" : g.project)).join("、");
    const task = createTask({
      title: `从 Claude Code 历史和交付结果里学了 ${drafts.length} 份手册的改动`,
      kind: "handbook",
      source: { historyCursor: latest },
      status: "review",
      priority: "low",
      understanding: `扫了 ${since ? "上次学过之后" : "近 30 天"}的 Claude Code 会话和 Friday 的交付结果，从 ${total} 条候选里得出 ${names} 的规则改动。每条都指向候选原文，可以直接核对；退役和改写要你点头才生效。`,
      plan: draftSummary({ groups: drafts }),
    });
    addPending(task.id, {
      type: "handbook_apply",
      label: "写进记忆库",
      detail: `按上面的增删改更新 ${names} 的规则表并重新生成 handbooks/，附带的决策、人物、别名一并落盘。可在操作记录里整体撤销。`,
      payload: { draft: { groups: drafts } as unknown as Record<string, unknown>, cursor: latest },
    });
    setCursor(CURSOR_KEY, latest);
    historyState.lastRunAt = new Date().toISOString();
    setCursor(RAN_KEY, historyState.lastRunAt);
    historyState.cursorAt = latest;
    record({
      taskId: task.id,
      action: "history_distilled",
      why: manual ? "你让 Friday 现在学一轮" : "每周从 Claude Code 历史学一轮",
      how: `${total} 条候选（其中交付结果 ${outcomes.length} 条）得出 ${drafts.reduce((n, g) => n + g.ops.length, 0)} 条规则改动，等你审核`,
      evidence: { groups: drafts.map((g) => g.project), candidates: total },
      risk: "read",
    });
    return { taskId: task.id, groups: drafts.length, candidates: total };
  } catch (e) {
    historyState.lastError = e instanceof Error ? e.message : String(e);
    return { skipped: `出错了：${historyState.lastError}` };
  } finally {
    historyState.running = false;
  }
}

export interface MemorySnapshot {
  rules?: RulesSnapshot;
  /** 2026-09-28 之前的撤销点存的是整份 markdown；那种还原完下次渲染会被规则表覆盖 */
  handbooks?: Record<string, string>;
  decisions: string;
  people: string;
  projects: string;
}

function evidenceFrom(g: GroupDraft, ns: number[]): RuleEvidence[] {
  return ns
    .map((n) => g.candidates[n - 1])
    .filter((c): c is Candidate => Boolean(c))
    .map((c) => ({ quote: clip(c.text), at: c.at, kind: c.kind, ...(c.ref ? { ref: c.ref } : {}) }));
}

/** 用户点「通过并执行」之后才真正写记忆库。返回撤销用的快照。 */
export function applyHandbookDraft(draft: HandbookDraft): { snapshot: MemorySnapshot; wrote: string[] } {
  const touched = draft.groups.flatMap((g) => g.ops.flatMap((o) => (o.op === "add" ? [] : [o.id])));
  const rules = snapshotRules([...new Set(touched)]);
  const snapshot: MemorySnapshot = {
    rules,
    decisions: readMemoryFile("decisions"),
    people: readMemoryFile("people"),
    projects: readMemoryFile("projects"),
  };
  const wrote: string[] = [];
  const stamp = new Date().toISOString().slice(0, 10);

  let skipped = 0;
  for (const g of draft.groups) {
    let n = 0;
    for (const o of g.ops) {
      // 卡可能挂了好几天：这期间你手改过或退役了的，通过时也不能动
      if (o.op !== "add") {
        const cur = getRule(o.id);
        if (!cur || cur.status !== "active" || (o.op !== "confirm" && cur.origin === "manual")) {
          skipped++;
          continue;
        }
      }
      if (o.op === "add") {
        const evidence = evidenceFrom(g, o.evidence);
        const origin = evidence.every((e) => e.kind === "outcome") ? "outcome" : "history";
        rules.added!.push(addRule({ project: g.project, section: o.section, text: o.text, origin, evidence }).id);
      } else if (o.op === "confirm") for (const e of evidenceFrom(g, o.evidence)) confirmRule(o.id, e);
      else if (o.op === "revise") {
        const [first, ...rest] = evidenceFrom(g, o.evidence);
        if (first) reviseRule(o.id, o.text, first);
        for (const e of rest) confirmRule(o.id, e);
      } else retireRule(o.id, o.why);
      n++;
    }
    if (n) {
      writeHandbook(g.project, renderHandbook(g.project));
      wrote.push(`handbooks/${handbookSlug(g.project)}.md ${n} 处`);
    }

    if (g.decisions.length) {
      const cur = readMemoryFile("decisions");
      const add = g.decisions
        .filter((d) => !cur.includes(d.text))
        .map((d) => `## ${d.at ?? stamp} ${d.text}\n${d.why ?? ""}`.trimEnd())
        .join("\n\n");
      if (add) {
        writeMemoryFile("decisions", `${cur.trimEnd()}\n\n${add}\n`);
        wrote.push(`decisions.md +${g.decisions.length}`);
      }
    }
    for (const p of g.people) {
      if (!readMemoryFile("people").includes(p.note)) upsertPerson(p.name, p.note);
    }
    if (g.people.length) wrote.push(`people.md +${g.people.length}`);
    if (g.aliases.length && g.project !== GLOBAL) {
      const r = addProjectHints(g.project, { aliases: g.aliases });
      if (r.changed) wrote.push(`projects.md 别名 +${r.added.aliases.length}`);
    }
  }
  if (skipped) wrote.push(`跳过 ${skipped} 条（审核期间你改过或退役了）`);
  return { snapshot, wrote };
}

/** 整体还原到 apply 之前：规则表按快照整张换回，再把涉及的手册重新渲染 */
export function restoreMemorySnapshot(s: MemorySnapshot): boolean {
  if (s.rules) for (const project of restoreRules(s.rules)) writeHandbook(project, renderHandbook(project));
  for (const [slug, content] of Object.entries(s.handbooks ?? {})) writeHandbook(slug, content);
  writeMemoryFile("decisions", s.decisions);
  writeMemoryFile("people", s.people);
  writeMemoryFile("projects", s.projects);
  return true;
}
