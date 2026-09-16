import { AUTOSTART_CATEGORY, REPLY_CATEGORIES, type GateCategory, type Lesson, type LessonKind, type ReplyCategory } from "@friday/shared";
import { REPLY_CATEGORY_LABEL } from "@friday/shared";
import { getCursor, setCursor } from "../memory/inbox.js";
import { getThread, threadCategory } from "../memory/threads.js";
import type { Task } from "@friday/shared";
import { backoff } from "./gate.js";
import { askStream } from "./claude.js";
import { TRIAGE_MODEL } from "./triage.js";
import { addLesson, countSince, listLessons } from "../memory/lessons.js";
import { getThreshold, setThreshold } from "../memory/thresholds.js";
import { readPlaybook, writePlaybook } from "../memory/playbooks.js";
import { record } from "../memory/audit.js";
import { config } from "../config.js";
import { userSettings } from "../settings.js";

export const DISTILL_EVERY = 5;
/** 值得从中学东西的人工处理：用户改了、打回了、撤回了、直接忽略了、自己回了 —— 只有原样通过没什么可学 */
const LEARNED: LessonKind[] = ["edited_approved", "rejected", "auto_undone", "ignored", "done_without_reply"];
export const REVIEW_KEY = "review:ran";
/** 每天复盘一次：一天内的人工处理攒不出新规律，跑多了只是重复烧钱 */
export const REVIEW_EVERY_DAYS = 1;

/** 喂给模型时用中文说清用户做了什么，英文枚举名它猜不准 */
const KIND_LABEL: Record<LessonKind, string> = {
  approved: "原样发出",
  edited_approved: "改了再发",
  rejected: "打回不发",
  auto_undone: "自动发出后被撤回",
  ignored: "直接忽略，根本没回",
  done_without_reply: "用户自己回的，没用草稿",
};

export async function distill(category: ReplyCategory): Promise<boolean> {
  const lessons = listLessons(category, 100);
  if (!lessons.length) return false;
  const system = [
    "你在给一个私人助理写「怎么回这类 Slack 消息」的经验手册。",
    "输入是助理起草的草稿、用户最终怎么处理的（改成什么样 / 打回的理由 / 直接忽略没回 / 用户自己回了没用草稿），请提炼成可执行的规则，不要复述个例。",
    "被忽略和用户自己回的那些尤其要看：说明助理这类消息判断有偏差，手册里要写清楚什么时候根本不该起草回复。",
    "只输出 Markdown，结构固定为三节：## 怎么回 / ## 注意事项 / ## 反例。每条一行，不超过 40 字。",
  ].join("\n");
  const body = [
    readPlaybook(category) ? `现有手册：\n${readPlaybook(category)}` : "还没有手册。",
    ...lessons.map((l) => `- [${KIND_LABEL[l.kind]}] 草稿：${l.draft ?? "（无）"}｜终稿：${l.final ?? "（无）"}｜反馈：${l.feedback ?? "（无）"}`),
  ].join("\n");
  let text = "";
  for await (const ev of askStream(body, { systemPrompt: system, cwd: config.dataDir, model: TRIAGE_MODEL, label: "review" })) {
    if (ev.type === "delta") text += ev.text;
    if (ev.type === "reset") text = "";
  }
  const md = text.trim();
  if (!md.includes("## 怎么回")) return false;
  writePlaybook(category, `# ${REPLY_CATEGORY_LABEL[category]}\n\n${md}\n`);
  record({ action: "playbook_distilled", why: `${category} 攒够 ${DISTILL_EVERY} 条新经验`, how: "Sonnet 重写了这一类的手册", evidence: { category, lessons: lessons.length }, risk: "reversible" });
  return true;
}

export function shouldDistill(category: GateCategory, kind: LessonKind): boolean {
  // 开工没有回复 playbook 可蒸馏，只借用阈值校准那一半
  if (category === AUTOSTART_CATEGORY) return false;
  return LEARNED.includes(kind) && countSince(category, LEARNED) % DISTILL_EVERY === 0;
}

const BACKOFF_WHY: Partial<Record<LessonKind, string>> = {
  auto_undone: "自动回复被你撤回",
  rejected: "你打回了",
  ignored: "Friday 判断要回，你直接忽略了",
  done_without_reply: "你自己回的，没用 Friday 的草稿",
};

