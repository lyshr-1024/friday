import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RULE_SECTIONS, type RuleEvidence, type RuleSection } from "@friday/shared";
import { db } from "./db.js";
import { GLOBAL, handbookDir, handbookNotesPath, listHandbooks, writeHandbook } from "./handbooks.js";
import { addRule, renderHandbook } from "./rules.js";

interface Parsed {
  section: RuleSection;
  text: string;
  quotes: string[];
}

/** 旧手册的形状：`## 分区` 下 `- 规则` 紧跟若干 `> 原话`；分区名不在四个之内的是手写段落，整段原样留作笔记 */
export function parseHandbook(md: string): { rules: Parsed[]; notes: string } {
  const rules: Parsed[] = [];
  const notes: string[] = [];
  let section: RuleSection | undefined = "约定";
  let freeform = false;
  for (const line of md.split("\n")) {
    const h = /^## (.+)$/.exec(line);
    if (h) {
      const name = h[1]!.trim();
      freeform = !(RULE_SECTIONS as readonly string[]).includes(name) && !/^[^\s：:]{1,8}$/.test(name);
      section = freeform ? undefined : (RULE_SECTIONS as readonly string[]).includes(name) ? (name as RuleSection) : "约定";
      if (freeform) notes.push(line);
      continue;
    }
    if (freeform) {
      notes.push(line);
      continue;
    }
    if (line.startsWith("- ") && section) rules.push({ section, text: line.slice(2).trim(), quotes: [] });
    else if (line.startsWith(">") && rules.length) rules.at(-1)!.quotes.push(line.replace(/^>\s?/, "").trim());
  }
  return { rules, notes: notes.join("\n").trim() };
}

const key = (text: string) => text.replace(/\s+/g, "");

/** 一次性：rules 表空着时把 handbooks/*.md 迁进来。旧文件留一份 .migrated，新文件由表渲染 */
export function migrateHandbooksToRules(): { migrated: number; skipped?: string } {
  if ((db().prepare("SELECT COUNT(*) AS n FROM rules").get() as { n: number }).n > 0) return { migrated: 0, skipped: "已迁移" };
  const slugs = listHandbooks();
  if (!slugs.length) return { migrated: 0, skipped: "没有手册" };

  const merged = new Map<string, { projects: Set<string>; section: RuleSection; text: string; evidence: RuleEvidence[] }>();
  for (const slug of slugs) {
    const file = join(handbookDir(), `${slug}.md`);
    const at = statSync(file).mtime.toISOString();
    const { rules, notes } = parseHandbook(readFileSync(file, "utf8"));
    if (notes) {
      mkdirSync(join(handbookDir(), "notes"), { recursive: true });
      writeFileSync(handbookNotesPath(slug), `${notes}\n`);
    }
    for (const r of rules) {
      const k = key(r.text);
      const hit = merged.get(k) ?? { projects: new Set<string>(), section: r.section, text: r.text, evidence: [] };
      hit.projects.add(slug);
      for (const q of r.quotes) if (!hit.evidence.some((e) => e.quote === q)) hit.evidence.push({ quote: q, at, kind: "utterance" });
      merged.set(k, hit);
    }
  }

  let migrated = 0;
  for (const m of merged.values()) {
    const project = m.projects.size > 1 ? GLOBAL : [...m.projects][0]!;
    addRule({ project, section: m.section, text: m.text, origin: "history", evidence: m.evidence, at: m.evidence[0]?.at });
    migrated++;
  }
  const touched = new Set([...slugs, ...[...merged.values()].some((m) => m.projects.size > 1) ? [GLOBAL] : []]);
  for (const slug of touched) {
    const file = join(handbookDir(), `${slug}.md`);
    try {
      renameSync(file, `${file}.migrated`);
    } catch {
      /* _global 可能原本不存在 */
    }
    writeHandbook(slug, renderHandbook(slug));
  }
  return { migrated };
}
