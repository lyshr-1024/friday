import { randomBytes } from "node:crypto";
import { RULE_SECTIONS, type Rule, type RuleEvidence, type RuleOrigin, type RuleSection } from "@friday/shared";
import { db } from "./db.js";
import { GLOBAL, readHandbookNotes } from "./handbooks.js";

interface RuleRow {
  id: string;
  project: string;
  section: RuleSection;
  text: string;
  status: "active" | "retired";
  origin: RuleOrigin;
  created_at: string;
  last_confirmed_at: string;
  retired_at: string | null;
  retired_why: string | null;
}
interface EvidenceRow {
  id: number;
  rule_id: string;
  quote: string;
  at: string;
  kind: RuleEvidence["kind"];
  ref: string | null;
}
export interface RulesSnapshot {
  rules: RuleRow[];
  evidence: EvidenceRow[];
  /** 只存了某些规则的前态：还原时只动这些 id 和 added，别的规则（之后你手改的、下一轮加的）不碰 */
  scoped?: boolean;
  added?: string[];
}

const toEvidence = (e: EvidenceRow): RuleEvidence => ({ quote: e.quote, at: e.at, kind: e.kind, ...(e.ref ? { ref: e.ref } : {}) });

function hydrate(rows: RuleRow[]): Rule[] {
  if (!rows.length) return [];
  const ev = db()
    .prepare(`SELECT * FROM rule_evidence WHERE rule_id IN (${rows.map(() => "?").join(",")}) ORDER BY at, id`)
    .all(...rows.map((r) => r.id)) as unknown as EvidenceRow[];
  const by = new Map<string, RuleEvidence[]>();
  for (const e of ev) by.set(e.rule_id, [...(by.get(e.rule_id) ?? []), toEvidence(e)]);
  return rows.map((r) => ({
    id: r.id,
    project: r.project,
    section: r.section,
    text: r.text,
    status: r.status,
    origin: r.origin,
    createdAt: r.created_at,
    lastConfirmedAt: r.last_confirmed_at,
    ...(r.retired_at ? { retiredAt: r.retired_at } : {}),
    ...(r.retired_why ? { retiredWhy: r.retired_why } : {}),
    evidence: by.get(r.id) ?? [],
  }));
}

export function getRule(id: string): Rule | undefined {
  return hydrate(db().prepare("SELECT * FROM rules WHERE id = ?").all(id) as unknown as RuleRow[])[0];
}

export function activeRules(project?: string): Rule[] {
  const rows = project
    ? db().prepare("SELECT * FROM rules WHERE status = 'active' AND project = ? ORDER BY created_at, rowid").all(project)
    : db().prepare("SELECT * FROM rules WHERE status = 'active' ORDER BY project, created_at, rowid").all();
  return hydrate(rows as unknown as RuleRow[]);
}

function addEvidence(ruleId: string, e: RuleEvidence): void {
  db().prepare("INSERT INTO rule_evidence (rule_id, quote, at, kind, ref) VALUES (?, ?, ?, ?, ?)").run(ruleId, e.quote, e.at, e.kind, e.ref ?? null);
}

const latest = (evidence: RuleEvidence[], fallback: string) => evidence.reduce((m, e) => (e.at > m ? e.at : m), evidence[0]?.at ?? fallback);

