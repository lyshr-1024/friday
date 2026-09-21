import { askStream } from "./claude.js";
import { untrusted, UNTRUSTED_NOTE } from "./fence.js";
import { groupByProject, scanHistory, type HistoryMessage } from "./history.js";
import { config } from "../config.js";
import { record } from "../memory/audit.js";
import { readMemoryFile, upsertPerson, writeMemoryFile } from "../memory/files.js";
import { addProjectHints } from "../memory/projectHints.js";
import { GLOBAL, handbookSlug, listHandbooks, readHandbook, writeHandbook } from "../memory/handbooks.js";
import { getCursor, setCursor } from "../memory/inbox.js";
import { addPending, createTask } from "../memory/tasks.js";
import { userSettings } from "../settings.js";

export const HANDBOOK_MODEL = "claude-sonnet-5";
export const CURSOR_KEY = "history:at";
export const RAN_KEY = "history:ran";
/** 每周学一轮就够：一周攒不满几十条新约定，天天跑只会天天弹一条没内容的待审。 */
export const HISTORY_EVERY_DAYS = 7;
/** 一组最多送多少条原话去提炼。超了取最新的——旧约定多半已经沉淀进手册了。 */
export const MAX_PER_GROUP = 120;
const CLIP = 400;
/** 攒够这么多条才值得跑一轮，否则一周学两条规则还不如不弹。 */
export const MIN_CANDIDATES = 8;

/**
 * 该学了没。跟 reviewDue 一个思路：不看「是不是周一这一刻」，只看离上次跑过了多久，
 * 机器关着也不会整周漏掉。上次时间存在 sync_state 里，重启不会丢。
 */
export function historyDue(lastRanIso: string | undefined, now = Date.now()): boolean {
  if (!lastRanIso) return true;
  const last = Date.parse(lastRanIso);
  return Number.isNaN(last) || now - last >= HISTORY_EVERY_DAYS * 86_400_000;
}

export const historyState = {
  lastRunAt: null as string | null,
  lastError: null as string | null,
  running: false,
  cursorAt: null as string | null,
};

export interface HandbookDecision {
  text: string;
  why?: string;
  at?: string;
}

export interface HandbookPerson {
  name: string;
  note: string;
}

export interface GroupDraft {
  project: string;
  handbook: string;
  decisions: HandbookDecision[];
  people: HandbookPerson[];
  aliases: string[];
  sources: number;
}

export interface HandbookDraft {
  groups: GroupDraft[];
}