export function recordLesson(input: { taskId?: string; category: GateCategory; kind: LessonKind; draft?: string; final?: string; feedback?: string; confidence: number }): Lesson {
  const lesson = addLesson(input);
  // 正信号（原样通过 / 改一改就发）不动阈值，其余都是「这条判得不对」，往上抬
  if (input.kind !== "approved" && input.kind !== "edited_approved") {
    const before = getThreshold(input.category);
    const after = backoff(before, input.kind);
    if (after !== before) {
      setThreshold(input.category, after);
      record({
        ...(input.taskId ? { taskId: input.taskId } : {}),
        action: "threshold_raised",
        why: BACKOFF_WHY[input.kind] ?? "你没按 Friday 的草稿处理",
        how: `${input.category} 阈值 ${before} → ${after}`,
        evidence: { category: input.category, before, after },
        risk: "reversible",
      });
    }
  }
  if (!process.env.VITEST && shouldDistill(input.category, input.kind)) {
    void distill(input.category as ReplyCategory).catch((e) => console.error(`[learn] 提炼 ${input.category} 失败：${e instanceof Error ? e.message : String(e)}`));
  }
  return lesson;
}

/**
 * 你没按 Friday 的草稿处理也是一次人工处理，记成经验去校准阈值：
 * 直接忽略、自己回了、在会话里说不用回，都说明它这类消息判断有偏差。
 * 只认回复类草稿，git_merge 这类审核动作跟对话质量无关。
 */
export function lessonFromTask(t: Task, kind: LessonKind, final?: string): Lesson | undefined {
  const draft = t.pending?.find((p) => p.type === "slack_reply");
  if (!draft) return undefined;
  const thread = t.source.threadId ? getThread(t.source.threadId) : undefined;
  return recordLesson({
    taskId: t.id,
    category: thread ? threadCategory(thread) : "other",
    kind,
    draft: String(draft.payload.text ?? draft.detail ?? ""),
    ...(final ? { final } : {}),
    confidence: thread?.brief?.confidence ?? 0,
  });
}

/** 该复盘了没。跟 historyDue 一个思路：只看离上次跑过了多久，机器关着也不会整天漏掉。 */
export function reviewDue(lastRanIso: string | undefined, now = Date.now()): boolean {
  if (!lastRanIso) return true;
  const last = Date.parse(lastRanIso);
  return Number.isNaN(last) || now - last >= REVIEW_EVERY_DAYS * 86_400_000;
}

export const reviewState = { lastRunAt: null as string | null, lastError: null as string | null, running: false };

export type ReviewResult = { skipped: string } | { categories: ReplyCategory[] };

/**
 * 复盘一次人工处理：哪些类别攒了新的干预就重写哪份手册。
 * 学的是「你怎么处理的」，产物是下次草稿更准，不建任务、不进待办列表。
 */
export async function reviewOnce(manual = false): Promise<ReviewResult> {
  if (reviewState.running) return { skipped: "正在复盘，稍等" };
  if (!manual && !userSettings().learn) return { skipped: "自动复盘已在设置里关掉" };
  const since = getCursor(REVIEW_KEY);
  const pending = REPLY_CATEGORIES.filter((c) => listLessons(c, 100).some((l) => LEARNED.includes(l.kind) && (!since || l.createdAt > since)));
  if (!pending.length) {
    setCursor(REVIEW_KEY, new Date().toISOString());
    return { skipped: "这段时间没有新的人工处理可学" };
  }
  reviewState.running = true;
  try {
    const done: ReplyCategory[] = [];
    for (const c of pending) if (await distill(c)) done.push(c);
    reviewState.lastRunAt = new Date().toISOString();
    reviewState.lastError = null;
    setCursor(REVIEW_KEY, reviewState.lastRunAt);
    record({ action: "reviewed", why: "复盘你最近的人工处理", how: `重写了 ${done.length} 份手册：${done.join("、") || "无"}`, evidence: { categories: done }, risk: "reversible" });
    return { categories: done };
  } catch (e) {
    reviewState.lastError = e instanceof Error ? e.message : String(e);
    console.error(`[review] ${reviewState.lastError}`);
    return { skipped: `出错：${reviewState.lastError}` };
  } finally {
    reviewState.running = false;
  }
}
