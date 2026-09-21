import type { Task } from "@friday/shared";
import { askStream, SONNET_MODEL } from "./claude.js";
import { config } from "../config.js";
import { loadProjects, projectDetail, type Project } from "../memory/projects.js";

/**
 * 新工单进来先过一道：能自己动手的直接开终端，缺项目归属的问用户一句，
 * 其余照常排队。判断依据要写清楚——用户事后要能看出它凭什么开的工。
 */
export type Intake =
  | { kind: "start"; project: string; detail: string; why: string; confidence: number }
  | { kind: "ask"; question: string; why: string }
  | { kind: "queue"; why: string };

/** 剥掉噪音之后的正文短于这个长度，就别指望能照着开工了。 */
export const MIN_DETAIL = 20;

/**
 * Meegle 的描述里混着图片元数据、HTML 标签、飞书 linkPreview 标记，
 * 按原始长度量会把「只有一张截图」的工单当成有内容。先剥干净再量。
 */
export function plainBody(description: string): string {
  return description
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/image:\{[^}]*\}/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[[\]()&;#]|linkPreview|nbsp/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function intakePrompt(
  task: Pick<Task, "title" | "understanding" | "project">,
  description: string,
  projects: Project[],
): { system: string; prompt: string } {
  const registry = projects
    .map((p) => {
      const detail = projectDetail(p);
      return `- ${p.name}${p.aliases.length ? `（别名：${p.aliases.join("、")}）` : ""}${detail ? ` — ${detail.replace(/\n/g, "；")}` : ""}`;
    })
    .join("\n");
  return {
    system: [
      "你在判断一条 Meegle 工单能不能直接交给终端里的 Claude Code 去做。用户是前端工程师，这些工单大多是他要改的后台页面。",
      "输出三选一：",
      '- {"kind":"start","project":"项目名","detail":"交给 Claude Code 的一段话","confidence":0-100,"why":"一句话依据"}：问题说得够具体（改哪个页面、什么现象或什么要求），而且能对上注册表里的某个项目。detail 要把工单里的现象、复现步骤、页面链接原样带上，不要压缩成一句话。',
      "confidence 是「让 Claude Code 照这段描述去改，一次就能改对」的把握，要如实给：现象、复现步骤、涉及页面都写清楚了才给 80 以上；只能从标题推断的给 50 上下；拿不准宁可给低。它会和用户设的阈值比，给虚了会让用户白白收一堆改错的交付。",
      '- {"kind":"ask","question":"要问用户的一句话","why":"一句话依据"}：只缺一个具体信息就能开工时用它，最常见的是归不到项目。question 要问得用户一句话能答，比如「这条工单是哪个项目的？」，不要问「要不要开工」。',
      '- {"kind":"queue","why":"一句话依据"}：描述太模糊、要先对齐方案、或者明显该由人先判断的，就排队不动。',
      "宁可 queue 也不要硬猜：开错项目会在错的仓库里改代码。需求类（story）除非描述里已经把要做什么写死了，否则一律 queue——需求通常要先对方案。",
      registry ? `项目注册表：\n${registry}` : "项目注册表为空。",
      "只输出一个 JSON 对象，不要其他文字。",
    ].join("\n"),
    prompt: [
      `标题：${task.title}`,
      task.project ? `已归到项目：${task.project}` : "还没归到项目",
      task.understanding ? `工单信息：${task.understanding}` : "",
      // 原文里的 HTML 和图片元数据没有信息量，剥掉再送，省 token 也少干扰
      plainBody(description) ? `工单描述：\n${plainBody(description).slice(0, 3000)}` : "（工单没有描述正文，只有截图或链接）",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

export function parseIntake(text: string, projects: Project[]): Intake {
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  if (!json) return { kind: "queue", why: "判断结果解析不出来" };
  try {
    const r = JSON.parse(json) as { kind?: string; project?: string; detail?: string; question?: string; why?: string; confidence?: unknown };
    const why = (r.why ?? "").slice(0, 200);
    if (r.kind === "start") {
      // 项目名必须真的在注册表里，不然后面 resolveProject 会落空
      const hit = projects.find((p) => p.name === r.project);
      if (!hit) return { kind: "queue", why: `说是 ${r.project ?? "?"} 但注册表里没有这个项目` };
      if (!r.detail?.trim()) return { kind: "queue", why: "没给出能交给终端的任务描述" };
      // 没给置信度当 0：宁可落在阈值下面挂起等人点，也不要因为字段缺失就直接开工
      const confidence = typeof r.confidence === "number" && Number.isFinite(r.confidence) ? Math.max(0, Math.min(100, Math.round(r.confidence))) : 0;
      return { kind: "start", project: hit.name, detail: r.detail.trim().slice(0, 4000), why, confidence };
    }
    if (r.kind === "ask" && r.question?.trim()) return { kind: "ask", question: r.question.trim().slice(0, 200), why };
    return { kind: "queue", why };
  } catch {
    return { kind: "queue", why: "判断结果不是合法 JSON" };
  }
}

/** 工单信息太少时不必花一次调用，直接排队。 */
export function tooThin(description: string, task: Pick<Task, "understanding">): boolean {
  return plainBody(`${description} ${task.understanding ?? ""}`).length < MIN_DETAIL;
}

export async function judgeIntake(
  task: Pick<Task, "title" | "understanding" | "project">,
  description: string,
  projects = loadProjects(),
): Promise<Intake> {
  if (tooThin(description, task)) return { kind: "queue", why: "工单描述太短，看不出要做什么" };
  const { system, prompt } = intakePrompt(task, description, projects);
  let text = "";
  try {
    for await (const ev of askStream(prompt, { systemPrompt: system, cwd: config.dataDir, model: SONNET_MODEL, label: "intake" })) {
      if (ev.type === "delta") text += ev.text;
      if (ev.type === "reset") text = "";
    }
  } catch (e) {
    return { kind: "queue", why: `判断失败：${e instanceof Error ? e.message : String(e)}` };
  }
  return parseIntake(text, projects);
}