const clip = (s: string, n = CLIP) => (s.length > n ? `${s.slice(0, n)}…` : s);
const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** 模型可能多给一层 ```json 包装，也可能在前后说两句。 */
export function parseDraft(raw: string): Omit<GroupDraft, "project" | "sources"> | undefined {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const handbook = str(obj.handbook, 12_000);
  if (!handbook) return undefined;
  const decisions = Array.isArray(obj.decisions)
    ? obj.decisions
        .map((d) => {
          const o = (d ?? {}) as Record<string, unknown>;
          const text = str(o.text, 200);
          const why = str(o.why, 300);
          const at = /^\d{4}-\d{2}-\d{2}$/.test(String(o.at ?? "")) ? String(o.at) : "";
          return text ? { text, ...(why ? { why } : {}), ...(at ? { at } : {}) } : undefined;
        })
        .filter((d): d is HandbookDecision => Boolean(d))
        .slice(0, 20)
    : [];
  const people = Array.isArray(obj.people)
    ? obj.people
        .map((p) => {
          const o = (p ?? {}) as Record<string, unknown>;
          const name = str(o.name, 40);
          const note = str(o.note, 200);
          return name && note ? { name, note } : undefined;
        })
        .filter((p): p is HandbookPerson => Boolean(p))
        .slice(0, 20)
    : [];
  const aliases = Array.isArray(obj.aliases)
    ? obj.aliases.map((a) => str(a, 40)).filter((a) => a.length >= 2).slice(0, 10)
    : [];
  return { handbook, decisions, people, aliases };
}

export function distillPrompt(project: string, messages: HistoryMessage[], current: string): { system: string; prompt: string } {
  const global = project === GLOBAL;
  const system = [
    global
      ? "你在给一个私人助理写「这位用户干活时的通用习惯」手册——跨项目都成立的那些：提交流程、分支规范、验证要求、沟通口径。"
      : `你在给一个私人助理写项目 ${project} 的「在这个项目里怎么干活」手册。`,
    "输入是用户过去几周在 Claude Code 里说过的原话，大多是在纠正助理、或者定下某个口径。",
    "只提炼可复用的约定，一次性的具体活儿（“把这个按钮改成蓝色”“修一下这个报错”）一律丢掉。拿不准就不要——学错一条比少学一条贵得多。",
    "每条规则后面必须跟一行以 > 开头的原话摘录作为出处，摘录要能支撑这条规则；找不到出处就说明这条是你编的，删掉。",
    current ? "已有手册在下面，请把新证据并进去重写整份，不要追加流水账：说的是同一件事就合并，新的口径推翻了旧的就替换掉旧的。" : "还没有手册。",
    "只输出一个 JSON 对象，不要包在代码块里，字段如下：",
    '{"handbook": "整份手册的 Markdown", "decisions": [{"text": "一句话结论", "why": "理由", "at": "YYYY-MM-DD"}], "people": [{"name": "人名", "note": "一句话"}], "aliases": ["项目别名"]}',
    "handbook 用二级标题分组（## 约定 / ## 技术口径 / ## 流程 / ## 别踩的坑），每条一行不超过 40 字，后跟一行 > 原话。",
    "decisions 只放影响面超出单个文件的一次性技术决策；people 只放明确提到的协作对象；aliases 只放用户称呼这个项目用的别名。三者都可以是空数组，宁缺毋滥。",
    global ? "aliases 恒为空数组。" : "",
    UNTRUSTED_NOTE,
  ]
    .filter(Boolean)
    .join("\n");
  const body = [
    current ? `现有手册：\n${current}` : "",
    "用户原话：",
    untrusted(
      "claude-code-history",
      messages.map((m) => `[${m.at.slice(0, 10)}] ${clip(m.text)}`).join("\n"),
    ),
  ]
    .filter(Boolean)
    .join("\n\n");
  return { system, prompt: body };
}

async function distillGroup(project: string, messages: HistoryMessage[]): Promise<GroupDraft | undefined> {
  const picked = messages.slice(-MAX_PER_GROUP);
  const current = project === GLOBAL ? readHandbook(GLOBAL) : readHandbook(project);
  const { system, prompt } = distillPrompt(project, picked, current);
  let text = "";
  for await (const ev of askStream(prompt, { systemPrompt: system, cwd: config.dataDir, model: HANDBOOK_MODEL, builtin: [], label: "handbook" })) {
    if (ev.type === "delta") text += ev.text;
    if (ev.type === "reset") text = "";
  }
  const parsed = parseDraft(text);
  if (!parsed) return undefined;
  return { project, ...parsed, ...(project === GLOBAL ? { aliases: [] } : {}), sources: picked.length };
}

export function draftSummary(draft: HandbookDraft): string {
  return draft.groups
    .map((g) => {
      const head = g.project === GLOBAL ? "## 通用习惯" : `## ${g.project}`;
      const extra = [
        g.decisions.length ? `决策 ${g.decisions.length} 条：${g.decisions.map((d) => d.text).join("；")}` : "",
        g.people.length ? `人物 ${g.people.length} 条：${g.people.map((p) => p.name).join("、")}` : "",
        g.aliases.length ? `别名：${g.aliases.join("、")}` : "",
      ].filter(Boolean);
      return [`${head}（依据 ${g.sources} 条原话）`, g.handbook, ...extra].join("\n\n");
    })
    .join("\n\n---\n\n");
}

export type HistoryResult = { skipped: string } | { taskId: string; groups: number; candidates: number };

/**
 * 扫一遍 Claude Code 历史，把用户说过的约定提炼成项目手册。
 * 结果不直接写记忆库——挂成一条待审任务，用户过一眼点「通过并执行」才落盘。
 */
