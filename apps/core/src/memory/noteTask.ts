import type { Stage, Task, TaskKind, TaskSource, TaskStatus } from "@friday/shared";
import { db } from "./db.js";
import { meegleIdsIn } from "./infer.js";
import { loadProjects } from "./projects.js";
import { createTask, listTasks, updateTask } from "./tasks.js";

/** 还没收工的：只在这些里面找同一件事，早就 done 的不该被一句话拽回来 */
const OPEN_STATES: TaskStatus[] = ["collected", "understood", "processing", "review", "blocked"];

/**
 * 「记一条待办」统一建成任务。
 * 原来写的是 todos 表，但启动器删掉之后那张表在界面上已经没有出口——写进去用户看不见。
 * 现在一律进 tasks，落在左栏「待办」分组里，来源靠 kind 区分。
 *
 * 注意 source 不要放 threadId：线程本身那条任务是靠 findTaskBySource(threadId) 找回来的，
 * 再挂一条同 threadId 的会让它匹配到哪条变得不确定。线程派生的待办用 fromTaskId 关联。
 */
export function addNoteTask(input: {
  text: string;
  due?: string;
  source?: TaskSource;
  kind?: TaskKind;
  project?: string;
  /** 要写代码的活给 "todo"，纯提醒不给——没有 stage 的任务在板上不进阶段分组，也不吃阶段推进信号 */
  stage?: Stage;
  understanding?: string;
}): Task {
  const text = input.text.trim();
  const title = text.length > 80 ? `${text.slice(0, 79)}…` : text;
  // 先看这件事是不是已经在板上了。口头交代常常是对已有工单的补充
  //（「养牛 1.1 那个下拉框也有问题」），无脑新建会让同一件事在列表里出现两遍。
  const existing = findSameThing(text);
  if (existing) {
    const note = existing.understanding ? `${existing.understanding}\n\n又交代：${text}` : text;
    const t = updateTask(existing.id, {
      understanding: note.slice(0, 4000),
      ...(input.due ? { due: input.due } : {}),
      ...(input.project && !existing.project ? { project: input.project } : {}),
    });
    if (t) return t;
  }
  return createTask({
    title,
    kind: input.kind ?? "verbal",
    source: input.source ?? {},
    status: "understood",
    // 标题截断过就把全文留在理解里，免得长待办看不到后半句
    ...(input.understanding ? { understanding: input.understanding } : title === text ? {} : { understanding: text }),
    ...(input.due ? { due: input.due } : {}),
    ...(input.project ? { project: input.project } : {}),
    ...(input.stage ? { stage: input.stage } : {}),
  });
}

/**
 * 这句话说的是不是板上已有的某件事。只认硬线索，宁可漏不可错——
 * 挂错地方比多建一条更难发现，而多建一条你一眼就看得出来。
 *
 * ① 话里带工单号，板上正好有那条工单 → 就是它
 * ② 话里带项目名 / 别名，再加一个跟已有任务重合的长关键词 → 同一件事
 */
export function findSameThing(text: string, tasks = listTasks(OPEN_STATES)): Task | undefined {
  const ids = meegleIdsIn(text);
  if (ids.length) {
    const byTicket = tasks.find((t) => ids.includes(t.source.meegleId ?? "") || ids.includes(t.source.linkedStoryId ?? ""));
    if (byTicket) return byTicket;
  }
  const named = loadProjects().find((p) => text.includes(p.name) || p.aliases.some((a) => a.length >= 2 && text.includes(a)));
  if (!named) return undefined;
  // 项目名和别名本身不算线索：它已经用来定项目了，再拿它比对等于「提到这个项目
  // 就算同一件事」，板上随便哪条都能命中
  const noise = [named.name, ...named.aliases];
  const said = grams(text, noise);
  if (!said.size) return undefined;
  return tasks.find((t) => t.project === named.name && overlap(said, grams(t.title, noise)));
}

/**
 * 中文没有词边界，按 4 字滑窗切片来比对：「多级标题配置回滚」和「多级标题回滚方案」
 * 共享「多级标题」这一片。英文和路径按整词切。
 */
function grams(text: string, noise: string[]): Set<string> {
  let s = text.toLowerCase();
  for (const n of noise) s = s.split(n.toLowerCase()).join(" ");
  const out = new Set<string>();
  for (const w of s.match(/[A-Za-z][\w./-]{4,}/g) ?? []) out.add(w);
  for (const run of s.match(/[一-龥]{4,}/g) ?? []) {
    for (let i = 0; i + 4 <= run.length; i += 1) out.add(run.slice(i, i + 4));
  }
  return out;
}

/** 两片里有没有共同片段 */
function overlap(a: Set<string>, b: Set<string>): boolean {
  for (const x of b) if (a.has(x)) return true;
  return false;
}

/** 撤销「记一条待办」：标成 ignored 而不是物理删除，保留痕迹。 */
export function dropNoteTask(id: string): boolean {
  return Boolean(updateTask(id, { status: "ignored" }));
}

/**
 * 把 todos 表里还没搬过来的本地待办补成任务。
 * 启动器删掉之后 todos 写进去就没人看得见了，库里攒了几十条。全量搬会一次涌进左栏把
 * 真正在办的事淹掉，所以只搬最近 `days` 天的，更早的留在表里不动。
 */
export function migrateLocalTodos(days = 1, now = Date.now()): number {
  const since = new Date(now - days * 86_400_000).toISOString();
  const rows = db()
    .prepare("SELECT id, text, due FROM todos WHERE source = 'local' AND done = 0 AND created_at > ? ORDER BY created_at")
    .all(since) as Array<{ id: string; text: string; due: string | null }>;
  if (!rows.length) return 0;
  // 同一句话在 todos 里可能重复写过好几遍，搬过去只留一条
  const seen = new Set(listTasks().map((t) => t.title));
  let n = 0;
  for (const r of rows) {
    const text = r.text.trim();
    const title = text.length > 80 ? `${text.slice(0, 79)}…` : text;
    if (!text || seen.has(title)) continue;
    seen.add(title);
    addNoteTask({ text, ...(r.due ? { due: r.due } : {}) });
    // 搬过来的标记成已完成，免得下次启动又搬一遍
    db().prepare("UPDATE todos SET done = 1 WHERE id = ?").run(r.id);
    n += 1;
  }
  return n;
}
