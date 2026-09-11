import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "@friday/shared";
import { askStream } from "./claude.js";
import { recentCommits } from "./git.js";
import { config } from "../config.js";
import { record } from "../memory/audit.js";
import { expandHome, loadProjects, type Project } from "../memory/projects.js";
import { createTask, listTasks } from "../memory/tasks.js";
import { listThreads } from "../memory/threads.js";
import { state } from "../scheduler/index.js";
import { userSettings } from "../settings.js";

export const LEARN_MODEL = "claude-sonnet-5";
export const RESEARCH_DIR = "research";
/** 每天这个点（Asia/Shanghai）之后，当天还没学过就学一题 */
export const LEARN_HOUR = 8;
const DAYS = 7;

export const learnState = { lastRunAt: null as string | null, lastError: null as string | null, running: false };

export interface Material {
  tasks: string[];
  commits: string[];
  threads: string[];
  projects: Project[];
  /** 已研究过 / 用户说不感兴趣的题，选题绕开 */
  done: string[];
}

export interface Pick {
  topic: string;
  project?: string;
  why: string;
}

export interface Research {
  title: string;
  why: string;
  suggestions: string;
  markdown: string;
}

export type LearnResult = { skipped: string } | { taskId: string; title: string; file: string };

export function shanghaiDate(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export function shanghaiHour(d = new Date()): number {
  return Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: "Asia/Shanghai" }).format(d)) % 24;
}

/** 该学了没。文件名以上海日期开头，最新那个就是上次学的日子。
    机器常关着，所以不看「是不是 8 点这一刻」，只看「离上次学过了多久」：
    今天学过就不再学；隔一天等到 LEARN_HOUR；隔两天以上说明中间关过机，开机就补。
    只补当天一题，不追补积压的多天。 */
