import { PLAYBOOK_CATEGORIES, RELAY_CATEGORY, type GateCategory, type Lesson, type LessonKind, type PlaybookCategory } from "@friday/shared";
import { GATE_CATEGORY_LABEL } from "@friday/shared";
import { getCursor, setCursor } from "../memory/inbox.js";
import { getThread, threadCategory } from "../memory/threads.js";
import type { Task } from "@friday/shared";
import { askStream } from "./claude.js";
import { untrusted } from "./fence.js";
import { TRIAGE_MODEL } from "./triage.js";
import { addLesson, listLessons } from "../memory/lessons.js";
import { readPlaybook, writePlaybook } from "../memory/playbooks.js";
import { record } from "../memory/audit.js";
import { config } from "../config.js";

/**
 * 值得从中学东西的人工处理。原来还有 approved / edited_approved / rejected / auto_undone，
 * 那几种都是围着「Friday 起草、你拍板」转的；草稿 2026-09-18 起不再生成，只剩你自己怎么做的。
 */
const LEARNED: LessonKind[] = ["ignored", "done_without_reply", "relayed_direct"];
export const REVIEW_KEY = "review:ran";

/** 喂给模型时用中文说清用户做了什么，英文枚举名它猜不准 */
const KIND_LABEL: Partial<Record<LessonKind, string>> = {
  ignored: "Friday 判要回，你直接忽略了",
  done_without_reply: "你自己回的",
  relayed_direct: "你自己敲进终端的，没让 Friday 转达",
};

const RELAY_SYSTEM = [
  "你在给一个私人助理写「怎么把活转给终端里的 Claude Code」的经验手册。",
  "背景：项目定下来之后，助理只做两件事——决定（哪个项目、要不要开工、这轮算不算完）和转发（把用户的话转给终端、把终端的话转给用户）。",
  "它没有项目的 skill，也没读过代码，所以绝不该自己推演改哪个文件、用什么方案。",
  "输入是用户绕过助理、自己敲进终端的那些话。每一条都说明这次助理没转到位：或者该转没转，或者转丢了关键信息，或者自作主张改写了原话。",
  "从这些话里提炼规则：哪些该原样转、原话里哪些东西不能丢（报错、路径、工单号、对方的原措辞）、什么时候该主动问用户要不要转。",
  "只输出 Markdown，结构固定为三节：## 怎么转 / ## 不能丢的东西 / ## 反例。每条一行，不超过 40 字。",
].join("\n");

const TRIAGE_SYSTEM = [
  "你在给一个私人助理写「这类 Slack 消息该怎么判」的经验手册。",
  "助理的活是备料不是代劳：读懂对方要什么、判断要不要用户本人回、急不急，把事实摆给用户看。它不起草回复。",
  "输入是它判过的消息和用户实际怎么处置的。「直接忽略」说明它判错了——这类根本不需要用户回；「你自己回的」说明判断对了但卡片没帮上忙。",
  "提炼判断规则：哪类消息其实不用回、哪类看着急其实不急、哪类必须当天处理、情境卡要把什么写清楚用户才敢下判断。",
  "只输出 Markdown，结构固定为三节：## 怎么判 / ## 情境卡要写清楚什么 / ## 反例。每条一行，不超过 40 字。",
].join("\n");

