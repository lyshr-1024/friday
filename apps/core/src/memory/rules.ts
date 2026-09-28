import { randomBytes } from "node:crypto";
import { RULE_SECTIONS, type Rule, type RuleEvidence, type RuleOrigin, type RuleSection } from "@friday/shared";
import { db } from "./db.js";
import { GLOBAL } from "./handbooks.js";

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
    ? db().prepare("SELECT * FROM rules WHERE status = 'active' AND project = ? ORDER BY created_at, id").all(project)
    : db().prepare("SELECT * FROM rules WHERE status = 'active' ORDER BY project, created_at, id").all();
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

export function snapshotRules(): RulesSnapshot {
  return {
    rules: db().prepare("SELECT * FROM rules").all() as unknown as RuleRow[],
    evidence: db().prepare("SELECT * FROM rule_evidence").all() as unknown as EvidenceRow[],
  };
}

export function restoreRules(s: RulesSnapshot): void {
  const d = db();
  d.exec("BEGIN");
  try {
    d.exec("DELETE FROM rule_evidence");
    d.exec("DELETE FROM rules");
    const ins = d.prepare("INSERT INTO rules (id, project, section, text, status, origin, created_at, last_confirmed_at, retired_at, retired_why) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const r of s.rules) ins.run(r.id, r.project, r.section, r.text, r.status, r.origin, r.created_at, r.last_confirmed_at, r.retired_at, r.retired_why);
    const ev = d.prepare("INSERT INTO rule_evidence (id, rule_id, quote, at, kind, ref) VALUES (?, ?, ?, ?, ?, ?)");
    for (const e of s.evidence) ev.run(e.id, e.rule_id, e.quote, e.at, e.kind, e.ref);
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
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
  return parts.join("\n");
}
