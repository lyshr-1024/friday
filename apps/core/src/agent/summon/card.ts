import type { PendingActionType, Snapshot, SummonAction, SummonCard, SummonRules } from "@friday/shared";
import { askStream } from "../claude.js";
import { untrusted, UNTRUSTED_NOTE } from "../fence.js";
import { config } from "../../config.js";
import type { Candidate } from "./match.js";

export const SUMMON_MODEL = "claude-sonnet-5";
// 呼出是「随手一按」的场景，模型再慢用户早就走了；不设上限的话
// 连按几次热键会堆起多个并发 Sonnet 调用，各自烧钱且没人收。
const SUMMON_TIMEOUT_MS = 20_000;

export interface CardInput {
  snapshot: Snapshot;
  rules: SummonRules;
  candidates: Candidate[];
  /** M2 的活动轨迹，M1 恒为 undefined */
  recent?: string;
  signal?: AbortSignal;
}

export interface AllowedIds {
  taskIds: string[];
  /** key 是 taskId，值是该任务下允许的 pending：actionId → 类型。类型取自真实任务数据，模型伪造不了 */
  actionIds: Record<string, Record<string, PendingActionType>>;
  projects: string[];
}

const KINDS = ["open_task", "approve_pending", "start_work", "create_task", "mark_done", "note", "copy"] as const;

export function cardPrompt(input: CardInput): { system: string; prompt: string } {
  const { snapshot, candidates, recent } = input;
  const system = [
    "你是 Friday 的呼出判断。用户此刻正在某个 app 里工作，按了热键叫你。你要说清这是什么事、和他哪条任务有关、下一步做什么。",
    "用户照旧在 Slack / Meegle / 终端里干活，你不替他决定回不回消息，只告诉他这件事对应哪条任务、进展到哪、可以做什么。",
    "判断要短：verdict 一到两句中文，不要复述你看到的内容，直接给结论。",
    `只能用这几种动作：${KINDS.join(" / ")}。taskId、actionId、project 只能用下面给出的值，不能自己编。最多 3 个动作。`,
    UNTRUSTED_NOTE,
    'Slack 场景可以给 reply 草稿（用户身份，中文，不要承诺工期和人力）。只输出一个 JSON 对象：{"verdict":"","reply":"","actions":[],"matchTaskId":""}。',
  ].join("\n");

  const context = [
    `app：${snapshot.app.name}${snapshot.app.title ? `，标题：${snapshot.app.title}` : ""}`,
    snapshot.browser ? `网址：${snapshot.browser.url}，标题：${snapshot.browser.title}` : "",
    snapshot.selection ? `选中的文字：${snapshot.selection.slice(0, 4000)}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const taskList = candidates
    .slice(0, 5)
    .map((c) => {
      const t = c.task;
      const pending = t.pending?.map((p) => `待审动作 ${p.id}：${p.label}`).join("；") ?? "";
      return [
        `- 任务 ${t.id}：${t.title}（${t.status}${t.project ? ` · ${t.project}` : ""}）理由：${c.why}`,
        t.progress ? `  进展：${t.progress.slice(0, 200)}` : "",
        pending ? `  ${pending}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");

  const prompt = [
    untrusted("用户此刻在做什么", context),
    recent ? `最近的活动：\n${recent}` : "",
    candidates.length ? untrusted("可能相关的任务", taskList) : "没有对上任何任务。",
  ]
    .filter(Boolean)
    .join("\n");

  return { system, prompt };
}

function clampAction(raw: unknown, allowed: AllowedIds): SummonAction | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const a = raw as Record<string, unknown>;
  const kind = a.kind;
  const label = typeof a.label === "string" ? a.label.slice(0, 20) : "";
  if (!label || typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) return undefined;
  const taskId = typeof a.taskId === "string" ? a.taskId : "";
  const text = typeof a.text === "string" ? a.text.slice(0, 2000) : "";
  switch (kind) {
    case "open_task":
    case "mark_done":
      return allowed.taskIds.includes(taskId) ? ({ kind, label, taskId } as SummonAction) : undefined;
    case "approve_pending": {
      const actionId = typeof a.actionId === "string" ? a.actionId : "";
      const pendingType = allowed.actionIds[taskId]?.[actionId];
      return pendingType ? { kind, label, taskId, actionId, pendingType } : undefined;
    }
    case "start_work": {
      const project = typeof a.project === "string" ? a.project : "";
      const p = typeof a.prompt === "string" ? a.prompt.slice(0, 2000) : "";
      return allowed.projects.includes(project) && p ? { kind, label, project, prompt: p } : undefined;
    }
    case "create_task": {
      const title = typeof a.title === "string" ? a.title.slice(0, 200) : "";
      return title ? { kind, label, title } : undefined;
    }
    case "note":
      return text ? { kind, label, text } : undefined;
    case "copy":
      return text ? { kind, label, text } : undefined;
    default:
      return undefined;
  }
}

/** 从第一个 { 开始数括号深度，找到与它配对的 }；比贪婪正则更抗「JSON 后面还有花括号说明文字」 */
function firstBalancedObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return undefined;
}

function extractJson(text: string): string | undefined {
  const trimmed = text.trim();
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // 模型输出常带 markdown 围栏或前后解释文字，退到括号配对兜底
  }
  return firstBalancedObject(trimmed);
}

export function parseCard(text: string, allowed: AllowedIds): SummonCard {
  const json = extractJson(text);
  if (!json) return { verdict: "", actions: [] };
  try {
    const row = JSON.parse(json) as Record<string, unknown>;
    const actions = Array.isArray(row.actions)
      ? row.actions
          .map((a) => clampAction(a, allowed))
          .filter((a): a is SummonAction => Boolean(a))
          .slice(0, 3)
      : [];
    const matchTaskId = typeof row.matchTaskId === "string" && allowed.taskIds.includes(row.matchTaskId) ? row.matchTaskId : undefined;
    const reply = typeof row.reply === "string" && row.reply.trim() ? row.reply.slice(0, 2000) : undefined;
    return {
      verdict: typeof row.verdict === "string" ? row.verdict.slice(0, 400) : "",
      actions,
      ...(reply ? { reply } : {}),
      ...(matchTaskId ? { matchTaskId } : {}),
    };
  } catch {
    return { verdict: "", actions: [] };
  }
}

export async function summonCard(input: CardInput): Promise<SummonCard> {
  const allowed: AllowedIds = {
    taskIds: input.candidates.map((c) => c.task.id),
    actionIds: Object.fromEntries(
      input.candidates.map((c) => [c.task.id, Object.fromEntries((c.task.pending ?? []).map((p) => [p.id, p.type]))]),
    ),
    projects: [...new Set(input.candidates.map((c) => c.task.project).filter((p): p is string => Boolean(p)))],
  };
  const { system, prompt } = cardPrompt(input);
  const ctrl = new AbortController();
  if (input.signal) input.signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  const timer = setTimeout(() => ctrl.abort(), SUMMON_TIMEOUT_MS);
  let out = "";
  try {
    for await (const ev of askStream(prompt, { systemPrompt: system, cwd: config.dataDir, model: SUMMON_MODEL, label: "summon", signal: ctrl.signal })) {
      if (ev.type === "delta") out += ev.text;
      if (ev.type === "reset") out = "";
    }
  } finally {
    clearTimeout(timer);
  }
  return parseCard(out, allowed);
}
