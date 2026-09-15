import type { Lesson, LessonKind, ReplyCategory } from "@friday/shared";
import { REPLY_CATEGORY_LABEL } from "@friday/shared";
import { backoff } from "./gate.js";
import { askStream } from "./claude.js";
import { TRIAGE_MODEL } from "./triage.js";
import { addLesson, countSince, listLessons } from "../memory/lessons.js";
import { getThreshold, setThreshold } from "../memory/thresholds.js";
import { readPlaybook, writePlaybook } from "../memory/playbooks.js";
import { record } from "../memory/audit.js";
import { config } from "../config.js";

export const DISTILL_EVERY = 5;
const LEARNED: LessonKind[] = ["edited_approved", "rejected", "auto_undone"];

export async function distill(category: ReplyCategory): Promise<boolean> {
  const lessons = listLessons(category, 100);
  if (!lessons.length) return false;
  const system = [
    "你在给一个私人助理写「怎么回这类 Slack 消息」的经验手册。",
    "输入是助理起草、用户最终改成什么样、以及被打回的理由。请提炼成可执行的规则，不要复述个例。",
    "只输出 Markdown，结构固定为三节：## 怎么回 / ## 注意事项 / ## 反例。每条一行，不超过 40 字。",
  ].join("\n");
  const body = [
    readPlaybook(category) ? `现有手册：\n${readPlaybook(category)}` : "还没有手册。",
    ...lessons.map((l) => `- [${l.kind}] 草稿：${l.draft ?? "（无）"}｜终稿：${l.final ?? "（无）"}｜反馈：${l.feedback ?? "（无）"}`),
  ].join("\n");
  let text = "";
  for await (const ev of askStream(body, { systemPrompt: system, cwd: config.dataDir, model: TRIAGE_MODEL })) {
    if (ev.type === "delta") text += ev.text;
    if (ev.type === "reset") text = "";
  }
  const md = text.trim();
  if (!md.includes("## 怎么回")) return false;
  writePlaybook(category, `# ${REPLY_CATEGORY_LABEL[category]}\n\n${md}\n`);
  record({ action: "playbook_distilled", why: `${category} 攒够 ${DISTILL_EVERY} 条新经验`, how: "Sonnet 重写了这一类的手册", evidence: { category, lessons: lessons.length }, risk: "reversible" });
  return true;
}

export function shouldDistill(category: ReplyCategory, kind: LessonKind): boolean {
  return LEARNED.includes(kind) && countSince(category, LEARNED) % DISTILL_EVERY === 0;
}

export function recordLesson(input: { taskId?: string; category: ReplyCategory; kind: LessonKind; draft?: string; final?: string; feedback?: string; confidence: number }): Lesson {
  const lesson = addLesson(input);
  if (input.kind === "rejected" || input.kind === "auto_undone") {
    const before = getThreshold(input.category);
    const after = backoff(before, input.kind);
    if (after !== before) {
      setThreshold(input.category, after);
      record({
        ...(input.taskId ? { taskId: input.taskId } : {}),
        action: "threshold_raised",
        why: input.kind === "auto_undone" ? "自动回复被你撤回" : "你打回了",
        how: `${input.category} 阈值 ${before} → ${after}`,
        evidence: { category: input.category, before, after },
        risk: "reversible",
      });
    }
  }
  if (!process.env.VITEST && shouldDistill(input.category, input.kind)) {
    void distill(input.category).catch((e) => console.error(`[learn] 提炼 ${input.category} 失败：${e instanceof Error ? e.message : String(e)}`));
  }
  return lesson;
}
