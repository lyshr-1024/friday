import { taskCategory, type SearchHit, type SearchResult } from "@friday/shared";
import { db } from "./db.js";

/** LIKE 的通配符要转义，否则搜「100%」会把 % 当成通配。 */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * 命中处截一段上下文出来，让用户知道是哪句话匹配上的。
 * 找不到（比如只命中标题）就退回开头一段。
 */
export function snippet(text: string, q: string, span = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const at = flat.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return flat.slice(0, span * 2);
  const from = Math.max(0, at - Math.floor(span / 2));
  const to = Math.min(flat.length, at + q.length + span);
  return `${from > 0 ? "…" : ""}${flat.slice(from, to)}${to < flat.length ? "…" : ""}`;
}

interface TaskRow {
  id: string;
  title: string;
  kind: string;
  source: string;
  project: string | null;
  status: string;
  understanding: string | null;
  plan: string | null;
  updated_at: string;
}

interface MsgRow {
  id: string;
  conversation_id: string;
  title: string | null;
  role: string;
  content: string;
  created_at: string;
}

const TASK_LIMIT = 40;
const MSG_LIMIT = 20;

/**
 * 全局搜索：任务（需求 / 缺陷 / 其他）和对话。
 * 用 LIKE 而不是 FTS：中文不分词，FTS5 反而要额外的 tokenizer，LIKE 的子串匹配正合适。
 */
export function search(query: string): SearchResult {
  const q = query.trim();
  if (!q) return { tasks: [], messages: [] };
  const like = likePattern(q);

  // 已忽略的不出现在搜索里；source 里塞着缺陷描述和所属需求名，一并搜
  const taskRows = db()
    .prepare(
      `SELECT id, title, kind, source, project, status, understanding, plan, updated_at
         FROM tasks
        WHERE status != 'ignored'
          AND (title LIKE ? ESCAPE '\\' OR understanding LIKE ? ESCAPE '\\' OR plan LIKE ? ESCAPE '\\'
               OR progress LIKE ? ESCAPE '\\' OR source LIKE ? ESCAPE '\\')
        ORDER BY updated_at DESC
        LIMIT ?`,
    )
    .all(like, like, like, like, like, TASK_LIMIT) as unknown as TaskRow[];

  const tasks: SearchHit[] = taskRows.map((r) => {
    const source = JSON.parse(r.source) as Record<string, unknown>;
    // 标题命中就不必再给上下文，标题本身已经说明问题
    const inTitle = r.title.toLowerCase().includes(q.toLowerCase());
    const body = [r.understanding, r.plan, typeof source.description === "string" ? source.description : ""].filter(Boolean).join("\n");
    return {
      kind: "task",
      id: r.id,
      title: r.title,
      category: taskCategory(source as never),
      status: r.status,
      ...(r.project ? { project: r.project } : {}),
      ...(inTitle ? {} : { snippet: snippet(body, q) }),
      updatedAt: r.updated_at,
    };
  });

  const msgRows = db()
    .prepare(
      // 标题取法和会话列表保持一致：多数会话 title 是空的，用第一条用户消息兜底
      `SELECT m.id, m.conversation_id, m.role, m.content, m.created_at,
              COALESCE(c.title, (SELECT content FROM messages f WHERE f.conversation_id = c.id AND f.role = 'user' ORDER BY f.created_at, f.rowid LIMIT 1)) AS title
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE m.content LIKE ? ESCAPE '\\'
        ORDER BY m.created_at DESC
        LIMIT ?`,
    )
    .all(like, MSG_LIMIT) as unknown as MsgRow[];

  const messages: SearchHit[] = msgRows.map((r) => ({
    kind: "message",
    id: r.conversation_id,
    messageId: r.id,
    title: (r.title ?? "新对话").slice(0, 60),
    role: r.role === "user" ? "你" : "Friday",
    snippet: snippet(r.content, q),
    updatedAt: r.created_at,
  }));

  return { tasks, messages };
}