export function learnDue(files: string[], now = new Date()): boolean {
  const today = shanghaiDate(now);
  const last = files.map((f) => f.slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().pop();
  if (last === today) return false;
  if (!last) return shanghaiHour(now) >= LEARN_HOUR;
  const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${last}T00:00:00Z`)) / 86_400_000);
  // 隔了两天以上说明中间关过机，不必等到 LEARN_HOUR，开机就补一题
  return days >= 2 || shanghaiHour(now) >= LEARN_HOUR;
}

export function researchFiles(): string[] {
  try {
    return readdirSync(join(config.dataDir, RESEARCH_DIR)).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }
}

/** 读一份研究笔记全文（记忆库相对路径） */
export function readResearchNote(rel: string): string {
  try {
    return readFileSync(join(config.dataDir, rel), "utf8");
  } catch {
    return "";
  }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export async function gatherMaterial(days = DAYS): Promise<Material> {
  const since = Date.now() - days * 86_400_000;
  const projects = loadProjects();
  const recent = listTasks(undefined, 300).filter((t) => t.kind !== "learn" && new Date(t.updatedAt).getTime() >= since);
  const tasks = recent.map((t) => `- [${t.kind}${t.project ? ` · ${t.project}` : ""}] ${t.title}${t.understanding ? `：${clip(t.understanding, 120)}` : ""}`);
  const threads = listThreads("all", 40)
    .filter((t) => new Date(t.lastTs).getTime() >= since && t.brief)
    .map((t) => `- ${t.userName}${t.project ? `（${t.project}）` : ""}：${clip(t.brief!.situation, 120)}`);
  const commits = (
    await Promise.all(
      projects
        .filter((p) => existsSync(expandHome(p.dir)))
        .map(async (p) => (await recentCommits(expandHome(p.dir), days, 15)).map((c) => `- [${p.name}] ${c}`)),
    )
  ).flat();
  const done = [
    ...researchFiles().map((f) => f.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/\.md$/, "")),
    ...listTasks(["ignored", "done", "understood", "processing", "review"], 300)
      .filter((t) => t.kind === "learn")
      .map((t) => t.title),
  ];
  return { tasks, commits, threads, projects, done };
}

export function hasMaterial(m: Material): boolean {
  return m.tasks.length + m.commits.length + m.threads.length > 0;
}

export function pickPrompt(m: Material): { system: string; prompt: string } {
  const registry = m.projects.map((p) => `- ${p.name}${p.note ? `：${p.note}` : ""}`).join("\n");
  return {
    system: [
      "你是 Friday，用户的专属工程助理。你每天自学一题：从用户最近 7 天真正在忙的事里，挑一个值得去社区研究的具体问题，之后会去搜资料、给这个项目提可落地的建议。",
      "选题标准：和用户手头某个项目的当前工作直接相关；有社区经验可借鉴（交互设计、产品做法、工程实践、性能、可维护性）；够具体，能在 15 分钟内搜清楚。不要选泛泛的“最佳实践”，不要重复已研究过或用户说不感兴趣的题。",
      registry ? `项目注册表：\n${registry}` : "",
      '只输出一个 JSON 对象：{"topic": "一句话题目（≤40 字）", "project": "项目名或空串", "why": "为什么现在研究它（≤60 字）"}。素材里实在没有值得研究的就输出 {"skip": "原因"}。',
    ]
      .filter(Boolean)
      .join("\n"),
    prompt: [
      m.tasks.length ? `最近的任务：\n${m.tasks.slice(0, 40).join("\n")}` : "",
      m.commits.length ? `最近的提交：\n${m.commits.slice(0, 60).join("\n")}` : "",
      m.threads.length ? `最近 Slack 上找用户的事：\n${m.threads.slice(0, 20).join("\n")}` : "",
      m.done.length ? `已研究过 / 不感兴趣的题（绕开）：\n${m.done.slice(-30).map((d) => `- ${d}`).join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}

export function parsePick(text: string): Pick | { skip: string } | undefined {
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  if (!json) return undefined;
  try {
    const row = JSON.parse(json) as { topic?: unknown; project?: unknown; why?: unknown; skip?: unknown };
    if (typeof row.skip === "string") return { skip: row.skip };
    if (typeof row.topic !== "string" || !row.topic.trim()) return undefined;
    return { topic: row.topic.trim().slice(0, 80), why: typeof row.why === "string" ? row.why.slice(0, 120) : "", ...(typeof row.project === "string" && row.project.trim() ? { project: row.project.trim() } : {}) };
  } catch {
    return undefined;
  }
}

export function researchPrompt(pick: Pick, m: Material): { system: string; prompt: string } {
  const project = m.projects.find((p) => p.name === pick.project);
  return {
    system: [
      "你是 Friday，用户的专属工程助理，正在做当天的自学：围绕一个具体问题去社区找好做法，然后给用户手头的项目提具体建议。用 WebSearch / WebFetch 查资料，优先近两年的一手来源（官方文档、知名产品的做法、有代码或截图的文章），至少看 3 个来源。",
      "最后只输出一份 Markdown，结构固定（标题必须是这几个）：",
      "# <题目，≤30 字>",
      "## 为什么现在研究",
      "## 社区做法（3–5 条，每条：做法一句话 + 来源链接 + 发布年份）",
      "## 对手头项目的建议（具体到改哪一块、怎么改、先做哪条；不超过 5 条）",
      "## 不建议做的（及原因）",
      "不要寒暄，不要输出搜索过程；链接必须是你真正打开过的。",
    ].join("\n"),
    prompt: [
      `题目：${pick.topic}`,
      pick.why ? `为什么：${pick.why}` : "",
      project ? `项目：${project.name}${project.note ? `，${project.note}` : ""}，目录 ${project.dir}` : "",
      m.tasks.length ? `用户最近相关的事：\n${m.tasks.slice(0, 15).join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

function section(md: string, heading: string): string {
  const re = new RegExp(`^## ${heading}[^\\n]*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, "m");
  return re.exec(md)?.[1]?.trim() ?? "";
}

export function parseResearch(text: string, fallbackTitle: string): Research | undefined {
  const start = text.indexOf("# ");
  if (start < 0) return undefined;
  const markdown = text.slice(start).trim();
  const title = /^# (.+)$/m.exec(markdown)?.[1]?.trim() || fallbackTitle;
  const suggestions = section(markdown, "对手头项目的建议");
  if (!suggestions) return undefined;
  return { title: title.slice(0, 80), why: section(markdown, "为什么现在研究"), suggestions, markdown };
}

export function researchFileName(title: string, now = new Date()): string {
  const slug = title.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "研究";
  return `${shanghaiDate(now)}-${slug}.md`;
}

async function complete(prompt: string, system: string, builtin?: string[]): Promise<string> {
  let out = "";
  for await (const ev of askStream(prompt, { systemPrompt: system, cwd: config.dataDir, model: LEARN_MODEL, ...(builtin ? { builtin } : {}) })) {
    if (ev.type === "delta") out += ev.text;
    if (ev.type === "reset") out = "";
    if (ev.type === "error") throw new Error(ev.message);
  }
  return out;
}

/** 自学一题：挑题 → 上网研究 → 笔记写进记忆库 research/ → 建一条 learn 任务放待办让用户看。 */
export async function learnOnce(manual = false): Promise<LearnResult> {
  if (learnState.running) return { skipped: "正在学，稍等" };
  if (!manual && !userSettings().learn) return { skipped: "自学已在设置里关掉" };
  learnState.running = true;
  try {
    const m = await gatherMaterial();
    if (!hasMaterial(m)) return { skipped: "最近 7 天没有任务、提交或 Slack 素材，不硬凑" };
    const pickText = await complete(pickPrompt(m).prompt, pickPrompt(m).system);
    const pick = parsePick(pickText);
    if (!pick) throw new Error("选题没有返回可解析的结果");
    if ("skip" in pick) return { skipped: `没挑到值得研究的题：${pick.skip}` };
    const rp = researchPrompt(pick, m);
    const research = parseResearch(await complete(rp.prompt, rp.system, ["WebSearch", "WebFetch"]), pick.topic);
    if (!research) throw new Error("研究结果没有按固定结构输出");
    const task = saveResearch(research, pick);
    learnState.lastRunAt = new Date().toISOString();
    learnState.lastError = null;
    return { taskId: task.id, title: task.title, file: task.source.researchFile! };
  } catch (e) {
    learnState.lastError = e instanceof Error ? e.message : String(e);
    console.error(`[learn] ${learnState.lastError}`);
    return { skipped: `出错：${learnState.lastError}` };
  } finally {
    learnState.running = false;
  }
}

export function saveResearch(research: Research, pick: Pick, now = new Date()): Task {
  const dir = join(config.dataDir, RESEARCH_DIR);
  mkdirSync(dir, { recursive: true });
  const name = researchFileName(research.title, now);
  const file = `${RESEARCH_DIR}/${name}`;
  writeFileSync(join(dir, name), `${research.markdown}\n\n---\nFriday 自学于 ${now.toISOString().slice(0, 10)}${pick.project ? `，针对项目 ${pick.project}` : ""}。\n`);
  const project = pick.project && loadProjects().some((p) => p.name === pick.project) ? pick.project : undefined;
  const task = createTask({
    title: research.title,
    kind: "learn",
    source: { researchFile: file },
    ...(project ? { project } : {}),
    priority: "low",
    status: "understood",
    understanding: clip(research.why || pick.why, 600),
    plan: clip(research.suggestions, 2000),
  });
  record({ taskId: task.id, action: "learned", why: pick.why || "每天自学一题", how: `研究「${research.title}」，笔记写到 ${file}，建议挂成待办等你看`, evidence: { file, project: project ?? null }, risk: "reversible" });
  state.notices.push({ title: `Friday 学了一题${project ? ` · ${project}` : ""}`, body: research.title });
  return task;
}
