import { randomUUID } from "node:crypto";
import type { Link, LinkKind, LinkNode, LinkSource } from "@friday/shared";
import { db } from "./db.js";

interface Row {
  id: string;
  from_kind: LinkKind;
  from_ref: string;
  to_kind: LinkKind;
  to_ref: string;
  source: LinkSource;
  why: string;
  created_at: string;
  updated_at: string;
}

const toLink = (r: Row): Link => ({
  id: r.id,
  from: { kind: r.from_kind, ref: r.from_ref },
  to: { kind: r.to_kind, ref: r.to_ref },
  source: r.source,
  why: r.why,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const RANK: Record<LinkSource, number> = { guess: 0, rule: 1, user: 2 };

/** 边是无向的，但表里得有个固定方向，否则同一条边会存成两行 */
function order(a: LinkNode, b: LinkNode): [LinkNode, LinkNode] {
  return `${a.kind}:${a.ref}` <= `${b.kind}:${b.ref}` ? [a, b] : [b, a];
}

/** 否决记成一条特殊的边：另一端加 ! 前缀，这样唯一索引天然挡住重连 */
const veto = (n: LinkNode): LinkNode => ({ kind: n.kind, ref: `!${n.ref}` });

/**
 * 记一条关联。同一条边只留一行，重复推断走 UPSERT。
 * 可信度只升不降：你纠正过的（user）不会被后来的自动推断覆盖回去，
 * 被你否决过的也不会被重新连上——「纠正以后不能再出现问题」落在这里。
 */
export function linkUp(a: LinkNode, b: LinkNode, source: LinkSource, why: string): Link | undefined {
  if (!a.ref || !b.ref) return undefined;
  if (a.kind === b.kind && a.ref === b.ref) return undefined;
  if (source !== "user" && rejected(a, b)) return undefined;
  const [from, to] = order(a, b);
  const now = new Date().toISOString();
  const existing = db()
    .prepare("SELECT * FROM links WHERE from_kind = ? AND from_ref = ? AND to_kind = ? AND to_ref = ?")
    .get(from.kind, from.ref, to.kind, to.ref) as unknown as Row | undefined;
  if (existing) {
    if (RANK[source] < RANK[existing.source]) return toLink(existing);
    db().prepare("UPDATE links SET source = ?, why = ?, updated_at = ? WHERE id = ?").run(source, why, now, existing.id);
    return toLink({ ...existing, source, why, updated_at: now });
  }
  const id = randomUUID();
  db()
    .prepare("INSERT INTO links (id, from_kind, from_ref, to_kind, to_ref, source, why, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, from.kind, from.ref, to.kind, to.ref, source, why, now, now);
  return toLink({ id, from_kind: from.kind, from_ref: from.ref, to_kind: to.kind, to_ref: to.ref, source, why, created_at: now, updated_at: now });
}

/** 你说「这条不对」：断开，并记一条否决，之后的自动推断不会再把它连回来 */
export function unlink(a: LinkNode, b: LinkNode, why = "你说过这两个不是一回事"): void {
  const [from, to] = order(a, b);
  db().prepare("DELETE FROM links WHERE from_kind = ? AND from_ref = ? AND to_kind = ? AND to_ref = ?").run(from.kind, from.ref, to.kind, to.ref);
  linkUp(from, veto(to), "user", why);
}

/** 这条边是不是被你否决过 */
export function rejected(a: LinkNode, b: LinkNode): boolean {
  const [from, to] = order(a, b);
  const [vf, vt] = order(from, veto(to));
  const hit = db()
    .prepare("SELECT 1 FROM links WHERE from_kind = ? AND from_ref = ? AND to_kind = ? AND to_ref = ? AND source = 'user'")
    .get(vf.kind, vf.ref, vt.kind, vt.ref);
  return Boolean(hit);
}

const real = (r: Row): boolean => !r.from_ref.startsWith("!") && !r.to_ref.startsWith("!");

/** 跟这个实体相连的所有边（两个方向都查），否决记录不算 */
export function linksOf(node: LinkNode): Link[] {
  const rows = db()
    .prepare("SELECT * FROM links WHERE (from_kind = ? AND from_ref = ?) OR (to_kind = ? AND to_ref = ?) ORDER BY updated_at DESC")
    .all(node.kind, node.ref, node.kind, node.ref) as unknown as Row[];
  return rows.filter(real).map(toLink);
}

/** 跟这个实体相连的、指定类型的另一端，你确认过的排前面 */
export function neighbors(node: LinkNode, kind: LinkKind): Array<{ ref: string; source: LinkSource; why: string }> {
  return linksOf(node)
    .map((l) => {
      const other = l.from.kind === node.kind && l.from.ref === node.ref ? l.to : l.from;
      return other.kind === kind ? { ref: other.ref, source: l.source, why: l.why } : undefined;
    })
    .filter((x): x is { ref: string; source: LinkSource; why: string } => Boolean(x))
    .sort((a, b) => RANK[b.source] - RANK[a.source]);
}

export function allLinks(): Link[] {
  return (db().prepare("SELECT * FROM links ORDER BY updated_at DESC").all() as unknown as Row[]).filter(real).map(toLink);
}