export function addRule(r: { project: string; section: RuleSection; text: string; origin: RuleOrigin; evidence: RuleEvidence[]; at?: string }): Rule {
  const id = `r-${randomBytes(4).toString("hex")}`;
  const now = r.at ?? new Date().toISOString();
  db()
    .prepare("INSERT INTO rules (id, project, section, text, origin, created_at, last_confirmed_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, r.project, r.section, r.text, r.origin, now, latest(r.evidence, now));
  for (const e of r.evidence) addEvidence(id, e);
  return getRule(id)!;
}

function touch(id: string, e: RuleEvidence): void {
  addEvidence(id, e);
  db().prepare("UPDATE rules SET last_confirmed_at = MAX(last_confirmed_at, ?) WHERE id = ?").run(e.at, id);
}

export function confirmRule(id: string, e: RuleEvidence): Rule | undefined {
  if (!getRule(id)) return undefined;
  touch(id, e);
  return getRule(id);
}

export function reviseRule(id: string, text: string, e: RuleEvidence): Rule | undefined {
  if (!getRule(id)) return undefined;
  db().prepare("UPDATE rules SET text = ? WHERE id = ?").run(text, id);
  touch(id, e);
  return getRule(id);
}

export function retireRule(id: string, why: string): Rule | undefined {
  db().prepare("UPDATE rules SET status = 'retired', retired_at = ?, retired_why = ? WHERE id = ?").run(new Date().toISOString(), why, id);
  return getRule(id);
}

/** 你在设置页亲手改：之后提炼不许再改写或退役它 */
export function setRuleText(id: string, text: string): Rule | undefined {
  db().prepare("UPDATE rules SET text = ?, origin = 'manual' WHERE id = ?").run(text, id);
  return getRule(id);
}

/** 超过 weeks 周没有新证据的。只用来在审核卡上问一句「还算吗」，不自动退役 */
export function staleRules(project: string, weeks = 8, now = new Date()): Rule[] {
  const cutoff = new Date(now.getTime() - weeks * 7 * 86_400_000).toISOString();
  return activeRules(project).filter((r) => r.lastConfirmedAt < cutoff);
}

export function snapshotRules(ids?: string[]): RulesSnapshot {
  if (!ids) {
    return {
      rules: db().prepare("SELECT * FROM rules").all() as unknown as RuleRow[],
      evidence: db().prepare("SELECT * FROM rule_evidence").all() as unknown as EvidenceRow[],
    };
  }
  const q = ids.map(() => "?").join(",");
  return {
    rules: ids.length ? (db().prepare(`SELECT * FROM rules WHERE id IN (${q})`).all(...ids) as unknown as RuleRow[]) : [],
    evidence: ids.length ? (db().prepare(`SELECT * FROM rule_evidence WHERE rule_id IN (${q})`).all(...ids) as unknown as EvidenceRow[]) : [],
    scoped: true,
    added: [],
  };
}

/** 规则还原后涉及到哪些项目，调用方据此重新渲染手册 */
export function restoreRules(s: RulesSnapshot): string[] {
  const d = db();
  const ids = s.scoped ? [...new Set([...s.rules.map((r) => r.id), ...(s.added ?? [])])] : undefined;
  const projects = new Set<string>(s.rules.map((r) => r.project));
  for (const id of ids ?? []) {
    const cur = getRule(id);
    if (cur) projects.add(cur.project);
  }
  if (!ids) for (const r of activeRules()) projects.add(r.project);
  d.exec("BEGIN");
  try {
    if (ids) {
      const del = (table: string, col: string) => ids.length && d.prepare(`DELETE FROM ${table} WHERE ${col} IN (${ids.map(() => "?").join(",")})`).run(...ids);
      del("rule_evidence", "rule_id");
      del("rules", "id");
    } else {
      d.exec("DELETE FROM rule_evidence");
      d.exec("DELETE FROM rules");
    }
    const ins = d.prepare("INSERT INTO rules (id, project, section, text, status, origin, created_at, last_confirmed_at, retired_at, retired_why) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const r of s.rules) ins.run(r.id, r.project, r.section, r.text, r.status, r.origin, r.created_at, r.last_confirmed_at, r.retired_at, r.retired_why);
    const ev = d.prepare("INSERT INTO rule_evidence (id, rule_id, quote, at, kind, ref) VALUES (?, ?, ?, ?, ?, ?)");
    for (const e of s.evidence) ev.run(e.id, e.rule_id, e.quote, e.at, e.kind, e.ref);
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
  return [...projects];
}

/** handbooks/<项目>.md 是这张表的渲染：给你看、给 Claude Code 读，不再是可编辑的源 */
export function renderHandbook(project: string): string {
  const rules = activeRules(project);
  const title = project === GLOBAL ? "通用习惯" : project;
  const parts = [`# ${title}\n`, "<!-- Friday 生成，改这个文件会被覆盖；要改规则去设置页「项目手册」逐条改 -->\n"];
  for (const section of RULE_SECTIONS) {
    const list = rules.filter((r) => r.section === section);
    if (!list.length) continue;
    parts.push(`## ${section}`);
    for (const r of list) {
      parts.push(`- ${r.text} <!-- ${r.id} -->`);
      if (r.evidence[0]) parts.push(`> ${r.evidence[0].quote.replace(/\n/g, " ")}`);
    }
    parts.push("");
  }
  const notes = readHandbookNotes(project);
  if (notes) parts.push(notes, "");
  return parts.join("\n");
}

/**
 * 派去终端干活的 Claude 要吃到的那段：只带规则正文（出处是给你核对的，不是给模型的），
 * 按最近确认的先放，整行截到预算；手写笔记放得下才整段带上，不切半截。
 */
export function handbookBlock(project: string, limit = 1500): string {
  const block = (p: string, label: string) => {
    const lines: string[] = [];
    let used = 0;
    for (const r of [...activeRules(p)].sort((a, b) => b.lastConfirmedAt.localeCompare(a.lastConfirmedAt))) {
      const line = `- ${r.text}`;
      if (used + line.length + 1 > limit) break;
      lines.push(line);
      used += line.length + 1;
    }
    const notes = readHandbookNotes(p);
    if (notes && used + notes.length <= limit) lines.push(notes);
    return lines.length ? `${label}：\n${lines.join("\n")}` : "";
  };
  return [project === GLOBAL ? "" : block(project, `项目 ${project}`), block(GLOBAL, "通用")].filter(Boolean).join("\n\n");
}
