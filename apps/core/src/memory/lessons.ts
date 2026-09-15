import { randomUUID } from "node:crypto";
import type { Lesson, LessonKind, ReplyCategory } from "@friday/shared";
import { db } from "./db.js";

interface Row {
  id: string;
  task_id: string | null;
  category: ReplyCategory;
  kind: LessonKind;
  draft: string | null;
  final: string | null;
  feedback: string | null;
  confidence: number;
  created_at: string;
}

const toLesson = (r: Row): Lesson => ({
  id: r.id,
  ...(r.task_id ? { taskId: r.task_id } : {}),
  category: r.category,
  kind: r.kind,
  ...(r.draft ? { draft: r.draft } : {}),
  ...(r.final ? { final: r.final } : {}),
  ...(r.feedback ? { feedback: r.feedback } : {}),
  confidence: r.confidence,
  createdAt: r.created_at,
});

export function addLesson(input: Omit<Lesson, "id" | "createdAt">): Lesson {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  db()
    .prepare("INSERT INTO lessons (id, task_id, category, kind, draft, final, feedback, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, input.taskId ?? null, input.category, input.kind, input.draft ?? null, input.final ?? null, input.feedback ?? null, input.confidence, createdAt);
  return { ...input, id, createdAt };
}

export function listLessons(category: ReplyCategory, limit = 50): Lesson[] {
  const rows = db().prepare("SELECT * FROM lessons WHERE category = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(category, limit) as unknown as Row[];
  return rows.map(toLesson);
}

export function countSince(category: ReplyCategory, kinds: LessonKind[]): number {
  if (kinds.length === 0) return 0;
  const placeholders = kinds.map(() => "?").join(",");
  const query = `SELECT COUNT(*) AS n FROM lessons WHERE category = ? AND kind IN (${placeholders})`;
  const result = db().prepare(query).get(category, ...kinds) as { n: number } | undefined;
  return result?.n ?? 0;
}

export function recentEdited(category: ReplyCategory, limit: number): Lesson[] {
  const rows = db()
    .prepare("SELECT * FROM lessons WHERE category = ? AND kind = 'edited_approved' ORDER BY created_at DESC, rowid DESC LIMIT ?")
    .all(category, limit) as unknown as Row[];
  return rows.map(toLesson);
}