export async function distill(category: PlaybookCategory): Promise<boolean> {
  const lessons = listLessons(category, 100);
  if (!lessons.length) return false;
  // 真正调 Claude 那步在测试里跳过：判定逻辑（该不该复盘、游标推不推进）才是要守的
  if (process.env.VITEST) return true;
  const relay = category === RELAY_CATEGORY;
  const system = relay ? RELAY_SYSTEM : TRIAGE_SYSTEM;
  const heading = relay ? "## 怎么转" : "## 怎么判";
  const body = [
    readPlaybook(category) ? `现有手册：\n${readPlaybook(category)}` : "还没有手册。",
    ...lessons.map((l) =>
      relay
        ? `- 用户自己敲的：${untrusted("terminal", l.final ?? "（无）")}`
        : `- [${KIND_LABEL[l.kind] ?? l.kind}] ${untrusted("friday-lesson", l.draft || l.final || "（无）")}${l.feedback ? `｜反馈：${l.feedback}` : ""}`,
    ),
  ].join("\n");
  let text = "";
  for await (const ev of askStream(body, { systemPrompt: system, cwd: config.dataDir, model: TRIAGE_MODEL, label: "review" })) {
    if (ev.type === "delta") text += ev.text;
    if (ev.type === "reset") text = "";
  }
  const md = text.trim();
  if (!md.includes(heading)) return false;
  writePlaybook(category, `# ${GATE_CATEGORY_LABEL[category]}\n\n${md}\n`);
  record({ action: "playbook_distilled", why: `${category} 攒了新的人工处理`, how: "Sonnet 重写了这一类的手册", evidence: { category, lessons: lessons.length }, risk: "reversible" });
  return true;
}

export function recordLesson(input: { taskId?: string; category: GateCategory; kind: LessonKind; draft?: string; final?: string; feedback?: string }): Lesson {
  return addLesson({ ...input, confidence: 0 });
}

/**
 * 你怎么处置这条任务：忽略了、自己回了。
 * Friday 判「需要你回」而你没回，就是它这类消息判得不准——这是最强的负信号。
 */
export function lessonFromTask(t: Task, kind: LessonKind): Lesson | undefined {
  const thread = t.source.threadId ? getThread(t.source.threadId) : undefined;
  // 只学它判过「需要你回」的：没判断过就谈不上判得准不准
  if (!thread?.brief?.needsReply) return undefined;
  return recordLesson({
    taskId: t.id,
    category: threadCategory(thread),
    kind,
    draft: `${thread.brief.situation}｜需要你：${thread.brief.needs}`,
  });
}

/** 短于这个的多半是 y / yes / 1 这类应答键，不是「用户自己组织了一句话」，学不出东西 */
export const RELAY_MIN_CHARS = 8;

/**
 * 你自己往终端里敲了一句，而不是让 Friday 转达。
 * Friday 在项目明确之后的活就是转发，你绕过它说明这次它转得不对、不够快，或者根本没想到要转。
 * 学的是「怎么转」，不是「怎么改代码」——后者是终端的事。
 */
export function lessonFromRelay(taskId: string | undefined, typed: string): Lesson | undefined {
  const text = typed.replace(/\r/g, "").trim();
  if (text.length < RELAY_MIN_CHARS) return undefined;
  return recordLesson({ ...(taskId ? { taskId } : {}), category: RELAY_CATEGORY, kind: "relayed_direct", final: text.slice(0, 500) });
}

export const reviewState = { lastRunAt: null as string | null, lastError: null as string | null, running: false };

export type ReviewResult = { skipped: string } | { categories: PlaybookCategory[] };

/**
 * 复盘一次人工处理：哪些类别攒了新的干预就重写哪份手册。
 * 学的是「你怎么处理的」，产物是下次判得更准，不建任务、不进待办列表。
 *
 * 2026-09-18 起只由你触发（会话里说「复盘一下」、设置页按钮、POST /tasks/review），
 * 不再每天自动跑——这些上下文按需加载，不定时烧钱。
 */
export async function reviewOnce(): Promise<ReviewResult> {
  if (reviewState.running) return { skipped: "正在复盘，稍等" };
  const since = getCursor(REVIEW_KEY);
  const pending = PLAYBOOK_CATEGORIES.filter((c) => listLessons(c, 100).some((l) => LEARNED.includes(l.kind) && (!since || l.createdAt > since)));
  if (!pending.length) {
    setCursor(REVIEW_KEY, new Date().toISOString());
    return { skipped: "这段时间没有新的人工处理可学" };
  }
  reviewState.running = true;
  try {
    const done: PlaybookCategory[] = [];
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