export async function learnHistoryOnce(manual = false): Promise<HistoryResult> {
  if (historyState.running) return { skipped: "上一轮还在跑" };
  if (!manual && !userSettings().learnHistory) return { skipped: "从 Claude Code 学已在设置里关掉" };
  historyState.running = true;
  historyState.lastError = null;
  try {
    const since = getCursor(CURSOR_KEY);
    const messages = scanHistory(since);
    historyState.cursorAt = since ?? null;
    if (messages.length < (manual ? 1 : MIN_CANDIDATES)) {
      setCursor(RAN_KEY, new Date().toISOString());
      return { skipped: since ? `自上次学过之后只攒了 ${messages.length} 条新的，不够提炼一轮` : "没在 Claude Code 历史里找到可学的原话" };
    }
    const groups = groupByProject(messages);
    const drafts: GroupDraft[] = [];
    for (const [project, list] of groups) {
      // 一个项目只说过一两句的，多半是路过，不值得单开一份手册
      if (list.length < 3) continue;
      const d = await distillGroup(project, list);
      if (d) drafts.push(d);
    }
    if (!drafts.length) return { skipped: "这批原话里没提炼出可复用的约定" };

    const latest = messages.reduce((max, m) => (m.at > max ? m.at : max), since ?? "");
    const total = drafts.reduce((n, g) => n + g.sources, 0);
    const names = drafts.map((g) => (g.project === GLOBAL ? "通用" : g.project)).join("、");
    const task = createTask({
      title: `从 Claude Code 历史提炼了 ${drafts.length} 份手册`,
      kind: "handbook",
      source: { historyCursor: latest },
      status: "review",
      priority: "low",
      understanding: `扫了 ${since ? "上次学过之后" : "近 30 天"}的 Claude Code 会话，从 ${total} 条你说过的原话里提炼出 ${names} 的干活约定。每条都带原话出处，可以直接核对。`,
      plan: draftSummary({ groups: drafts }),
    });
    addPending(task.id, {
      type: "handbook_apply",
      label: "写进记忆库",
      detail: `把 ${names} 的手册写进记忆库 handbooks/，附带的决策、人物、别名一并落盘。可在操作记录里整体撤销。`,
      payload: { draft: { groups: drafts } as unknown as Record<string, unknown>, cursor: latest },
    });
    setCursor(CURSOR_KEY, latest);
    historyState.lastRunAt = new Date().toISOString();
    setCursor(RAN_KEY, historyState.lastRunAt);
    historyState.cursorAt = latest;
    record({
      taskId: task.id,
      action: "history_distilled",
      why: manual ? "你让 Friday 现在学一轮" : "每周从 Claude Code 历史学一轮",
      how: `${total} 条原话提炼成 ${drafts.length} 份手册，等你审核`,
      evidence: { groups: drafts.map((g) => g.project), candidates: total },
      risk: "read",
    });
    return { taskId: task.id, groups: drafts.length, candidates: total };
  } catch (e) {
    historyState.lastError = e instanceof Error ? e.message : String(e);
    return { skipped: `出错了：${historyState.lastError}` };
  } finally {
    historyState.running = false;
  }
}

export interface MemorySnapshot {
  handbooks: Record<string, string>;
  decisions: string;
  people: string;
  projects: string;
}

/** 用户点「通过并执行」之后才真正写记忆库。返回撤销用的快照。 */
export function applyHandbookDraft(draft: HandbookDraft): { snapshot: MemorySnapshot; wrote: string[] } {
  const snapshot: MemorySnapshot = {
    handbooks: Object.fromEntries(listHandbooks().map((slug) => [slug, readHandbook(slug)])),
    decisions: readMemoryFile("decisions"),
    people: readMemoryFile("people"),
    projects: readMemoryFile("projects"),
  };
  const wrote: string[] = [];
  const stamp = new Date().toISOString().slice(0, 10);

  for (const g of draft.groups) {
    snapshot.handbooks[handbookSlug(g.project)] ??= "";
    const title = g.project === GLOBAL ? "通用习惯" : g.project;
    writeHandbook(g.project, `# ${title}\n\n<!-- Friday 从 Claude Code 历史提炼，可以直接手改 -->\n\n${g.handbook.trim()}\n`);
    wrote.push(`handbooks/${handbookSlug(g.project)}.md`);

    if (g.decisions.length) {
      const cur = readMemoryFile("decisions");
      const add = g.decisions
        .filter((d) => !cur.includes(d.text))
        .map((d) => `## ${d.at ?? stamp} ${d.text}\n${d.why ?? ""}`.trimEnd())
        .join("\n\n");
      if (add) {
        writeMemoryFile("decisions", `${cur.trimEnd()}\n\n${add}\n`);
        wrote.push(`decisions.md +${g.decisions.length}`);
      }
    }
    for (const p of g.people) {
      if (!readMemoryFile("people").includes(p.note)) upsertPerson(p.name, p.note);
    }
    if (g.people.length) wrote.push(`people.md +${g.people.length}`);
    if (g.aliases.length && g.project !== GLOBAL) {
      const r = addProjectHints(g.project, { aliases: g.aliases });
      if (r.changed) wrote.push(`projects.md 别名 +${r.added.aliases.length}`);
    }
  }
  return { snapshot, wrote };
}

/** 整体还原到 apply 之前。手册是覆盖写的，逐条撤销没意义，直接按快照恢复。 */
export function restoreMemorySnapshot(s: MemorySnapshot): boolean {
  for (const [slug, content] of Object.entries(s.handbooks)) writeHandbook(slug, content);
  writeMemoryFile("decisions", s.decisions);
  writeMemoryFile("people", s.people);
  writeMemoryFile("projects", s.projects);
  return true;
}
